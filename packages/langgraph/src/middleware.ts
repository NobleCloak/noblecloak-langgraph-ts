/**
 * `governanceMiddleware(governance, { toolRefs })`: approvals for a `createAgent` agent in one line.
 *
 * It is a `wrapToolCall` hook and nothing else. Every tool call the agent makes is handed to `governCall`,
 * the same function `governed` and `governedToolNode` end in, with the agent's own handler as the thing
 * that runs the tool once governance has let it through. There is no decision, interrupt or consume path
 * here.
 *
 * `createAgent`'s default tool behaviour is `v2`: each tool call of a model message is its own task, so each
 * gated call pauses on its own approval. With `version: 'v1'` the calls of a message share one task and
 * sibling gated calls coordinate the way a `ToolNode` does. `interrupt()` works inside the hook, and the hook
 * re-runs from the top on resume like any node does.
 */
import { ToolMessage } from '@langchain/core/messages';
import { ToolInputParsingException } from '@langchain/core/tools';
import type { ToolCall } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { interopSafeParseAsync, isInteropZodSchema } from '@langchain/core/utils/types';
import { isGraphInterrupt } from '@langchain/langgraph';
import { createMiddleware, ToolInvocationError } from 'langchain';

import { GovernanceError } from './errors.js';
import { EXTERNAL_RUN_ID_KEY } from './gateway.js';
import { governCall, readContext } from './governed.js';
import type { Env, ObservedOutcome, ToolConfig } from './governed.js';
import type { Governance } from './governance.js';

export interface GovernanceMiddlewareOptions {
  /**
   * The catalog name of each tool, keyed by the tool's LangChain name. A tool the agent carries that this
   * map does not name fails the run at the first model call, before the model is called, whatever
   * `handleToolErrors` says (a configuration error; the tool is never run ungoverned). A call to a tool the
   * agent does not have is answered with the "not a valid tool" message `createAgent` itself uses, and
   * nothing runs, whatever a later `wrapToolCall` middleware would supply for it.
   */
  readonly toolRefs: Readonly<Record<string, string>>;
  /**
   * The `ToolNode` option of the same name; default `true`: an error the tool throws, and arguments its
   * schema rejects (checked before any decision), become an error message for the model, as
   * `governedToolNode` does. `false` lets that error fail the run. A `GovernanceError` is never turned into a
   * message, whatever this says.
   */
  readonly handleToolErrors?: boolean;
  /**
   * Tools (by LangChain name, each also a key of `toolRefs`) the deployment executes through the governed
   * gateway: the same declaration as `governed`'s `executedBy: 'gateway'`. The adapter pauses for the
   * approval and runs the function once, with the run named in its `config` for `gatewayCallContext`;
   * the function makes the gateway call. A name that is not in `toolRefs` throws at construction.
   */
  readonly gatewayTools?: readonly string[];
}

/** The message `createAgent` answers a call to a tool it does not have with. */
function invalidToolMessage(
  toolCall: { readonly name: string; readonly id?: string },
  available: readonly string[]
): ToolMessage {
  return new ToolMessage({
    content: `Error: ${toolCall.name} is not a valid tool, try one of [${available.join(', ')}].`,
    tool_call_id: toolCall.id ?? '',
    name: toolCall.name,
    status: 'error',
  });
}

/**
 * The error `ToolNode` raises for arguments that do not match the tool's schema, or `undefined` when they
 * do. Validation only: governance digests the arguments as the model sent them, not the parsed ones. A
 * tool with a JSON Schema (not a Zod schema) is validated by the tool itself once governance lets it run.
 */
async function schemaError(
  tool: StructuredToolInterface,
  toolCall: ToolCall
): Promise<ToolInvocationError | undefined> {
  if (!isInteropZodSchema(tool.schema)) return undefined;
  const parsed = await interopSafeParseAsync(tool.schema, toolCall.args);
  if (parsed.success) return undefined;
  const detail =
    parsed.error instanceof Error
      ? `

${parsed.error.message}`
      : '';
  return new ToolInvocationError(
    new ToolInputParsingException(
      `Received tool input did not match expected schema${detail}`,
      JSON.stringify(toolCall)
    ),
    toolCall
  );
}

/**
 * The tool as the rest of the middleware chain sees it for one governed call: `invoke` runs the tool at most
 * once. The decision, the approval and the record belong to one execution, so a second invocation (a retry
 * middleware placed after governance) throws without running the tool. `observed()` is what that one real
 * invocation did, which is what the outcome record is written from.
 */
function singleUse(inner: StructuredToolInterface): {
  readonly tool: StructuredToolInterface;
  readonly observed: () => ObservedOutcome;
  /** The external run the one real invocation names to the gateway (a declared gateway tool only). */
  readonly setRunId: (runId: string | undefined) => void;
} {
  let runId: string | undefined;
  let outcome: ObservedOutcome = { ran: false };
  let invoked = false;
  const tool = new Proxy(inner, {
    get(target, property) {
      if (property !== 'invoke') return Reflect.get(target, property, target) as unknown;
      return async (...args: Parameters<StructuredToolInterface['invoke']>) => {
        if (invoked) {
          throw new GovernanceError(
            'tool_reinvoked',
            `The tool ${target.name} already ran for this call and the approval was spent; a retry needs a new call.`
          );
        }
        invoked = true;
        try {
          const input: unknown = args[0];
          const invokeConfig: ToolConfig | undefined = args[1];
          const result: unknown = await target.invoke(
            input as never,
            runId === undefined
              ? invokeConfig
              : {
                  ...invokeConfig,
                  configurable: { ...invokeConfig?.configurable, [EXTERNAL_RUN_ID_KEY]: runId },
                }
          );
          outcome = { ran: true, result };
          return result;
        } catch (error) {
          outcome = { ran: true, error };
          throw error;
        }
      };
    },
  });
  return {
    tool,
    observed: () => outcome,
    setRunId: (id) => {
      runId = id;
    },
  };
}

