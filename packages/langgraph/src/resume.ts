/**
 * `resumeApproval`: the one resume primitive. It reads the approval, verifies its signed Resumption
 * against what the checkpoint says is paused, and hands LangGraph the answer. It never runs a tool.
 */
import { argDigest, ResumptionError } from '@noblecloak/client';
import type { JsonValue, ResumptionPayload } from '@noblecloak/client';
import { ToolMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';

import type { Approval } from './api.js';
import { denialMessage, rejectedText } from './denial.js';
import { GovernanceError, messageOf } from './errors.js';
import { coordinationOf } from './governance.js';
import type { Governance } from './governance.js';
import { correlationOf, RESUMPTION_ERROR_CODES } from './resumption.js';
import type { ResumeValue } from './types.js';

/** The part of a compiled graph the resume path uses. */
export interface ResumableGraph {
  getState(config: { configurable: { thread_id: string } }): Promise<{
    readonly values: unknown;
    readonly config: { readonly configurable?: Record<string, unknown> };
    readonly tasks: readonly {
      readonly id: string;
      readonly name: string;
      readonly interrupts: readonly { readonly id?: string; readonly value?: unknown }[];
    }[];
  }>;
  invoke(input: never, config: { configurable: { thread_id: string } }): Promise<unknown>;
  /** Writes `values` into the thread as the output of node `asNode`: how a halted run is left. */
  updateState(
    config: { configurable: { thread_id: string } },
    values: never,
    asNode?: string
  ): Promise<unknown>;
}

export interface ResumeOptions {
  readonly governance: Governance;
  /**
   * The thread the approval paused, when the caller knows it. Otherwise it comes from the continuation the
   * server echoes on the approval to the principal that created it (`continuation.correlation.thread_id`).
   */
  readonly threadId?: string;
  /**
   * How long to wait for the thread's checkpoint to show the pause, in milliseconds. An approval can be
   * answered before the graph has finished pausing. Default 5000.
   */
  readonly pausedGraceMs?: number;
  /**
   * An epoch time in milliseconds before which a thread with no checkpoint in this process's checkpoint
   * store is not written off: the call returns `{ status: 'skipped', reason: 'no_thread' }` and records
   * nothing, so the caller can look again. At or after it, the approval is recorded as unresumable and
   * `unresumable` is thrown. This is the worker's retry gate: the worker sets it from its retry window,
   * counted from its first look at the approval. A direct `resumeApproval` call without it records the
   * approval as unresumable once `pausedGraceMs` has passed.
   */
  readonly noThreadRetryUntil?: number;
}

export type ResumeOutcome =
  /** The approval was answered and the thread resumed with that answer; `result` is what the graph returned. */
  | {
      readonly status: 'resumed';
      /** The resolution the approver gave. */
      readonly resolution: 'approved' | 'rejected';
      readonly result: unknown;
    }
  /**
   * The approval ended without an answer (a state, not a resolution: nobody resolved it) and the thread was
   * resumed with a denial that says which.
   */
  | {
      readonly status: 'resumed';
      readonly state: 'expired' | 'withdrawn';
      readonly result: unknown;
    }
  /** `onRejected: 'halt'`: the denial is written into the thread and the graph is not resumed. */
  | { readonly status: 'halted'; readonly resolution: 'rejected' }
  | { readonly status: 'waiting'; readonly reason: 'pending' | 'escalated' }
  /**
   * `consumed`: spent. `not_paused`: the thread does not show the pause (yet). `answered`: the thread has
   * already moved past the call (its tool call has an answer), so there is nothing left to resume.
   * `not_langgraph`: the approval's continuation kind is not `langgraph` (an `mcp_held` or `push`
   * approval), or it is expired or withdrawn and carries no continuation: this adapter never opened it, so
   * nothing is done or recorded. `no_thread`: the thread was not found in this process's checkpoint store
   * and `noThreadRetryUntil` has not passed; nothing is recorded yet.
   */
  | {
      readonly status: 'skipped';
      readonly reason: 'consumed' | 'not_paused' | 'answered' | 'not_langgraph' | 'no_thread';
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** The pending call of a thread, as the checkpoint holds it. */
interface Paused {
  readonly interruptId: string | undefined;
  /** The node the pause is in. */
  readonly node: string;
  /** The call the interrupt is for. */
  readonly toolCallId: string | undefined;
}

function pausedAt(
  state: Awaited<ReturnType<ResumableGraph['getState']>>,
  approvalId: string
): Paused | undefined {
  for (const task of state.tasks) {
    for (const pending of task.interrupts) {
      if (isRecord(pending.value) && pending.value.approval_id === approvalId) {
        const call = pending.value.tool_call_id;
        return {
          interruptId: pending.id,
          node: task.name,
          toolCallId: typeof call === 'string' ? call : undefined,
        };
      }
    }
  }
  return undefined;
}

/** Whether the checkpointed state holds a tool message answering this call. */
function answeredIn(values: unknown, toolCallId: string): boolean {
  if (!isRecord(values) || !Array.isArray(values.messages)) return false;
  return (values.messages as unknown[]).some(
    (m) => m instanceof ToolMessage && m.tool_call_id === toolCallId
  );
}

/** The tool call with this id on an AI message of the checkpointed state. */
export function findToolCall(
  values: unknown,
  toolCallId: string
): { readonly name: string; readonly args: Record<string, unknown> } | undefined {
  if (!isRecord(values) || !Array.isArray(values.messages)) return undefined;
  for (let i = values.messages.length - 1; i >= 0; i -= 1) {
    const calls = (values.messages[i] as { tool_calls?: unknown } | undefined)?.tool_calls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls as unknown[]) {
      if (isRecord(call) && call.id === toolCallId && typeof call.name === 'string') {
        return { name: call.name, args: isRecord(call.args) ? call.args : {} };
      }
    }
  }
  return undefined;
}

/** The payload of a signed Resumption, or undefined when it cannot be read. */
function decodePayload(jws: string): Record<string, unknown> | undefined {
  const segment = jws.split('.')[1] ?? '';
  try {
    const json = new TextDecoder().decode(
      Uint8Array.from(atob(segment.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
    );
    const parsed: unknown = JSON.parse(json);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Answers an approval that ended without a signed Resumption: the thread is denied with the reason. The
 * thread is the one the continuation names (the server echoes it to the principal that created the
 * approval). An approval of another kind than `langgraph` is skipped as `not_langgraph`: this adapter
 * never opened it. A `langgraph` approval for which no continuation came back, and for which the caller
 * names no thread, throws `continuation_unavailable` and records nothing (the caller is not the principal
 * that created it, or the deployment predates rev 4 and echoes none). An approval whose continuation
 * names no thread, or whose thread was not found in this process's checkpoint store, is recorded as
 * unresumable.
 */
async function resumeClosed(
  graph: ResumableGraph,
  governance: Governance,
  approval: Approval,
  state: 'expired' | 'withdrawn',
  options: ResumeOptions
): Promise<ResumeOutcome> {
  if (isOtherKind(approval)) return { status: 'skipped', reason: 'not_langgraph' };
  const named = correlationOf(approval);
  const threadId = options.threadId ?? named?.thread_id;
  if (threadId === undefined && approval.continuation === undefined) {
    // No continuation reached this caller, and the caller named no thread: nothing shows the approval
    // is this adapter's, so nothing is recorded about it.
    if (approval.continuation_kind !== 'langgraph')
      return { status: 'skipped', reason: 'not_langgraph' };
    throw new GovernanceError(
      'continuation_unavailable',
      continuationUnavailable(approval.id, state)
    );
  }
  if (threadId === undefined) {
    await recordUnresumable(
      governance,
      approval,
      `the approval ${state} and its continuation names no thread`
    );
    throw new GovernanceError(
      'unresumable',
      `The approval ${approval.id} ${state}, and its continuation names no thread to resume.`
    );
  }
  const pause = await awaitPause(graph, threadId, approval.id, options.pausedGraceMs ?? 5000);
  if (pause === 'no_thread') return noThread(governance, approval, threadId, options);
  if (pause === 'not_paused') {
    // A thread that already answered the call (a restart after the denial was handed in) has nothing
    // left to resume: that is not a thread that never paused. The call is the one the continuation names.
    const state = await graph.getState({ configurable: { thread_id: threadId } });
    return named !== undefined && answeredIn(state.values, named.tool_call_id)
      ? { status: 'skipped', reason: 'answered' }
      : { status: 'skipped', reason: 'not_paused' };
  }
  const result = await invokeResume(graph, threadId, pause, answered(approval.id));
  return { status: 'resumed', state, result };
}

/** Whether the approval's continuation is of a kind other than `langgraph`: not one this adapter opened. */
const isOtherKind = (approval: Approval): boolean =>
  approval.continuation_kind !== undefined && approval.continuation_kind !== 'langgraph';

const continuationUnavailable = (approvalId: string, state: string): string =>
  `The approval ${approvalId} is ${state}, and the server returned no continuation for it. Either the caller is not the principal that created it (only the creating principal reads its continuation), or the deployment predates contract v1 rev 4 and echoes none. Pass \`threadId\` to name the thread.`;

/**
 * A thread with no checkpoint in this process's checkpoint store. Before `noThreadRetryUntil` that is
 * "not yet": nothing is recorded and the caller looks again. After it, the approval is recorded as
 * unresumable, in terms of what was observed: this process's store has no such thread, which does not
 * mean the thread is gone (another deployment's store may hold it).
 */
async function noThread(
  governance: Governance,
  approval: Approval,
  threadId: string,
  options: ResumeOptions
): Promise<ResumeOutcome> {
  if (options.noThreadRetryUntil !== undefined && Date.now() < options.noThreadRetryUntil) {
    return { status: 'skipped', reason: 'no_thread' };
  }
  await recordUnresumable(
    governance,
    approval,
    `the thread ${threadId} was not found in this worker's checkpoint store`
  );
  throw new GovernanceError(
    'unresumable',
    `The thread ${threadId} of approval ${approval.id} was not found in this worker's checkpoint store. It may live in another deployment's store: run one checkpoint store per service principal.`
  );
}

/**
 * A consumed approval is spent: nothing is resumed for it. If its thread is still paused on it, though,
 * the process died between the consume and the checkpoint write, and nothing will move that thread. That
 * is raised, not skipped. (Another process that consumed it a moment ago and is still running the tool
 * looks the same until it checkpoints; run one resumer per principal.)
 */
async function resumeConsumed(
  graph: ResumableGraph,
  approval: Approval,
  options: ResumeOptions
): Promise<ResumeOutcome> {
  const threadId = options.threadId ?? correlationOf(approval)?.thread_id;
  if (threadId !== undefined) {
    const state = await graph.getState({ configurable: { thread_id: threadId } });
    if (pausedAt(state, approval.id) !== undefined) {
      throw new GovernanceError(
        'unresumable',
        `The approval ${approval.id} was consumed but thread ${threadId} is still paused on it. The tool was not re-run; the call needs a new approval, and the thread needs a new turn.`
      );
    }
  }
  return { status: 'skipped', reason: 'consumed' };
}

/** The only thing a resume carries: which approval was answered. The tool node reads the answer from the server. */
const answered = (approvalId: string): ResumeValue => ({
  kind: 'answered',
  approval_id: approvalId,
});

async function invokeResume(
  graph: ResumableGraph,
  threadId: string,
  pause: Paused,
  value: ResumeValue
): Promise<unknown> {
  // Addressed by the interrupt's id, so the answer reaches the pause it is for.
  const resume = pause.interruptId === undefined ? value : { [pause.interruptId]: value };
  const command = new Command({ resume }) as never;
  return graph.invoke(command, { configurable: { thread_id: threadId } });
}

/**
 * Whether the resumed run held back instead of acting on the approval (see `stepAside` and `retryLater` in
 * governed.ts): another attempt holds it (`replayed`, `consumed`), `/v1` could not be reached (`retry`), or
 * the tool is declared gateway-executed and the answered approval carries nothing to consume (`gateway`).
 */
function heldBack(
  result: unknown,
  approvalId: string
): 'replayed' | 'consumed' | 'retry' | 'gateway' | undefined {
  const pending = isRecord(result) ? result.__interrupt__ : undefined;
  if (!Array.isArray(pending)) return undefined;
  for (const entry of pending as unknown[]) {
    const value = isRecord(entry) ? entry.value : undefined;
    if (isRecord(value) && value.approval_id === approvalId) {
      if (value.retry === true) return 'retry';
      if (value.gateway === true) return 'gateway';
      if (value.lost === 'replayed' || value.lost === 'consumed') return value.lost;
    }
  }
  return undefined;
}

async function awaitPause(
  graph: ResumableGraph,
  threadId: string,
  approvalId: string,
  graceMs: number
): Promise<Paused | 'no_thread' | 'not_paused'> {
  const deadline = Date.now() + graceMs;
  for (let delay = 20; ; delay = Math.min(delay * 2, 500)) {
    const state = await graph.getState({ configurable: { thread_id: threadId } });
    const pause = pausedAt(state, approvalId);
    if (pause !== undefined) return pause;
    const exists = state.config.configurable?.checkpoint_id !== undefined;
    if (Date.now() >= deadline) return exists ? 'not_paused' : 'no_thread';
    await sleep(delay);
  }
}

/** Appends the record of an approval that was answered but cannot be resumed. Never throws. */
export async function recordUnresumable(
  governance: Governance,
  approval: { readonly id: string; readonly tool_ref: string },
  why: string
): Promise<void> {
  try {
    const answer = await governance.api.appendRecord(
      {
        tool_ref: approval.tool_ref,
        decision: 'step_up',
        approval_id: approval.id,
        outcome: { status: 'unknown', summary: `answered but unresumable: ${why}` },
        context: { invocation_channel: governance.invocationChannel },
      },
      `nc-langgraph-unresumable-${approval.id}`
    );
    if (!answer.ok) {
      governance.report(
        new GovernanceError(
          'record_failed',
          `The unresumable record of ${approval.id} was refused (${String(answer.problem.status)} ${answer.problem.code}).`
        )
      );
    }
  } catch (error) {
    governance.report(
      new GovernanceError('record_failed', `The unresumable record of ${approval.id} failed.`, {
        cause: error,
      })
    );
  }
}

/**
 * Resumes the thread an approval paused.
 *
 * `approved` is verified and handed to the graph; `rejected` is handed as a rejection; `escalated`
 * and `pending` leave the thread paused; any other resolution leaves it paused and throws
 * `unknown_resolution`; `expired` and `withdrawn` hand the graph a denial that names which.
 */
export async function resumeApproval(
  graph: ResumableGraph,
  approvalId: string,
  options: ResumeOptions
): Promise<ResumeOutcome> {
  const { governance } = options;
  const fetched = await governance.api.getApproval(approvalId);
  if (!fetched.ok) {
    throw new GovernanceError(
      fetched.problem.status === 429 || fetched.problem.status === 408
        ? 'unreachable'
        : 'api_error',
      `GET /v1/approvals/${approvalId} answered ${String(fetched.problem.status)} ${fetched.problem.code}`
    );
  }
  const approval = fetched.data;
  switch (approval.state) {
    case 'pending':
      return {
        status: 'waiting',
        reason: approval.resolution === 'escalated' ? 'escalated' : 'pending',
      };
    case 'consumed':
      return resumeConsumed(graph, approval, options);
    case 'expired':
    case 'withdrawn':
      return resumeClosed(graph, governance, approval, approval.state, options);
    case 'approved':
    case 'rejected':
      break;
    default:
      // A state this adapter does not know: leave the thread alone, and say so.
      governance.report(
        new GovernanceError(
          'unknown_resolution',
          `The approval ${approvalId} is in the state ${JSON.stringify(approval.state)}, which this adapter does not act on; its thread stays paused.`
        ),
        approvalId
      );
      return { status: 'waiting', reason: 'pending' };
  }

  // Another kind's approval is not this adapter's: it is not read, resumed or recorded.
  if (isOtherKind(approval)) return { status: 'skipped', reason: 'not_langgraph' };

  // The Resumption is readable by the creating principal only.
  const read = await governance.api.getResumption(approvalId);
  if (!read.ok) {
    const { status, code } = read.problem;
    if (status === 403) {
      // The approval was shown to this principal as its own (a service principal sees only what it
      // created, and the worker lists with created_by=me), so a 403 on its Resumption is a misconfiguration:
      // the worker is not the principal that created it.
      throw new GovernanceError(
        'not_owner',
        'The Resumption is readable by the principal that created the approval only. Run the resumer as the same service principal as the agent.'
      );
    }
    if (code === 'obligation_expired' || code === 'obligation_withdrawn') {
      return resumeClosed(
        graph,
        governance,
        approval,
        code === 'obligation_expired' ? 'expired' : 'withdrawn',
        options
      );
    }
    if (code === 'already_resumed') return { status: 'skipped', reason: 'consumed' };
    if (code === 'continuation_expired') {
      await recordUnresumable(governance, approval, 'the continuation expired');
      throw new GovernanceError('unresumable', 'The continuation expired.');
    }
    if (status === 404) {
      // An approval that is answered but has no Resumption yet: wait, and say so.
      governance.report(
        new GovernanceError(
          'api_error',
          `The approval ${approvalId} is ${approval.state} but its Resumption answered 404 ${code}; waiting.`
        ),
        approvalId
      );
      return { status: 'waiting', reason: 'pending' };
    }
    throw new GovernanceError(
      status === 429 || status === 408 ? 'unreachable' : 'api_error',
      `GET resumption answered ${String(status)} ${code}`
    );
  }
  const resumption = read.data;
  const correlation = correlationOf(resumption);
  if (correlation === undefined) {
    await recordUnresumable(
      governance,
      approval,
      'its continuation is not a usable langgraph continuation'
    );
    throw new GovernanceError(
      'unresumable',
      `The approval ${approvalId} carries no usable langgraph continuation, so there is nothing to resume.`
    );
  }
  const threadId = options.threadId ?? correlation.thread_id;

  // What is paused, from the checkpoint: the arguments are digested as stored there.
  const pause = await awaitPause(graph, threadId, approvalId, options.pausedGraceMs ?? 5000);
  if (pause === 'no_thread') return noThread(governance, approval, threadId, options);
  const state = await graph.getState({ configurable: { thread_id: threadId } });
  if (pause === 'not_paused') {
    // A thread that already answered the call has nothing to resume (a rejection handled before this
    // worker started, say): that is not a thread that never paused.
    return answeredIn(state.values, correlation.tool_call_id)
      ? { status: 'skipped', reason: 'answered' }
      : { status: 'skipped', reason: 'not_paused' };
  }
  const call = findToolCall(state.values, correlation.tool_call_id);
  if (call === undefined) {
    await recordUnresumable(governance, approval, 'the tool call is not in the checkpoint');
    throw new GovernanceError(
      'unresumable',
      `The tool call ${correlation.tool_call_id} is not in the checkpoint of thread ${threadId}.`
    );
  }
  const expectedToolRef = governance.toolRefFor(call.name);
  if (expectedToolRef === undefined) {
    throw new GovernanceError(
      'tool_mismatch',
      `No governed tool is named ${call.name} here; the worker must build the same governed tools as the agent.`
    );
  }
  const expected = {
    tool_ref: expectedToolRef,
    arg_digest: await argDigest(call.args as JsonValue),
  };

  let verified: ResumptionPayload;
  try {
    // No replay guard here: the tool node applies it, keyed on the approval, where the tool is about to run.
    verified = await governance.verify(resumption.signature, expected, {
      acceptResolutions: ['approved', 'rejected'],
    });
  } catch (error) {
    if (error instanceof ResumptionError) {
      if (error.code === 'not_approved') {
        // Signed, and neither an approval nor a rejection.
        const payload = decodePayload(resumption.signature);
        const resolution = payload?.resolution;
        if (resolution === 'escalated') return { status: 'waiting', reason: 'escalated' };
        throw new GovernanceError(
          'unknown_resolution',
          payload === undefined
            ? 'The resolution of the signed Resumption could not be read; the thread stays paused.'
            : `The resolution ${JSON.stringify(resolution)} is not one this adapter acts on; the thread stays paused.`,
          { cause: error }
        );
      }
      const code = RESUMPTION_ERROR_CODES[error.code] ?? 'resumption_invalid';
      if (code === 'unresumable') await recordUnresumable(governance, approval, error.message);
      throw new GovernanceError(code, error.message, { cause: error });
    }
    throw error;
  }
  let claimed = false;
  // Verified: the graph is handed which approval was answered, and nothing else. The tool node reads the
  // answer, verifies it again and consumes it where the tool runs.
  try {
    const signed = correlationOf(verified);
    if (
      signed?.thread_id !== correlation.thread_id ||
      signed.checkpoint_ns !== correlation.checkpoint_ns ||
      signed.tool_call_id !== correlation.tool_call_id ||
      verified.approval_id !== approvalId
    ) {
      throw new GovernanceError(
        'resumption_invalid',
        'The signed Resumption does not name the approval and call it was read for.'
      );
    }

    if (verified.resolution === 'rejected' && governance.onRejected === 'halt') {
      await haltThread(graph, threadId, pause, state.values, correlation.tool_call_id, {
        ...reasonOf(approval),
      });
      return { status: 'halted', resolution: 'rejected' };
    }

    if (!coordinationOf(governance).claimResume(approvalId)) {
      throw new GovernanceError(
        'replayed',
        `Approval ${approvalId} was already handed to a graph by this process.`
      );
    }
    claimed = true;
    const result = await invokeResume(graph, threadId, pause, answered(approvalId));
    const held = heldBack(result, approvalId);
    if (held === 'retry') {
      // Nothing ran and nothing is spent for certain: not a resume. The thread is still paused on the
      // approval; the claim is released below, and the worker tries again.
      throw new GovernanceError(
        'unreachable',
        `Governance could not be reached while acting on approval ${approvalId}; the thread is still paused and the approval will be tried again.`
      );
    }
    if (held === 'gateway') {
      // A tool declared gateway-executed: the Resumption carries no `resume_token`, so nothing ran here and
      // the call is admitted by the gateway on the node's re-run. Not a resume, and not retried by the
      // worker (the same answer would come back): reported once.
      throw new GovernanceError(
        'unresumable',
        `Approval ${approvalId} is for a tool the gateway executes and carries nothing to consume; the thread is still paused, and the call is admitted when the node is re-run.`
      );
    }
    if (held !== undefined) {
      throw new GovernanceError(
        held === 'replayed' ? 'replayed' : 'consume_conflict',
        held === 'replayed'
          ? `Another attempt in this process acts on approval ${approvalId}; this one did not resume the thread.`
          : `Approval ${approvalId} was consumed by another attempt; this one did not run the tool.`
      );
    }
    return {
      status: 'resumed',
      resolution: verified.resolution === 'approved' ? 'approved' : 'rejected',
      result,
    };
  } catch (error) {
    // A typed failure is the adapter's own and says what it means; anything else that goes wrong after
    // the approval was spent on its call is the run's failure, and is not retried.
    // Nothing was spent: let a retry through. (A claim this call never took is not this call's to release.)
    if (claimed && !coordinationOf(governance).wasDispatched(approvalId))
      coordinationOf(governance).releaseResume(approvalId);
    if (
      !(error instanceof GovernanceError) &&
      coordinationOf(governance).wasDispatched(approvalId)
    ) {
      throw new GovernanceError(
        'resume_failed',
        `The run of thread ${threadId} failed after approval ${approvalId} was spent on its call: ${messageOf(error)}`,
        { cause: error }
      );
    }
    throw error;
  }
}

function reasonOf(approval: Approval): { reason?: string } {
  const history = approval.resolution_history ?? [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry?.resolution === 'rejected' && entry.reason !== undefined)
      return { reason: entry.reason };
  }
  return {};
}

/**
 * Ends the run after a rejection: every call of the model's message that has no answer yet is answered
 * with a denial, the rejected one with the approver's reason, and the thread is left where the tool node
 * would have left it. The graph is not resumed, so the model never sees a next turn.
 */
async function haltThread(
  graph: ResumableGraph,
  threadId: string,
  pause: Paused,
  values: unknown,
  rejectedCallId: string,
  rejection: { reason?: string }
): Promise<void> {
  const messages =
    isRecord(values) && Array.isArray(values.messages) ? (values.messages as unknown[]) : [];
  const answered = new Set(
    messages.flatMap((m) => (m instanceof ToolMessage ? [m.tool_call_id] : []))
  );
  const denials: ToolMessage[] = [];
  for (let i = messages.length - 1; i >= 0 && denials.length === 0; i -= 1) {
    const calls = (messages[i] as { tool_calls?: unknown } | undefined)?.tool_calls;
    if (!Array.isArray(calls) || !calls.some((c) => isRecord(c) && c.id === rejectedCallId))
      continue;
    for (const call of calls as Record<string, unknown>[]) {
      const id = typeof call.id === 'string' ? call.id : '';
      if (id === '' || answered.has(id)) continue;
      const name = typeof call.name === 'string' ? call.name : '';
      denials.push(
        id === rejectedCallId
          ? denialMessage(name, id, 'rejected', rejectedText(rejection.reason))
          : denialMessage(
              name,
              id,
              'rejected',
              'The run was halted because a call of this turn was rejected. The tool was not run.'
            )
      );
    }
  }
  await graph.updateState(
    { configurable: { thread_id: threadId } },
    { messages: denials } as never,
    pause.node
  );
}
