/**
 * `governed(tool)`: the one place that decides, pauses, consumes, runs and records.
 *
 * LangGraph re-runs an interrupted node from the top when it resumes, so every step before `interrupt()`
 * runs again; nothing here caches across the two runs. The re-run's second `/decisions` call matches the
 * open obligation of an approved answer. A rejection or an unanswered close is found out first, from the
 * server, and never decided again, so it opens no second approval.
 *
 * The resume value names the answered approval and nothing else. Everything that lets the tool run is
 * read and checked here, where the tool is about to run: the server's state of the approval, its signed
 * Resumption, the correlation, the replay guard, then `/consume`.
 */
import { argDigest } from '@noblecloak/client';
import type { JsonValue, ResumptionPayload } from '@noblecloak/client';
import { AIMessage } from '@langchain/core/messages';
import type { ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { interrupt, isGraphInterrupt } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { ResumptionError } from '@noblecloak/client';

import { denialMessage, NOT_RUN, rejectedText, unrecordedText } from './denial.js';
import type {
  Approval,
  ContinuationBody,
  Decision,
  DecisionRequest,
  RecordCreate,
  Resumption,
} from './api.js';
import { GovernanceError, messageOf } from './errors.js';
import { configurableFor } from './gateway.js';
import type { DenialCode } from './errors.js';
import type { TaskSlot } from './coordination.js';
import { coordinationOf } from './governance.js';
import type { Governance } from './governance.js';
import { isForgettable } from './replay.js';
import { correlationOf as signedCorrelation, RESUMPTION_ERROR_CODES } from './resumption.js';
import type { Correlation, GovernedInterrupt, ResumeValue } from './types.js';

export interface GovernedOptions {
  /** The builder's stable name for the tool in the NobleCloak catalog. Never derived from the LangChain name. */
  readonly toolRef: string;
  readonly governance: Governance;
  /**
   * Who executes the tool. `'local'` (the default): this process runs the wrapped function, and a decision
   * that says the deployment executes the tool is refused (`not_locally_executable`). `'gateway'`: the
   * deployment executes the tool through the governed MCP gateway, and the wrapped function **is** the
   * gateway call (the builder's MCP client). The call needs an external run (`run_required` without one);
   * it pauses for approval like any other, and after the approver acts the re-issued call is admitted by
   * the gateway, which records it. See `gatewayCallContext` for naming the run to the gateway.
   */
  readonly executedBy?: 'local' | 'gateway';
}

export interface GovernedToolNodeOptions {
  /** The catalog name of each tool, keyed by the tool's LangChain name. */
  readonly toolRefs: Readonly<Record<string, string>>;
  readonly governance: Governance;
  /**
   * The LangChain names of the tools the deployment executes through the governed MCP gateway (see
   * `GovernedOptions.executedBy`). The mode is per tool; a name that is not among the node's tools throws.
   */
  readonly gatewayTools?: readonly string[];
  /**
   * The `ToolNode` option of the same name; default `true`, which turns an error a tool throws into an
   * error message for the model. It matters to a governed call only under `onRecordFailure: 'throw'`: the
   * call then throws `record_failed` when its outcome record cannot be written, which fails the run with
   * `false` and is written into the thread as an error message with the default. Under the default
   * `onRecordFailure: 'tell-model'` the call returns a fixed message instead of throwing, so this option
   * changes nothing for it.
   */
  readonly handleToolErrors?: boolean;
}

export interface CallContext {
  readonly toolName: string;
  readonly threadId: string | undefined;
  readonly checkpointNs: string;
  readonly toolCallId: string | undefined;
  /** The arguments as the model sent them, before the schema's defaults: what is digested. */
  readonly args: Record<string, unknown>;
  /** The call's position in the model's message, when the graph state is visible. */
  readonly position: number | undefined;
}

export type ToolConfig = Parameters<StructuredToolInterface['invoke']>[1] & {
  readonly toolCall?: { readonly id?: string; readonly args?: unknown };
  readonly toolCallId?: string;
  readonly state?: unknown;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function positionIn(state: unknown, toolCallId: string): number | undefined {
  if (!isRecord(state) || !Array.isArray(state.messages)) return undefined;
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const message: unknown = state.messages[i];
    if (AIMessage.isInstance(message)) {
      const index = (message as { tool_calls?: { id?: string }[] }).tool_calls?.findIndex(
        (call) => call.id === toolCallId
      );
      return index === undefined || index < 0 ? undefined : index;
    }
  }
  return undefined;
}

/** @internal shared by the three entry points (`governed`, `governedToolNode`, `governanceMiddleware`). */
export function readContext(name: string, input: unknown, config: ToolConfig): CallContext {
  const configurable = (config.configurable ?? {}) as Record<string, unknown>;
  const threadId = typeof configurable.thread_id === 'string' ? configurable.thread_id : undefined;
  const ns = typeof configurable.checkpoint_ns === 'string' ? configurable.checkpoint_ns : '';
  const toolCallId = config.toolCall?.id ?? config.toolCallId;
  const args = isRecord(config.toolCall?.args)
    ? config.toolCall.args
    : isRecord(input)
      ? input
      : {};
  return {
    toolName: name,
    threadId,
    checkpointNs: ns,
    toolCallId: toolCallId === '' ? undefined : toolCallId,
    args,
    position:
      toolCallId === undefined || toolCallId === ''
        ? undefined
        : positionIn(config.state, toolCallId),
  };
}

function denial(context: CallContext, code: DenialCode, text: string): ToolMessage {
  return denialMessage(context.toolName, context.toolCallId ?? '', code, text);
}

function correlationOf(context: CallContext, threadId: string, toolCallId: string): Correlation {
  // A fixed key order, so the same correlation is sent on the re-run.
  return { thread_id: threadId, checkpoint_ns: context.checkpointNs, tool_call_id: toolCallId };
}

const isResumeValue = (value: unknown): value is ResumeValue =>
  isRecord(value) && value.kind === 'answered' && typeof value.approval_id === 'string';

function localAnswer(value: unknown): { approved: boolean; reason?: string } | undefined {
  if (typeof value === 'boolean') return { approved: value };
  if (isRecord(value) && typeof value.approved === 'boolean') {
    return {
      approved: value.approved,
      ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    };
  }
  return undefined;
}

/**
 * The value LangGraph would hand `interrupt()` for this task, if one is waiting: read from the node's
 * scratchpad without consuming it. This is LangGraph's internal (`__pregel_scratchpad`), so it fails
 * closed: a shape it does not recognise reads as "no resume" and the call takes the ordinary path, whose
 * only cost is a stray approval that is withdrawn (see `afterResume`), never a wrong answer. The value is
 * only a hint of which approval to look at: what it names is confirmed with the server before anything is
 * skipped. `peekResume` is still needed with an id-only resume value: without it a rejected, expired or
 * withdrawn answer would be decided again, opening an approval nothing wants. The shape is pinned by a
 * test against the installed LangGraph, which fails loudly when an upgrade moves it.
 * @internal exported for that test; not part of the package's surface.
 */
export function peekResume(config: { readonly configurable?: unknown }): unknown {
  const configurable = isRecord(config.configurable) ? config.configurable : undefined;
  const pad = configurable?.__pregel_scratchpad;
  if (!isRecord(pad) || !Array.isArray(pad.resume) || typeof pad.interruptCounter !== 'number') {
    return undefined;
  }
  const next = pad.interruptCounter + 1;
  if (next < pad.resume.length) return pad.resume[next] as unknown;
  return next === pad.resume.length ? pad.nullResume : undefined;
}

type ToolOutput = unknown;

/**
 * What one governed call needs besides its context: the governance, the catalog name, and the handler that
 * runs the tool once governance has let it through. `governed` hands it the tool's own `invoke`; the
 * middleware hands it the agent's `wrapToolCall` handler.
 * @internal
 */
/** What the one real tool execution of a governed call did, as observed where the tool is invoked. */
export type ObservedOutcome =
  | { readonly ran: false }
  | { readonly ran: true; readonly result: unknown }
  | { readonly ran: true; readonly error: unknown };

export interface Env {
  readonly governance: Governance;
  readonly toolRef: string;
  readonly handler: (args: Record<string, unknown>, config: ToolConfig) => Promise<unknown>;
  /**
   * Set when `handler` hands the tool to a chain that may rewrite what the tool returned (the middleware
   * path). The outcome record then reflects this observed execution, never what `handler` returned.
   */
  readonly observedOutcome?: () => ObservedOutcome;
  /** The deployment executes this tool through the gateway; the wrapped function is the gateway call. */
  readonly gateway: boolean;
}

async function run(
  inner: StructuredToolInterface,
  env: Env,
  input: unknown,
  config: ToolConfig
): Promise<ToolOutput> {
  return governCall(env, readContext(inner.name, input, config), config);
}

/**
 * The one decide / pause / verify / consume / run / record path. `governed`, `governedToolNode` and
 * `governanceMiddleware` all end here; no entry point has a decision, interrupt or consume path of its own.
 * @internal
 */
export async function governCall(
  env: Env,
  context: CallContext,
  config: ToolConfig
): Promise<ToolOutput> {
  const { governance, toolRef } = env;

  // 1. What the deployment serves. A failed read denies the call and is not remembered.
  let routes: boolean;
  let runs: boolean;
  try {
    const capabilities = await governance.capabilities();
    routes = capabilities.routesApprovals;
    runs = capabilities.servesRuns;
  } catch (error) {
    if (
      error instanceof GovernanceError &&
      (error.code === 'runs_required' ||
        error.code === 'continuation_kind_unsupported' ||
        error.code === 'principal_mismatch' ||
        error.code === 'principal_unavailable')
    ) {
      // A setup the adapter refuses to run under: said to the builder, and thrown, not turned into a denial.
      if (error.code !== 'runs_required' && error.code !== 'continuation_kind_unsupported') {
        governance.report(error);
      }
      throw error;
    }
    const failure =
      error instanceof GovernanceError
        ? error
        : new GovernanceError('unreachable', `GET /v1/capabilities failed: ${messageOf(error)}`, {
            cause: error,
          });
    governance.report(failure);
    // A refusal (4xx: a bad or expired token, a mis-set base URL) is a configuration problem, not an outage.
    return failure.code === 'api_error'
      ? denial(
          context,
          'api_error',
          `Governance refused the request; this is a configuration problem, not an outage. ${NOT_RUN}`
        )
      : denial(context, 'unreachable', `Governance could not be reached. ${NOT_RUN}`);
  }

  const { threadId, toolCallId } = context;
  const resumable = threadId !== undefined && toolCallId !== undefined;

  // The call's place among the calls of its task (D-LG11).
  const slot = resumable
    ? coordinationOf(governance).enterTask(
        `${threadId}|${context.checkpointNs}`,
        toolCallId,
        context.position
      )
    : undefined;
  let claimed = false;
  // Whether this call pauses the node (its `interrupt()` threw): a sibling that is allowed waits for this.
  let pausing = false;
  try {
    // 2. The thread's run: without it every end user behind this service principal shares one obligation.
    let runId: string | undefined;
    if (runs && threadId !== undefined) {
      try {
        runId = await governance.runFor(threadId);
      } catch (error) {
        return unreachableDenial(context, governance, error, `POST /v1/runs`);
      }
    } else if (runs && routes && !env.gateway) {
      return denial(
        context,
        'unresumable',
        `This call has no thread_id, so it cannot be scoped to a run. Invoke the graph with a thread_id. ${NOT_RUN}`
      );
    }

    // A gateway-executed call is admitted by the run it names: without one, no decision is asked.
    if (env.gateway && runId === undefined) {
      governance.report(
        new GovernanceError(
          'run_required',
          `The call to ${toolRef} is declared gateway-executed and has no external run: ${
            runs ? 'it has no thread_id to open a run for.' : 'the deployment does not serve runs.'
          } Configure a run per thread.`
        )
      );
      return denial(
        context,
        'run_required',
        `A gateway-executed tool needs an external run, and this call has none. ${NOT_RUN}`
      );
    }

    // 2b. A re-run whose answer is a rejection, or an approval that ended unanswered, is not decided again:
    // the obligation is closed, so a fresh `/decisions` call would open a second one that nothing wants.
    // The resume value only names an approval; the server says what became of it, and it must be this
    // call's own (the sibling calls of the task see the same value and are not its subject).
    const digest = await argDigest(context.args as JsonValue);
    const waiting = peekResume(config);
    if (isResumeValue(waiting) && toolCallId !== undefined) {
      const closed = await closedApprovalOf(governance, waiting.approval_id, toolRef, digest);
      if (closed !== undefined) {
        claimed = true;
        slot?.settle(true);
        return closedAnswer(context, closed);
      }
    }

    // 3. Decide. An earlier call of the task that needs approval holds the pause: this one is decided
    // without a continuation, so it opens nothing the model's retry cannot take over.
    const earlierHoldsPause = slot === undefined ? false : await slot.lowerClaimed();
    const continuation: ContinuationBody | undefined =
      routes && resumable && !earlierHoldsPause
        ? {
            kind: 'langgraph',
            delivery: 'pull',
            correlation: { ...correlationOf(context, threadId, toolCallId) },
          }
        : undefined;
    const request: DecisionRequest = {
      ...(runId === undefined ? {} : { actor: { run_id: runId } }),
      action: { tool_ref: toolRef, arguments: context.args },
      context: {
        invocation_channel: governance.invocationChannel,
        ...(toolCallId === undefined ? {} : { call_id: toolCallId }),
      },
      ...(continuation === undefined ? {} : { continuation }),
    };
    let decision: Decision;
    let unroutable = false;
    try {
      const answer = await governance.api.decide(request);
      if (answer.ok) {
        decision = answer.data;
      } else if (answer.problem.code === 'continuation_unsupported') {
        // The deployment cannot keep a continuation, whatever its capabilities said: cannot route.
        decision = { decision: 'step_up', action_digest: digest, enforced: true };
        unroutable = true;
      } else {
        const conflict = answer.problem.code === 'continuation_conflict';
        governance.report(
          new GovernanceError(
            'api_error',
            `POST /v1/decisions for ${toolRef} answered ${String(answer.problem.status)} ${answer.problem.code}${
              conflict
                ? env.gateway
                  ? '. An approval of this exact call was admitted for the gateway and never consumed by it (the gateway refused the re-issued call or never received it); it stays approved until it expires.'
                  : '. An earlier approval of this exact call was never consumed; if the gateway executes this tool, dispatch it through the gateway instead of running a local function.'
                : ''
            }`
          )
        );
        if (conflict) {
          // An approved obligation for this exact call was never consumed. For an undeclared tool the usual
          // cause is a tool the gateway executes, run here as a local function. For a declared one the
          // approval was admitted locally and the gateway never consumed it: it stays approved upstream.
          return denial(
            context,
            'continuation_conflict',
            `Governance already tracks an open approval for this exact call under another continuation. ${NOT_RUN}`
          );
        }
        return denial(
          context,
          'api_error',
          `Governance refused the request (${String(answer.problem.status)} ${answer.problem.code}). ${NOT_RUN}`
        );
      }
    } catch (error) {
      return unreachableDenial(context, governance, error, 'POST /v1/decisions');
    }
    if (decision.action_digest !== digest) {
      return denial(
        context,
        'digest_mismatch',
        `Governance digested different arguments than were sent. ${NOT_RUN}`
      );
    }

    switch (decision.decision) {
      case 'allow': {
        // This call does not hold the approval slot: later calls of the task need not wait for the tool to run.
        slot?.settle(false);
        // But no call of the task runs on a pass that pauses the node: it would run again when the node re-runs.
        if (slot !== undefined && (await slot.siblingsPause())) return heldInTask(context);
        // An approval handle on an allow: the deployment executes this tool, admits the call by the
        // approval it holds, and records it itself. Nothing here consumes that approval, so only a
        // function declared to be the gateway call runs on it. A local function would run the action with
        // the approval still open, and any process that re-decided the call would run it again until the
        // approval expired: refused, as a step_up for such a tool is.
        if (decision.approval !== undefined && !env.gateway) {
          return await refuseLocalExecution(env, context, decision.approval, 'allow');
        }
        const gatewayRecords = decision.approval !== undefined;
        // Admitted on an approval: it is spent on this call, so a failed run is not a retryable one, and
        // nothing here consumes it. The replay guard stops a second dispatch of the same answer in this
        // process; across processes the gateway's single use of the approval does.
        if (decision.approval !== undefined) {
          const { id, expires_at: expiresAt } = decision.approval;
          const until = new Date(
            typeof expiresAt === 'string' ? Date.parse(expiresAt) : Date.now() + 24 * 3600 * 1000
          );
          if (!(await governance.replayGuard.firstUse(id, until))) {
            return stepAside(context, toolRef, id, 'replayed');
          }
          coordinationOf(governance).markDispatched(id);
        }
        return await execute(env, config, context, {
          decision: 'allow',
          record: !gatewayRecords,
          runId,
          decisionPolicy: decision.policy,
        });
      }
      case 'deny':
        return denyFromServer(context, decision);
      case 'step_up':
        break;
      default:
        return denial(
          context,
          'api_error',
          `Governance answered a decision this adapter does not act on (${decision.decision}). ${NOT_RUN}`
        );
    }

    // 4. step_up.
    const handle = decision.approval;
    if (!routes || unroutable) {
      // The deployment cannot route an approval: the builder's choice governs. This is the only way in to
      // `ask-locally`.
      // A tool declared gateway-executed is never asked locally: the gateway admits a call by an approved
      // obligation it holds, and a local answer creates none, so the call would only be refused there.
      if (governance.whenUnroutable === 'deny' || env.gateway) {
        return denial(
          context,
          'unroutable',
          `This call needs approval and the deployment cannot route one. ${NOT_RUN}`
        );
      }
      if (earlierHoldsPause) return pendingInTask(context);
      claimed = true;
      return await askLocally(env, config, context, runId, decision, slot);
    }
    // The deployment routes approvals, so a call that cannot be routed is a denial, never a local answer:
    // an answer nothing signs would stand in for the approval the deployment is there to ask.
    if (handle === undefined) {
      return refused(
        context,
        governance,
        'api_error',
        `POST /v1/decisions for ${toolRef} answered step_up without an approval to wait on`
      );
    }
    // 4a. A call the caller must not execute: no `resume_token` will issue, so there is nothing to consume
    // and the deployment is the one that runs this tool. A local function under this `toolRef` is refused
    // up front, before anyone is asked to approve it. An approval this call opened is withdrawn; one it only
    // matched was opened by another call and is left alone.
    // A tool declared gateway-executed is the exception: it pauses as a caller-consumer tool does, and the
    // gateway admits the re-issued call once the approver has acted.
    if (!handle.resume_token_will_issue && !env.gateway) {
      return await refuseLocalExecution(env, context, handle, 'step_up');
    }
    if (!resumable) {
      if (handle.created) await withdrawStray(governance, handle.id);
      return denial(
        context,
        'unresumable',
        `This call needs approval but has no thread_id and tool call id to resume it by. ${NOT_RUN}`
      );
    }
    if (earlierHoldsPause) {
      claimed = true;
      // This call was decided without a continuation, so the approval it opened (if it opened one) is
      // answerable by nobody who will resume it: withdrawn, so the model's retry opens its own.
      if (handle.created) await withdrawStray(governance, handle.id);
      return pendingInTask(context);
    }
    claimed = true;
    if (handle.created) await governance.approvalOpened(handle.id, toolRef);
    const payload: GovernedInterrupt = {
      approval_id: handle.id,
      tool_ref: toolRef,
      tool_call_id: toolCallId,
      summary: `Approval required to run ${toolRef}.`,
    };
    // Throws on the first run; on the re-run it returns what `resumeApproval` handed in.
    // `interrupt()` returns the value a resume is waiting with. When an earlier call of the task did not
    // pause on this pass (it was admitted, or its decision changed since the first run), that value is the
    // one meant for it, not for this call: this call is then a fresh pause, and asks again.
    let resume: unknown = interrupt(payload);
    while (await isStrayResume(governance, resume, handle.id, toolRef, digest)) {
      resume = interrupt(payload);
    }
    return await afterResume(env, config, context, runId, decision, handle, resume, digest, slot);
  } catch (error) {
    if (isGraphInterrupt(error)) pausing = true;
    throw error;
  } finally {
    // Settled once the outcome is known: a claimant that resumed has not decided yet whether the node
    // pauses (it can still step aside for a race it lost), so the siblings of the task wait for this.
    slot?.settle(claimed, pausing);
  }
}

/**
 * Whether a resume value names an approval of another call: it is not this call's own open approval, and
 * the server says it was opened for another tool or other arguments. A read that fails is "not stray": the
 * ordinary path reads the approval again and handles the failure.
 */
async function isStrayResume(
  governance: Governance,
  resume: unknown,
  ownApprovalId: string,
  toolRef: string,
  digest: string
): Promise<boolean> {
  if (!isResumeValue(resume) || resume.approval_id === ownApprovalId) return false;
  try {
    const read = await governance.api.getApproval(resume.approval_id);
    return read.ok && (read.data.tool_ref !== toolRef || read.data.action_digest !== digest);
  } catch {
    return false;
  }
}

/** What the server says became of an approval that ended without a yes: the denial it gives the model. */
type Closed = Pick<Approval, 'state' | 'resolution_history'>;

/** The approver's reason, from the last rejection in the approval's history. */
function rejectionReason(approval: Closed): string | undefined {
  const history = approval.resolution_history ?? [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry?.resolution === 'rejected' && entry.reason !== undefined) return entry.reason;
  }
  return undefined;
}

