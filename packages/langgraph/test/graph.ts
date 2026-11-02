/** A real LangGraph graph with a scripted model, for tests: the tools run for real and are counted. */
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { END, MemorySaver, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import type { ToolNode } from '@langchain/langgraph/prebuilt';
import { createAgent } from 'langchain';
import type { AgentMiddleware } from 'langchain';
import { z } from 'zod';

export interface Counters {
  readonly runs: { name: string; args: unknown; probe?: unknown }[];
}

/** The tools of the scenarios: each is counted when it really runs. */
export function makeTools(
  counters: Counters,
  behaviour: {
    failSend?: boolean;
    failCreate?: boolean;
    probe?: () => unknown;
    /** `search` waits this long, logging when it starts and ends into `log`. */
    searchDelayMs?: number;
    log?: string[];
  } = {}
) {
  const note = (name: string, args: unknown): void => {
    counters.runs.push({
      name,
      args,
      ...(behaviour.probe === undefined ? {} : { probe: behaviour.probe() }),
    });
  };
  const search = tool(
    async (args: { q: string }) => {
      note('search', args);
      behaviour.log?.push(`start ${args.q}`);
      if (behaviour.searchDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, behaviour.searchDelayMs));
      }
      behaviour.log?.push(`end ${args.q}`);
      return `found ${args.q}`;
    },
    { name: 'search', description: 'Search issues.', schema: z.object({ q: z.string() }) }
  );
  const sendEmail = tool(
    (args: { to: string; note: string }) => {
      note('send_email', args);
      if (behaviour.failSend === true) throw new Error('smtp down');
      return `sent to ${args.to}`;
    },
    {
      name: 'send_email',
      description: 'Send an email.',
      // `note` has a default: the digest is over the arguments as the model sent them, before it.
      schema: z.object({ to: z.string(), note: z.string().default('hello') }),
    }
  );
  const deleteAccount = tool(
    (args: { id: string }) => {
      note('delete_account', args);
      return 'deleted';
    },
    {
      name: 'delete_account',
      description: 'Delete an account.',
      schema: z.object({ id: z.string() }),
    }
  );
  const createIssue = tool(
    (args: { title: string }) => {
      note('create_issue', args);
      if (behaviour.failCreate === true) throw new Error('tracker down');
      return `created ${args.title}`;
    },
    {
      name: 'create_issue',
      description: 'Create an issue.',
      schema: z.object({ title: z.string() }),
    }
  );
  const sendSms = tool(
    (args: { to: string }) => {
      note('send_sms', args);
      return `texted ${args.to}`;
    },
    { name: 'send_sms', description: 'Send a text.', schema: z.object({ to: z.string() }) }
  );
  return { search, sendEmail, deleteAccount, createIssue, sendSms };
}

export const TOOL_REFS = {
  search: 'mcp:tracker:search',
  send_email: 'ext:local:send_email',
  delete_account: 'mcp:crm:delete_account',
  create_issue: 'mcp:tracker:create_issue',
  /** A second tool the caller executes (registered by the harness): a call that pauses on its own approval. */
  send_sms: 'ext:local:send_sms',
} as const;

export const call = (id: string, name: string, args: Record<string, unknown>) => ({
  id,
  name,
  args,
  type: 'tool_call' as const,
});

/** An AI message that asks for tool calls. */
export const ask = (...calls: ReturnType<typeof call>[]): AIMessage =>
  new AIMessage({ content: '', tool_calls: calls });

/**
 * Builds the graph: a scripted model node (the n-th model turn is `script[n]`, then "done") and the
 * given tool node. The model reads the thread, not a counter, so a re-run or a second process agrees.
 */
export function buildGraph(options: {
  script: readonly AIMessage[];
  toolNode: ToolNode | { invoke: StructuredToolInterface['invoke'] };
  checkpointer?: BaseCheckpointSaver;
}) {
  const graph = new StateGraph(MessagesAnnotation)
    .addNode('agent', (state) => {
      const turns = state.messages.filter((m: BaseMessage) => AIMessage.isInstance(m)).length;
      return { messages: [options.script[turns] ?? new AIMessage('done')] };
    })
    .addNode('tools', options.toolNode as ToolNode)
    .addEdge(START, 'agent')
    .addConditionalEdges(
      'agent',
      (state) => {
        const last = state.messages.at(-1);
        return last !== undefined &&
          AIMessage.isInstance(last) &&
          (last.tool_calls?.length ?? 0) > 0
          ? 'tools'
          : END;
      },
      ['tools', END]
    )
    .addEdge('tools', 'agent')
    .compile({ checkpointer: options.checkpointer ?? new MemorySaver() });
  return graph;
}

export const start = (text = 'go') => ({ messages: [new HumanMessage(text)] });

/** The text of a message's content. */
export const textOf = (message: { content: unknown } | undefined): string =>
  typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content);

/**
 * A chat model that plays `script`: the n-th model turn is `script[n]`, then "done". Like `buildGraph`'s
 * model node it reads the thread (the AI messages so far), not a counter, so a re-run or a second process
 * agrees.
 */
class ScriptedModel extends BaseChatModel {
  readonly #script: readonly AIMessage[];

  constructor(script: readonly AIMessage[]) {
    super({});
    this.#script = script;
  }

  _llmType(): string {
    return 'scripted';
  }

  override bindTools(): this {
    return this;
  }

  _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const turns = messages.filter((m) => AIMessage.isInstance(m)).length;
    const message = this.#script[turns] ?? new AIMessage('done');
    return Promise.resolve({
      generations: [{ text: typeof message.content === 'string' ? message.content : '', message }],
    });
  }
}

/** A `createAgent` agent over the scripted model: the middleware path of the same scenarios. */
export function buildAgent(options: {
  script: readonly AIMessage[];
  tools: readonly StructuredToolInterface[];
  middleware: readonly AgentMiddleware[];
  version?: 'v1' | 'v2';
  checkpointer?: BaseCheckpointSaver;
}) {
  return createAgent({
    model: new ScriptedModel(options.script),
    tools: [...options.tools],
    middleware: [...options.middleware],
    ...(options.version === undefined ? {} : { version: options.version }),
    checkpointer: options.checkpointer ?? new MemorySaver(),
  });
}
