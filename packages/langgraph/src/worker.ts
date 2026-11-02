/** `waitAndResume` for scripts and `runResumer` for deployments: both end in `resumeApproval`. */
import type { Approval } from './api.js';
import { GovernanceError, isPrincipalFailure, messageOf } from './errors.js';
import { resumeApproval } from './resume.js';
import type { ResumableGraph, ResumeOptions, ResumeOutcome } from './resume.js';

export interface WaitOptions extends Omit<ResumeOptions, 'threadId'> {
  /** Seconds of each long poll, 1 to 55. Default 30. */
  readonly pollSeconds?: number;
  readonly signal?: AbortSignal;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * For scripts: finds the approval the thread is paused on, long-polls it until it leaves `pending`, and
 * resumes. An `escalated` answer is not final; the wait continues.
 */
export async function waitAndResume(
  graph: ResumableGraph,
  config: { configurable: { thread_id: string } },
  options: WaitOptions
): Promise<ResumeOutcome> {
  const threadId = config.configurable.thread_id;
  const state = await graph.getState(config);
  let approvalId: string | undefined;
  for (const task of state.tasks) {
    for (const pending of task.interrupts) {
      if (isRecord(pending.value) && typeof pending.value.approval_id === 'string') {
        approvalId ??= pending.value.approval_id;
      }
    }
  }
  if (approvalId === undefined) {
    throw new GovernanceError('unresumable', `Thread ${threadId} is not paused on an approval.`);
  }
  const seconds = Math.min(Math.max(Math.trunc(options.pollSeconds ?? 30), 1), 55);
  for (;;) {
    options.signal?.throwIfAborted();
    const outcome = await resumeApproval(graph, approvalId, { ...options, threadId });
    if (outcome.status !== 'waiting') return outcome;
    const waited = await options.governance.api.waitApproval(approvalId, seconds, options.signal);
    if (!waited.ok) {
      throw new GovernanceError(
        'api_error',
        `Waiting for ${approvalId} answered ${String(waited.problem.status)} ${waited.problem.code}`
      );
    }
  }
}

export interface ResumerOptions extends Omit<ResumeOptions, 'threadId'> {
  /**
   * The id of the principal this worker must run as, normally the principal the agent runs as. The `sub`
   * of the access token is compared with it before the worker does anything else, and again on every token
   * the worker obtains from `getToken`. At start-up a different one rejects `runResumer` with
   * `principal_mismatch`, and a token whose `sub` cannot be read rejects it with `principal_unavailable`.
   * Later, either one stops the running worker: `onFatal` is called with the error and `failed` resolves
   * with it, because a worker that is no longer the principal it was configured to be would resume
   * nothing, or the approvals of another principal. (A worker run as another principal than the agent sees
   * none of the agent's approvals, starts cleanly and resumes nothing.)
   */
  readonly expectedPrincipal?: string;
  /**
   * Called once when start-up has succeeded, with the principal the worker runs as (the `sub` claim of
   * its access token; undefined when the token carries none). Without it the principal is logged once
   * with `console.info`. Compare it with the principal `onApprovalOpened` reports on the agent side.
   */
  readonly onReady?: (ready: { readonly principal: string | undefined }) => void;
  /** Called with a failure of one approval, or of the stream. The loop goes on. */
  readonly onError?: (error: GovernanceError, approvalId?: string) => void;
  /**
   * Called once, with the failure, when the worker stops itself because it cannot work: the Resumption of
   * an approval it lists as its own answers 403 (`not_owner`). Start-up failures
   * are not reported here: `runResumer` rejects. Set this to learn that the worker is no longer running
   * without awaiting `failed`; the worker never restarts itself. Not called for a worker stopped by `stop()`.
   */
  readonly onFatal?: (error: GovernanceError) => void;
  /** Called after an approval's thread was resumed, or halted by a rejection. */
  readonly onResumed?: (approvalId: string, outcome: ResumeOutcome) => void;
  /** First wait before a stream reconnect, doubling to `maxBackoffMs`. Default 500. */
  readonly backoffMs?: number;
  /** Longest wait before a stream reconnect. Default 30000. */
  readonly maxBackoffMs?: number;
  /**
   * How long a stream has to stay open (or deliver an event) before the reconnect backoff starts over from
   * `backoffMs`. A server that accepts the stream and closes it at once is therefore reconnected, and the
   * approvals reconciled, at ever longer intervals up to `maxBackoffMs`, not every `backoffMs`. Default 10000.
   */
  readonly streamStableMs?: number;
  /** How often to reconcile while the stream is open, in milliseconds; 0 turns it off. Default 30000. */
  readonly reconcileIntervalMs?: number;
  /**
   * Approvals resolved longer ago than this are not reconciled. The age is that of the resolution, not of
   * the approval: one that waited a long time for its answer is still caught up. The listing is read back
   * as far as an approval can have waited for it (twice this). Default seven days.
   */
  readonly maxAgeMs?: number;
  /**
   * How far back a consumed approval is looked at, to find a thread that is still paused on it (the
   * process died between the consume and the checkpoint write). Default 24 hours.
   */
  readonly consumedMaxAgeMs?: number;
  /**
   * How long an approval whose thread does not show the pause, or is not in this worker's checkpoint
   * store at all, is retried, counted from the first time it was seen so. The agent can be answered before
   * it has checkpointed its pause; every reconcile looks again. After this long the worker gives up on it
   * and reports it; an approval whose thread was not found in the store is then also recorded as
   * unresumable, once. Default five minutes.
   */
  readonly notPausedRetryMs?: number;
}

export interface ResumerHandle {
  /** Stops following the stream and waits for the approvals in flight. */
  stop(): Promise<void>;
  /**
   * Resolves with the failure when the worker stopped itself because it cannot work: the Resumption of an
   * approval it lists as its own answers 403 (`not_owner`), and nothing yet showed otherwise.
   * It never resolves for a worker that is stopped by `stop()`. The same failure is handed to
   * `onFatal`, for a supervisor that does not await this promise; either tells it the worker is no longer
   * resuming anything and has to be restarted with the right credentials.
   */
  readonly failed: Promise<GovernanceError>;
}

/** The members of `ResumeOptions` the worker's options carry: nothing of the worker's own is forwarded to `resumeApproval`. */
const resumeOptionsOf = (options: ResumerOptions): Omit<ResumeOptions, 'threadId'> => ({
  governance: options.governance,
  ...(options.pausedGraceMs === undefined ? {} : { pausedGraceMs: options.pausedGraceMs }),
});

const RESOLVED_STATES = ['approved', 'rejected', 'expired', 'withdrawn'] as const;
/** Consumed approvals are reconciled too, with a window and a grace of their own (see `reconcile`). */
const RECONCILED_STATES = [...RESOLVED_STATES, 'consumed'] as const;
const TRANSIENT = new Set(['unreachable', 'api_error']);

/** Reads the data of every `approval.updated` event of an SSE body. */
async function* events(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onBadFrame: (data: string) => void
): AsyncGenerator {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const abort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  // A stop that came before the listener existed would otherwise leave the read waiting for ever.
  if (signal.aborted) abort();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let end = buffer.indexOf('\n\n');
      while (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf('\n\n');
        let event = 'message';
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trim());
        }
        if (event !== 'approval.updated' || data.length === 0) continue;
        try {
          yield JSON.parse(data.join('\n')) as unknown;
        } catch {
          // A frame that is not JSON is not an event: it is dropped, and reported.
          onBadFrame(data.join('\n').slice(0, 200));
        }
      }
    }
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