/** The denial a rejected, expired or withdrawn approval gives the model. `halt` is acted on by `resumeApproval`, which never resumes the graph for it. */
function closedAnswer(context: CallContext, approval: Closed): ToolMessage {
  return approval.state === 'rejected'
    ? denial(context, 'rejected', rejectedText(rejectionReason(approval)))
    : denial(
        context,
        'unresumable',
        `The approval ${approval.state} before it was answered. ${NOT_RUN}`
      );
}

/**
 * The approval the resume value names, when it is this call's own and has ended without a yes (rejected,
 * expired, withdrawn). Anything else, including a read that fails, is "not closed": the call takes the
 * ordinary path, which decides again and reads the approval before anything runs.
 */
async function closedApprovalOf(
  governance: Governance,
  approvalId: string,
  toolRef: string,
  digest: string
): Promise<Approval | undefined> {
  try {
    const read = await governance.api.getApproval(approvalId);
    if (!read.ok) return undefined;
    const approval = read.data;
    if (approval.tool_ref !== toolRef || approval.action_digest !== digest) return undefined;
    return approval.state === 'rejected' ||
      approval.state === 'expired' ||
      approval.state === 'withdrawn'
      ? approval
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A decision whose approval handle says the deployment executes the tool, for a tool this process would
 * run as a local function: a `step_up` whose Resumption will carry no `resume_token`, or an `allow` that
 * carries a handle at all (the gateway admits the call by that approval, and nothing here consumes it).
 * Refused before anything runs, as the spec's rule for the handle says: deny instead of running, and
 * withdraw the approval if this call's own decision opened it; one it only matched was opened by another
 * call and is left alone.
 */
async function refuseLocalExecution(
  env: Env,
  context: CallContext,
  handle: NonNullable<Decision['approval']>,
  decided: 'allow' | 'step_up'
): Promise<ToolMessage> {
  const { governance, toolRef } = env;
  const withdrawn = handle.created ? await withdrawStray(governance, handle.id) : undefined;
  // What happened to the approval, from what was observed: opened here and withdrawn, opened here and
  // still open (the withdraw failed), or only matched (opened by another call and left alone).
  const [reported, told] =
    withdrawn === true
      ? [
          ' The approval this call opened was withdrawn.',
          'The approval this call opened was withdrawn.',
        ]
      : withdrawn === false
        ? [
            ' The approval this call opened could not be withdrawn and stays open until it expires.',
            'The approval this call opened could not be withdrawn and may still be shown to an approver; do not retry the call.',
          ]
        : [
            ' The approval was opened by another call and was left as it is.',
            'It matched an approval another call opened, which was left as it is.',
          ];
  const answered =
    decided === 'allow'
      ? `answered allow with an approval handle (approval ${handle.id}): the deployment executes this tool and admits the call by that approval, which nothing in this process consumes`
      : `answered step_up with resume_token_will_issue false (approval ${handle.id}): the deployment executes this tool`;
  governance.report(
    new GovernanceError(
      'not_locally_executable',
      `POST /v1/decisions for ${toolRef} ${answered}, so a local function under this toolRef is never run. Dispatch the call through the gateway instead, or declare the tool with gatewayTools / executedBy: 'gateway' so this adapter pauses for the approval and your function makes the gateway call.${reported}`
    ),
    handle.id
  );
  return denial(
    context,
    'not_locally_executable',
    `This tool is executed by the deployment, not by this process. ${told} ${NOT_RUN}`
  );
}

/** A call that is allowed, in a task where another call pauses for approval: it waits, and runs when the node is resumed. */
function heldInTask(context: CallContext): ToolMessage {
  return denial(
    context,
    'approval_pending_in_task',
    `Another call in this turn is waiting for approval, so this call was not run yet. ${NOT_RUN} It runs once that approval resolves.`
  );
}

function pendingInTask(context: CallContext): ToolMessage {
  return denial(
    context,
    'approval_pending_in_task',
    `Another call in this turn is waiting for approval. ${NOT_RUN} Retry this call after that approval resolves.`
  );
}

function denyFromServer(context: CallContext, decision: Decision): ToolMessage {
  const reason = decision.reason === undefined ? '' : ` (${decision.reason})`;
  return denial(context, 'denied', `Governance denied this call${reason}. ${NOT_RUN}`);
}

interface ExecuteOptions {
  readonly decision: 'allow' | 'step_up';
  readonly record: boolean;
  readonly runId: string | undefined;
  readonly decisionPolicy: Decision['policy'];
  readonly approvalId?: string;
  readonly summary?: string;
}

const NOT_EXECUTED =
  'The middleware chain returned without running the tool; the approval was spent.';

/** Runs the tool, then appends the outcome record, success or failure; a record that cannot be written is `onRecordFailure`'s. */
async function execute(
  env: Env,
  config: ToolConfig,
  context: CallContext,
  options: ExecuteOptions
): Promise<ToolOutput> {
  let result: unknown;
  let failure: unknown;
  let failed = false;
  try {
    // The arguments that were decided, approved and consumed are the ones the tool is handed.
    // A declared gateway tool's function is handed the run it names to the gateway (`gatewayCallContext`);
    // whatever the invoker placed under that key is removed first, for every tool.
    const invokeConfig: ToolConfig = {
      ...config,
      configurable: configurableFor(config.configurable, env.gateway ? options.runId : undefined),
    };
    result = await env.handler(context.args, invokeConfig);
  } catch (error) {
    if (isGraphInterrupt(error)) throw error;
    failed = true;
    failure = error;
  }
  // The record reflects the tool's one real execution when the caller observed it; otherwise the call's own result.
  let recordFailed = failed;
  let recordError = failure;
  let notExecuted = false;
  const observed = env.observedOutcome?.();
  if (observed !== undefined) {
    if (!observed.ran) {
      if (!failed) {
        notExecuted = true;
        recordFailed = true;
        recordError = new GovernanceError('tool_not_executed', NOT_EXECUTED);
      }
    } else if ('error' in observed) {
      recordFailed = true;
      recordError = observed.error;
    } else {
      recordFailed = false;
      recordError = undefined;
    }
  }
  if (options.record) {
    const unrecorded = await appendOutcome(
      env,
      context,
      options,
      recordFailed ? 'failed' : 'succeeded',
      recordError
    );
    if (unrecorded !== undefined) {
      // The tool ran and nothing records it. Under 'throw' the run fails here; otherwise the model is told
      // the truth in fixed words, and the tool's own result (or error) is not passed on as if all were well.
      if (env.governance.onRecordFailure === 'throw') throw unrecorded;
      return denial(context, 'record_failed', unrecordedText(context.toolName));
    }
  }
  if (notExecuted) return denial(context, 'tool_not_executed', NOT_EXECUTED);
  if (failed) throw failure;
  return result;
}

async function appendOutcome(
  env: Env,
  context: CallContext,
  options: ExecuteOptions,
  status: 'succeeded' | 'failed',
  toolFailure: unknown
): Promise<GovernanceError | undefined> {
  const { governance, toolRef } = env;
  const policy = options.decisionPolicy;
  const body: RecordCreate = {
    tool_ref: toolRef,
    decision: options.decision,
    ...(options.runId === undefined ? {} : { actor: { run_id: options.runId } }),
    ...(policy === undefined ? {} : { policy: { id: policy.id, version: policy.version } }),
    ...(options.approvalId === undefined ? {} : { approval_id: options.approvalId }),
    outcome: {
      status,
      ...(options.summary === undefined ? {} : { summary: options.summary }),
      ...(toolFailure === undefined ? {} : { error: messageOf(toolFailure).slice(0, 500) }),
    },
    context: { invocation_channel: governance.invocationChannel },
  };
  // One execution, one key: the retries below share it, so a record the server already holds is not
  // doubled, while a second execution of the same call (a sibling re-run on resume) is recorded too. An
  // approval is consumed once, so its id already names exactly one execution.
  const execution = options.approvalId ?? `${context.threadId ?? ''}-${context.toolCallId ?? ''}`;
  const nonce = options.approvalId === undefined ? `-${crypto.randomUUID()}` : '';
  const key = `nc-langgraph-record-${execution.slice(0, 80)}${nonce}`;
  const { attempts, backoffMs, maxBackoffMs } = governance.recordRetry;
  let failure = new GovernanceError('record_failed', `The outcome record of ${toolRef} failed.`);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let retryable = true;
    try {
      const answer = await governance.api.appendRecord(body, key);
      if (answer.ok) return undefined;
      const { status, code } = answer.problem;
      failure = new GovernanceError(
        'record_failed',
        `The outcome record of ${toolRef} was refused (${String(status)} ${code}).`
      );
      // A refusal is the same answer next time, except when the server only asks for patience.
      retryable = status === 429 || status === 408;
    } catch (error) {
      failure = new GovernanceError(
        'record_failed',
        `The outcome record of ${toolRef} could not be appended: ${messageOf(error)}`,
        { cause: error }
      );
    }
    if (!retryable || attempt === attempts) break;
    await sleep(Math.min(backoffMs * 2 ** (attempt - 1), maxBackoffMs));
  }
  // The tool has run, and nothing records it: reported here, once per execution; the caller decides what the model reads.
  governance.report(failure);
  return failure;
}

async function askLocally(
  env: Env,
  config: ToolConfig,
  context: CallContext,
  runId: string | undefined,
  decision: Decision,
  slot: TaskSlot | undefined
): Promise<ToolOutput> {
  const payload: GovernedInterrupt = {
    tool_ref: env.toolRef,
    tool_call_id: context.toolCallId ?? '',
    summary: `Local approval required to run ${env.toolRef}. Nothing signs this answer.`,
    local: true,
  };
  // `interrupt()` throws on the first run (the node pauses; `run` tells the slot) and returns the answer on the re-run.
  const answer = localAnswer(interrupt(payload));
  // A local answer needs no consume: the call is decided, and the siblings may run on this pass.
  slot?.settle(true, false);
  if (answer === undefined) {
    return denial(
      context,
      'resumption_invalid',
      `The local answer was not a boolean or { approved }. ${NOT_RUN}`
    );
  }
  if (!answer.approved) {
    return denial(
      context,
      'rejected',
      `The local approver rejected this call${answer.reason === undefined ? '' : `: ${answer.reason}`}. ${NOT_RUN}`
    );
  }
  return execute(env, config, context, {
    decision: 'step_up',
    record: true,
    runId,
    decisionPolicy: decision.policy,
    summary: 'approved by a local, unverified answer; the approver is not attested',
  });
}

/**
 * Withdraws an approval this re-run opened and does not want. A failure is reported, never thrown: the
 * call is denied either way. Resolves true when the server withdrew it.
 */
async function withdrawStray(governance: Governance, approvalId: string): Promise<boolean> {
  const stray = (why: string, cause?: unknown): GovernanceError =>
    new GovernanceError(
      'api_error',
      `The unwanted approval ${approvalId} could not be withdrawn (${why}); it stays open in the inbox until it expires.`,
      cause === undefined ? undefined : { cause }
    );
  try {
    const answer = await governance.api.withdraw(approvalId);
    if (answer.ok) return true;
    governance.report(stray(`${String(answer.problem.status)} ${answer.problem.code}`));
  } catch (error) {
    governance.report(stray(messageOf(error), error));
  }
  return false;
}

/**
 * A governed call whose request to `/v1` failed: reported to the builder with the cause, and denied with
 * a fixed message (transport error text is not for the model). A 4xx is an api_error, anything else unreachable.
 */
function unreachableDenial(
  context: CallContext,
  governance: Governance,
  error: unknown,
  what: string
): ToolOutput {
  const failure =
    error instanceof GovernanceError
      ? error
      : new GovernanceError('unreachable', `${what} failed: ${messageOf(error)}`, { cause: error });
  governance.report(failure);
  return failure.code === 'api_error'
    ? denial(context, 'api_error', `Governance refused the request. ${NOT_RUN}`)
    : denial(context, 'unreachable', `Governance could not be reached. ${NOT_RUN}`);
}

/**
 * What to do with an answered approval: read it, read and verify its Resumption, consume it, run the tool.
 * A failure that is the approval's own (not this call's, tampered, expired) is a denial; one that is `/v1` being
 * unreachable is not (see `retryLater`).
 */
async function afterResume(
  env: Env,
  config: ToolConfig,
  context: CallContext,
  runId: string | undefined,
  decision: Decision,
  handle: NonNullable<Decision['approval']>,
  resume: unknown,
  digest: string,
  slot: TaskSlot | undefined
): Promise<ToolOutput> {
  const { governance, toolRef } = env;
  if (!isResumeValue(resume)) {
    return denial(
      context,
      'resumption_invalid',
      `The resume value is not one this adapter understands. ${NOT_RUN}`
    );
  }
  const approvalId = resume.approval_id;
  // The re-run's `/decisions` call opened an obligation of its own when the one the resume names was
  // already closed (rejected, expired, withdrawn, consumed): that one is not wanted.
  if (handle.id !== approvalId && handle.created) {
    await withdrawStray(governance, handle.id);
  }

  // 1. The server's word on the approval: the resume value proves nothing by itself.
  let approval: Approval;
  try {
    const read = await governance.api.getApproval(approvalId);
    if (!read.ok) {
      if (isPatience(read.problem.status)) {
        return retryLater(
          env,
          context,
          approvalId,
          'GET /v1/approvals/{id}',
          new GovernanceError(
            'unreachable',
            `GET /v1/approvals/{id} answered ${String(read.problem.status)} ${read.problem.code}`
          )
        );
      }
      return refused(
        context,
        governance,
        'api_error',
        `GET /v1/approvals/{id} answered ${String(read.problem.status)} ${read.problem.code}`
      );
    }
    approval = read.data;
  } catch (error) {
    return retryLater(env, context, approvalId, 'GET /v1/approvals/{id}', error);
  }
  if (approval.tool_ref !== toolRef || approval.action_digest !== digest) {
    return denial(
      context,
      'consume_conflict',
      `The approval that was answered is not for this call. ${NOT_RUN}`
    );
  }
  if (
    approval.state === 'rejected' ||
    approval.state === 'expired' ||
    approval.state === 'withdrawn'
  ) {
    return closedAnswer(context, approval);
  }
  // Spent: another attempt consumed it and runs the tool (or died before it checkpointed; the worker raises that).
  if (approval.state === 'consumed') return stepAside(context, toolRef, approvalId, 'consumed');
  if (approval.state !== 'approved') {
    return denial(
      context,
      'resumption_invalid',
      `The approval is ${approval.state}, not approved. ${NOT_RUN}`
    );
  }
  // The re-entry decision is the server's word that this call's open obligation is the approved one.
  if (handle.id !== approvalId) {
    return denial(
      context,
      'consume_conflict',
      `The approval that was answered no longer matches this call. ${NOT_RUN}`
    );
  }
  if (handle.state !== 'approved') {
    return denial(
      context,
      'resumption_invalid',
      `The approval is not approved for this call. ${NOT_RUN}`
    );
  }

  // 2. Its signed Resumption, which only the principal that created the approval can read.
  let resumption: Resumption;
  try {
    const read = await governance.api.getResumption(approvalId);
    if (!read.ok) {
      if (isPatience(read.problem.status)) {
        return retryLater(
          env,
          context,
          approvalId,
          'GET /v1/approvals/{id}/resumption',
          new GovernanceError(
            'unreachable',
            `GET /v1/approvals/{id}/resumption answered ${String(read.problem.status)} ${read.problem.code}`
          )
        );
      }
      return resumptionRefused(env, context, approval, read.problem);
    }
    resumption = read.data;
  } catch (error) {
    return retryLater(env, context, approvalId, 'GET /v1/approvals/{id}/resumption', error);
  }

  // 3. Verified against what this node is about to run: the tool, and the digest of the arguments the
  // tool is about to be handed. The guard is applied here, keyed on the approval.
  let verified: ResumptionPayload;
  try {
    verified = await governance.verify(
      resumption.signature,
      { tool_ref: toolRef, arg_digest: digest },
      { replayGuard: governance.replayGuard }
    );
  } catch (error) {
    if (error instanceof ResumptionError) {
      if (error.code === 'replayed') return stepAside(context, toolRef, approvalId, 'replayed');
      const code = RESUMPTION_ERROR_CODES[error.code] ?? 'resumption_invalid';
      governance.report(new GovernanceError(code, error.message, { cause: error }), approvalId);
      return denial(context, code, `The approval could not be verified (${code}). ${NOT_RUN}`);
    }
    // Not a verdict on the Resumption: the key set could not be fetched.
    return retryLater(env, context, approvalId, 'fetching the key set', error);
  }
  // From here a failure that spends nothing must not leave the approval marked: the guard forgets it, so the
  // retry of the resume (which re-enters here) is not taken for a replay.
  const forget = async (): Promise<void> => {
    if (isForgettable(governance.replayGuard)) await governance.replayGuard.forget(approvalId);
  };

  // 4. The signed continuation names this very call.
  const signed = signedCorrelation(verified);
  if (
    verified.approval_id !== approvalId ||
    signed === undefined ||
    signed.thread_id !== context.threadId ||
    signed.checkpoint_ns !== context.checkpointNs ||
    signed.tool_call_id !== context.toolCallId
  ) {
    await forget();
    return denial(
      context,
      'resumption_invalid',
      `The signed approval does not name this call. ${NOT_RUN}`
    );
  }
  // A Resumption without a `resume_token` is for a tool the gateway executes; a call that is not
  // admitted by the gateway (see `run`) has nothing to consume here and never runs. For a tool declared
  // gateway-executed the call is admitted on the node's re-run, not here: the node pauses again.
  if (verified.resume_token === undefined) {
    await forget();
    if (env.gateway) {
      return pauseAgain(context, toolRef, approvalId, {
        summary: `The gateway executes this tool; approval ${approvalId} carries nothing to consume here. Re-run the node.`,
        gateway: true,
      });
    }
    return denial(
      context,
      'resumption_invalid',
      `The approval carries nothing to consume for this call. ${NOT_RUN}`
    );
  }

  // 5. The commit point: consume before dispatch. The approval is spent on the attempt, not on the success.
  let consumed;
  try {
    consumed = await governance.api.consume(
      approvalId,
      verified.resume_token,
      toolRef,
      context.args
    );
  } catch (error) {
    // The outcome is unknown: the request may have reached the server, which consumes atomically. The
    // guard forgets the approval and the node pauses again; the retry reads the approval first: `consumed`
    // is the consumed-but-paused case (the worker raises it), `approved` is consumed again.
    await forget();
    return retryLater(env, context, approvalId, 'POST /v1/approvals/{id}/consume', error);
  }
  if (!consumed.ok) {
    const { code, status } = consumed.problem;
    // Another resumer spent it: it runs the tool.
    if (code === 'obligation_consumed') return stepAside(context, toolRef, approvalId, 'consumed');
    await forget();
    if (code === 'approval_conflict') {
      return denial(
        context,
        'consume_conflict',
        `The approval no longer matches this call (${code}). ${NOT_RUN}`
      );
    }
    if (isPatience(status)) {
      // Throttled, not refused: the approval is unspent, and the node pauses again to be tried again.
      return retryLater(
        env,
        context,
        approvalId,
        'POST /v1/approvals/{id}/consume',
        new GovernanceError(
          'unreachable',
          `Consuming approval ${approvalId} answered ${String(status)} ${code}`
        )
      );
    }
    governance.report(
      new GovernanceError(
        'api_error',
        `Consuming approval ${approvalId} answered ${String(status)} ${code}`
      )
    );
    return denial(
      context,
      'unresumable',
      `The approval could not be consumed (${status.toString()} ${code}). ${NOT_RUN}`
    );
  }
  coordinationOf(governance).markDispatched(approvalId);
  // The approval is spent on this call: this pass will not pause, so the siblings of the task may run.
  slot?.settle(true, false);
  return execute(env, config, context, {
    decision: 'step_up',
    record: true,
    runId,
    decisionPolicy: decision.policy,
    approvalId,
  });
}

/**
 * This attempt lost a race on the approval: another attempt holds the replay guard or has consumed it, and
 * runs the tool. A denial returned here would be written into the thread over the winner's result, and a
 * thrown error is turned into one by a `ToolNode` that handles tool errors. A pause is written nowhere:
 * the node interrupts again, the thread keeps the winner's head, and `resumeApproval` tells its caller.
 */
function stepAside(
  context: CallContext,
  toolRef: string,
  approvalId: string,
  lost: 'replayed' | 'consumed'
): ToolMessage {
  return pauseAgain(context, toolRef, approvalId, {
    summary: `Another attempt acts on approval ${approvalId}; this one stepped aside.`,
    lost,
  });
}

/**
 * `/v1` could not be reached while acting on an answered approval (read it, read its Resumption, fetch the
 * key set, consume it), or answered 429 or 408: the approval is still good and nothing is known to have been
 * spent. The call is not denied: a denial is written into the thread, the model's retry would then find the
 * approval still open under another continuation (`continuation_conflict`) and it would never be consumed.
 * The node pauses again instead, which writes nothing, and `resumeApproval` throws `unreachable` and
 * releases its claim so the worker tries again. The cause is reported to the builder.
 */
function retryLater(
  env: Env,
  context: CallContext,
  approvalId: string,
  what: string,
  cause: unknown
): ToolMessage {
  const failure =
    cause instanceof GovernanceError
      ? cause
      : new GovernanceError('unreachable', `${what} failed: ${messageOf(cause)}`, { cause });
  env.governance.report(failure, approvalId);
  return pauseAgain(context, env.toolRef, approvalId, {
    summary: `Governance could not be reached to act on approval ${approvalId}; nothing ran, and it will be tried again.`,
    retry: true,
  });
}

/** 429 and 408 ask for patience: the request can be sent again. */
const isPatience = (status: number): boolean => status === 429 || status === 408;

function pauseAgain(
  context: CallContext,
  toolRef: string,
  approvalId: string,
  marker: {
    readonly summary: string;
    readonly lost?: 'replayed' | 'consumed';
    readonly retry?: true;
    readonly gateway?: true;
  }
): ToolMessage {
  const payload: GovernedInterrupt = {
    approval_id: approvalId,
    tool_ref: toolRef,
    tool_call_id: context.toolCallId ?? '',
    ...marker,
  };
  // The first `interrupt()` of a node returns the value a resume is waiting with (a call that never
  // paused reaches this point with the resume still unread), so it is asked twice: the one that follows
  // has nothing to return and pauses.
  interrupt(payload);
  interrupt(payload);
  // Only reached when the driver resumed this second pause too: still nothing ran.
  // For a gateway-declared tool this keeps the `resumption_invalid` code (no gateway-specific code exists in
  // the DenialCode set); the message says to re-run the node. Pinned by governed-gateway.test.ts.
  if (marker.gateway === true) {
    return denial(
      context,
      'resumption_invalid',
      `The gateway executes this tool, so the approval carries nothing to consume here; re-run the node. ${NOT_RUN}`
    );
  }
  return marker.retry === true
    ? denial(context, 'unreachable', `Governance could not be reached. ${NOT_RUN}`)
    : denial(context, 'consume_conflict', `Another attempt acted on this approval. ${NOT_RUN}`);
}

/** A request to `/v1` the API refused: reported to the builder, and denied with a fixed message. */
function refused(
  context: CallContext,
  governance: Governance,
  code: 'api_error',
  what: string
): ToolMessage {
  governance.report(new GovernanceError(code, what));
  return denial(context, code, `Governance refused the request. ${NOT_RUN}`);
}

/** What a Resumption read that was refused means for the call. */
function resumptionRefused(
  env: Env,
  context: CallContext,
  approval: Approval,
  problem: { readonly status: number; readonly code: string }
): ToolOutput {
  const { governance } = env;
  const { status, code } = problem;
  if (status === 403) {
    governance.report(
      new GovernanceError(
        'not_owner',
        'The Resumption is readable by the principal that created the approval only; this process runs as another principal.'
      ),
      approval.id
    );
    return denial(context, 'not_owner', `The approval could not be read. ${NOT_RUN}`);
  }
  if (code === 'obligation_expired' || code === 'obligation_withdrawn') {
    return closedAnswer(context, {
      state: code === 'obligation_expired' ? 'expired' : 'withdrawn',
    });
  }
  // Spent by another attempt: it runs the tool.
  if (code === 'already_resumed') return stepAside(context, env.toolRef, approval.id, 'consumed');
  governance.report(
    new GovernanceError(
      'unresumable',
      `GET /v1/approvals/{id}/resumption answered ${String(status)} ${code}`
    ),
    approval.id
  );
  return denial(context, 'unresumable', `The approval could not be resumed (${code}). ${NOT_RUN}`);
}

/** A LangChain tool with the same name, schema and description whose every call goes through governance. */
export function governed(
  inner: StructuredToolInterface,
  options: GovernedOptions
): StructuredToolInterface {
  const env: Env = {
    governance: options.governance,
    toolRef: options.toolRef,
    handler: (args, config) => inner.invoke(args as never, config),
    gateway: options.executedBy === 'gateway',
  };
  options.governance.registerTool(inner.name, options.toolRef);
  return tool(
    (input: unknown, config: ToolConfig): Promise<ToolOutput> => run(inner, env, input, config),
    {
      name: inner.name,
      description: inner.description,
      schema: inner.schema as never,
      ...(inner.returnDirect ? { returnDirect: true } : {}),
    }
  ) as unknown as StructuredToolInterface;
}

/** A `ToolNode` over the governed tools. It has no logic of its own. */
export function governedToolNode(
  tools: readonly StructuredToolInterface[],
  options: GovernedToolNodeOptions
): ToolNode {
  const gatewayTools = new Set(options.gatewayTools ?? []);
  for (const name of gatewayTools) {
    if (!tools.some((inner) => inner.name === name)) {
      throw new Error(`governedToolNode: gatewayTools names ${name}, which is not among the tools`);
    }
  }
  return new ToolNode(
    tools.map((inner) => {
      const toolRef = options.toolRefs[inner.name];
      if (toolRef === undefined) {
        throw new Error(`governedToolNode: no toolRef for the tool ${inner.name}`);
      }
      return governed(inner, {
        toolRef,
        governance: options.governance,
        ...(gatewayTools.has(inner.name) ? { executedBy: 'gateway' as const } : {}),
      });
    }),
    options.handleToolErrors === undefined ? {} : { handleToolErrors: options.handleToolErrors }
  );
}