const missingToolRef = (name: string): Error =>
  new Error(
    `governanceMiddleware: no toolRef for the tool ${name}; add it to toolRefs or remove it from the agent`
  );

/** `createAgent` middleware that routes every tool call through governance. */
export function governanceMiddleware(governance: Governance, options: GovernanceMiddlewareOptions) {
  for (const [name, toolRef] of Object.entries(options.toolRefs)) {
    governance.registerTool(name, toolRef);
  }
  const handleToolErrors = options.handleToolErrors ?? true;
  const gatewayTools = new Set(options.gatewayTools ?? []);
  for (const name of gatewayTools) {
    if (options.toolRefs[name] === undefined) {
      throw new Error(`governanceMiddleware: gatewayTools names ${name}, which is not in toolRefs`);
    }
  }
  let toolsChecked = false;
  // The names the agent carries, for the "not a valid tool" message (the map's names until the first model call).
  let carried: readonly string[] = Object.keys(options.toolRefs);
  return createMiddleware({
    name: 'noblecloak-governance',
    // The first model call sees the agent's tools: a tool with no toolRef fails the run before the model is
    // called, not at the first call to that tool. `wrapToolCall` keeps the same check per call, for tools
    // that only a later middleware adds. (Declaring this hook gives the agent a `structuredResponse` state
    // channel, as any `wrapModelCall` middleware does.)
    wrapModelCall: (request, handler) => {
      if (!toolsChecked) {
        for (const candidate of request.tools) {
          const name = (candidate as { name?: unknown }).name;
          if (typeof name === 'string' && options.toolRefs[name] === undefined) {
            throw missingToolRef(name);
          }
        }
        carried = request.tools.flatMap((candidate) => {
          const name = (candidate as { name?: unknown }).name;
          return typeof name === 'string' ? [name] : [];
        });
        toolsChecked = true;
      }
      return handler(request);
    },
    wrapToolCall: async (request, handler) => {
      const { toolCall } = request;
      const toolRef = options.toolRefs[toolCall.name];
      // A call governance cannot decide on is never handed to `handler`: a later `wrapToolCall` middleware
      // can supply a `tool` for any name, and `handler` would run it with no decision and no record.
      if (request.tool === undefined) return invalidToolMessage(toolCall, carried);
      if (toolRef === undefined) {
        throw missingToolRef(toolCall.name);
      }
      // Arguments the tool's schema rejects are not decided on: nothing is asked, approved or recorded for them.
      const invalid = await schemaError(request.tool as StructuredToolInterface, toolCall);
      if (invalid !== undefined) {
        if (!handleToolErrors) throw invalid;
        return new ToolMessage({
          name: toolCall.name,
          content: invalid.message,
          tool_call_id: toolCall.id ?? '',
          status: 'error',
        });
      }
      // Downstream middleware (a retry, say) can call the handler more than once; the approval is spent once.
      const {
        tool: single,
        observed,
        setRunId,
      } = singleUse(request.tool as StructuredToolInterface);
      const env: Env = {
        governance,
        toolRef,
        observedOutcome: observed,
        gateway: gatewayTools.has(toolCall.name),
        handler: async (args, invokeConfig) => {
          const runId: unknown = invokeConfig.configurable?.[EXTERNAL_RUN_ID_KEY];
          setRunId(typeof runId === 'string' ? runId : undefined);
          return handler({
            ...request,
            tool: single,
            toolCall: { ...toolCall, args },
          });
        },
      };
      const config: ToolConfig = {
        configurable: request.runtime.configurable ?? {},
        ...(request.runtime.signal === undefined ? {} : { signal: request.runtime.signal }),
        toolCall,
        ...(toolCall.id === undefined ? {} : { toolCallId: toolCall.id }),
        state: request.state,
      };
      try {
        const context = readContext(toolCall.name, toolCall.args, config);
        return (await governCall(env, context, config)) as Awaited<ReturnType<typeof handler>>;
      } catch (error) {
        // `handleToolErrors` governs what the tool throws. A governance failure (a record that cannot be
        // written under `onRecordFailure: 'throw'`, a setup error) fails the run: it is never turned into a
        // message that invites the model to retry. The one exception is `tool_reinvoked`, which is a tool
        // invocation (by a middleware after governance) that governance refused.
        const governanceFailure =
          error instanceof GovernanceError && error.code !== 'tool_reinvoked';
        if (
          !handleToolErrors ||
          governanceFailure ||
          isGraphInterrupt(error) ||
          request.runtime.signal?.aborted
        ) {
          throw error;
        }
        return new ToolMessage({
          name: toolCall.name,
          content: `${String(error)}\n Please fix your mistakes.`,
          tool_call_id: toolCall.id ?? '',
          status: 'error',
        });
      }
    },
  });
}