/** Whether the signal has been aborted since the last time it was read. */
const isAborted = (signal: AbortSignal): boolean => signal.aborted;

const delay = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

/**
 * The worker. It authenticates as the agent's own service principal, because only the principal that
 * created an approval can read its Resumption. It opens the stream, reconciles the approvals resolved
 * while no worker was listening (the stream has no replay), then follows the stream, reconnecting with
 * backoff and reconciling again on each reconnect. One approval's failure never stops the loop.
 *
 * Rejects at start-up when the deployment cannot be used (`runs_required`), the stream cannot be opened, or
 * the Resumption of an approval it lists answers 403 (`not_owner`). The listing and the stream are asked for
 * with `created_by=me`, so every approval the worker sees is one its principal created. A worker that stops
 * itself while running calls `onFatal` and resolves `failed`.
 */
export async function runResumer(
  graph: ResumableGraph,
  options: ResumerOptions
): Promise<ResumerHandle> {
  const { governance } = options;
  const controller = new AbortController();
  const { signal } = controller;
  const inflight = new Map<string, Promise<void>>();
  // Approvals this process is done with, and when: bounded by `maxAgeMs`, past which nothing reconciles them.
  const settled = new Map<string, number>();
  const notPausedSince = new Map<string, number>();
  // When an approval's thread was first found missing from this worker's checkpoint store. Looked at
  // again at every reconcile for the retry window, then recorded as unresumable (see `resumeApproval`).
  const noThreadSince = new Map<string, number>();
  // When a consumed approval was first seen consumed: a thread still paused on it is the crash this looks
  // for only once the consumer has had the retry window to checkpoint (another process may be running the
  // tool right now, and looks the same until it does).
  const consumedSince = new Map<string, number>();
  const retryWindow = options.notPausedRetryMs ?? 5 * 60 * 1000;
  const background = new Set<Promise<unknown>>();
  // Whether anything has shown that this principal can read the Resumptions of the approvals it lists.
  // Until then a `not_owner` answer means the worker is mis-set, and it stops rather than run unable to do
  // its job. (The listing and the stream carry only approvals this principal created, so a 403 on one of
  // them is the server disagreeing with the worker's credentials.)
  let ownershipConfirmed = false;
  // Set once the worker has stopped itself: `onFatal` is called once and nothing is processed after.
  let fatalRaised = false;
  // Read through a function: set by a closure TypeScript cannot see assign.
  const hasFailed = (): boolean => fatalRaised;
  let fail!: (error: GovernanceError) => void;
  const failed = new Promise<GovernanceError>((resolve) => {
    fail = resolve;
  });
  // The worker stops itself: `failed` resolves, `onFatal` is called once, the loops end.
  const stopFatally = (error: GovernanceError): void => {
    if (fatalRaised) return;
    fatalRaised = true;
    controller.abort();
    fail(error);
    try {
      options.onFatal?.(error);
    } catch {
      // The builder's callback is not ours to propagate.
    }
  };
  const maxAge = options.maxAgeMs ?? 7 * 24 * 3600 * 1000;
  const report = (error: GovernanceError, approvalId?: string): void => {
    if (options.onError === undefined) governance.report(error, approvalId);
    else {
      try {
        options.onError(error, approvalId);
      } catch {
        // The builder's callback is not ours to propagate.
      }
    }
  };

  const notifyResumed = (approvalId: string, outcome: ResumeOutcome): void => {
    try {
      options.onResumed?.(approvalId, outcome);
    } catch {
      // The builder's callback is not ours to propagate.
    }
  };

  const settle = (approvalId: string): void => {
    const now = Date.now();
    for (const [id, at] of settled) if (now - at > maxAge) settled.delete(id);
    notPausedSince.delete(approvalId);
    noThreadSince.delete(approvalId);
    consumedSince.delete(approvalId);
    settled.set(approvalId, now);
  };

  /** A thread that does not show the pause is looked at again until the retry window is spent. */
  const settleNotPaused = (approvalId: string): void => {
    const now = Date.now();
    const first = notPausedSince.get(approvalId) ?? now;
    notPausedSince.set(approvalId, first);
    if (now - first < retryWindow) return;
    settle(approvalId);
    report(
      new GovernanceError(
        'unresumable',
        `The approval ${approvalId} was answered but its thread never showed the pause; the worker gave up on it.`
      ),
      approvalId
    );
  };

  // `graceMs` overrides the pause grace: a reconcile reads approvals that were resolved long ago, whose
  // pause is either in the checkpoint now or never will be, so it looks once and does not wait.
  const process = (approvalId: string, failFast: boolean, graceMs?: number): Promise<void> => {
    // A worker that stopped itself looks at nothing more: its answer would be the same.
    if (hasFailed() || settled.has(approvalId)) return Promise.resolve();
    const running = inflight.get(approvalId);
    if (running !== undefined) return running;
    const work = (async (): Promise<void> => {
      try {
        // A thread that is not in the checkpoint store yet is looked at again until the retry window,
        // counted from the first look, has passed; only then is the approval recorded as unresumable.
        const outcome = await resumeApproval(graph, approvalId, {
          ...resumeOptionsOf(options),
          ...(graceMs === undefined ? {} : { pausedGraceMs: graceMs }),
          noThreadRetryUntil: (noThreadSince.get(approvalId) ?? Date.now()) + retryWindow,
        });
        if (outcome.status === 'resumed' || outcome.status === 'halted') {
          ownershipConfirmed = true;
          notifyResumed(approvalId, outcome);
        }
        if (outcome.status === 'skipped' && outcome.reason === 'no_thread')
          noThreadSince.set(approvalId, noThreadSince.get(approvalId) ?? Date.now());
        else if (outcome.status === 'skipped' && outcome.reason === 'not_paused')
          settleNotPaused(approvalId);
        else if (outcome.status !== 'waiting') settle(approvalId);
      } catch (error) {
        const typed =
          error instanceof GovernanceError
            ? error
            : new GovernanceError(
                'api_error',
                `Resuming ${approvalId} failed: ${messageOf(error)}`,
                {
                  cause: error,
                }
              );
        if (failFast && (typed.code === 'not_owner' || isPrincipalFailure(typed))) throw typed;
        // `not_owner` is never settled: it is a fact about this process, not about the approval, and it
        // is said again at every look until the principal is fixed. `continuation_unavailable` is settled
        // and reported once: the continuation is fixed when the approval is created, so looking again
        // later returns the same answer (a restart reads it afresh, for a deployment upgraded since).
        if (!TRANSIENT.has(typed.code) && typed.code !== 'not_owner') settle(approvalId);
        report(typed, approvalId);
        // The principal is no longer the expected one (or cannot be checked): nothing this worker does
        // from here is the work it was configured for.
        if (isPrincipalFailure(typed)) stopFatally(typed);
        else if (typed.code === 'not_owner' && !ownershipConfirmed) {
          // The listing showed this approval as this principal's own, and its Resumption is refused: nothing
          // here can work.
          stopFatally(typed);
        }
      } finally {
        inflight.delete(approvalId);
      }
    })();
    inflight.set(approvalId, work);
    return work;
  };

  let reconciling: Promise<void> | undefined;
  const consumedMaxAge = options.consumedMaxAgeMs ?? 24 * 3600 * 1000;
  const timeOf = (row: Approval): number =>
    Date.parse(row.resolved_at ?? row.expires_at ?? row.created_at);
  const reconcile = (failFast: boolean): Promise<void> => {
    reconciling ??= (async () => {
      try {
        const now = Date.now();
        for (const state of RECONCILED_STATES) {
          const cutoff = now - (state === 'consumed' ? consumedMaxAge : maxAge);
          let cursor: string | undefined;
          for (;;) {
            const page = await governance.api.listApprovals(state, cursor);
            if (!page.ok) {
              throw new GovernanceError(
                'api_error',
                `Listing ${state} approvals answered ${String(page.problem.status)} ${page.problem.code}`
              );
            }
            let reachedOld = false;
            for (const row of page.data.rows) {
              // The list is newest-created first. An approval can wait as long as `maxAge` for its answer, so
              // the listing is read back that much further than the resolutions that count.
              if (Date.parse(row.created_at) < cutoff - maxAge) {
                reachedOld = true;
                break;
              }
              if (timeOf(row) < cutoff) continue;
              // The list has no filter on the continuation's kind: it is applied here.
              if (row.continuation_kind !== 'langgraph') continue;
              if (state === 'consumed') {
                const first = consumedSince.get(row.id) ?? now;
                consumedSince.set(row.id, first);
                if (now - first < retryWindow) continue;
              }
              await process(row.id, failFast, 0);
            }
            if (reachedOld || page.data.next === null) break;
            cursor = page.data.next;
          }
        }
      } finally {
        reconciling = undefined;
      }
    })();
    return reconciling;
  };

  // Whether the stream being followed has delivered an event (see `streamStableMs`).
  let delivered = false;
  const hasDelivered = (): boolean => delivered;
  const follow = async (body: ReadableStream<Uint8Array>): Promise<void> => {
    for await (const event of events(body, signal, (frame) => {
      report(
        new GovernanceError(
          'unreachable',
          `An approval.updated frame was not JSON and was dropped: ${frame}`
        )
      );
    })) {
      delivered = true;
      if (!isRecord(event)) continue;
      const approval = event as Partial<Approval>;
      if (
        typeof approval.id === 'string' &&
        approval.continuation_kind === 'langgraph' &&
        approval.state !== undefined &&
        (RESOLVED_STATES as readonly string[]).includes(approval.state)
      ) {
        const work = process(approval.id, false);
        background.add(work);
        void work.finally(() => background.delete(work));
      }
    }
  };

  // Reports the principal this worker runs as, once start-up has succeeded.
  const announce = async (): Promise<void> => {
    let principal: string | undefined;
    try {
      principal = await governance.principal();
    } catch {
      principal = undefined;
    }
    try {
      if (options.onReady !== undefined) options.onReady({ principal });
      else
        console.info(
          `[@noblecloak/langgraph] resumer started as principal ${principal ?? '(unknown)'}; it resumes only the approvals this principal created.`
        );
    } catch {
      // The builder's callback is not ours to propagate.
    }
  };

  // Start-up: the principal must be the expected one, the deployment must be usable, the stream must open,
  // and the catch-up must read.
  if (options.expectedPrincipal !== undefined)
    await governance.assertPrincipal(options.expectedPrincipal);
  await governance.assertReady();
  let body = await governance.api.stream(signal);
  try {
    await reconcile(true);
  } catch (error) {
    controller.abort();
    throw error;
  }
  await announce();

  const interval = options.reconcileIntervalMs ?? 30_000;
  const timer =
    interval > 0
      ? setInterval(() => {
          void reconcile(false).catch((error: unknown) => {
            if (error instanceof GovernanceError && isPrincipalFailure(error)) {
              stopFatally(error);
              return;
            }
            report(
              error instanceof GovernanceError
                ? error
                : new GovernanceError('api_error', `Reconcile failed: ${messageOf(error)}`, {
                    cause: error,
                  })
            );
          });
        }, interval)
      : undefined;
  timer?.unref();

  const loop = (async (): Promise<void> => {
    const base = options.backoffMs ?? 500;
    const ceiling = options.maxBackoffMs ?? 30_000;
    const stableMs = options.streamStableMs ?? 10_000;
    let wait = base;
    let first = true;
    while (!isAborted(signal)) {
      let openedAt: number | undefined;
      try {
        if (!first) {
          body = await governance.api.stream(signal);
          await reconcile(false);
        }
        first = false;
        openedAt = Date.now();
        delivered = false;
        await follow(body);
      } catch (error) {
        if (isAborted(signal)) break;
        if (error instanceof GovernanceError && isPrincipalFailure(error)) {
          stopFatally(error);
          break;
        }
        report(
          error instanceof GovernanceError
            ? error
            : new GovernanceError(
                'unreachable',
                `The approval stream failed: ${messageOf(error)}`,
                {
                  cause: error,
                }
              )
        );
        first = false;
      }
      if (isAborted(signal)) break;
      // Opening the stream is not a recovery: only a stream that stayed open, or carried an event, is.
      if (openedAt !== undefined && (hasDelivered() || Date.now() - openedAt >= stableMs))
        wait = base;
      await delay(wait, signal);
      wait = Math.min(wait * 2, ceiling);
    }
  })();

  return {
    failed,
    async stop(): Promise<void> {
      controller.abort();
      if (timer !== undefined) clearInterval(timer);
      await loop;
      await Promise.allSettled([...background, ...inflight.values(), reconciling]);
    },
  };
}
