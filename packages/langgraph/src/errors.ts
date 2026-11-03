/** The failure exits of the adapter. Every one fails closed: nothing runs, the thread stays paused or is denied. */
export type GovernanceErrorCode =
  /** Bad signature, unknown `kid`, unsupported algorithm, or a Resumption that is not well formed. */
  | 'resumption_invalid'
  /** The Resumption names a different tool than the paused call. */
  | 'tool_mismatch'
  /** The digest of the checkpointed arguments differs from the approved digest. */
  | 'digest_mismatch'
  /** This Resumption was already acted on. */
  | 'replayed'
  /** `/consume` answered 409: the arguments changed, or the approval was already consumed. */
  | 'consume_conflict'
  /** The approval was answered but there is nothing to resume: the thread, the checkpoint or the continuation is gone. */
  | 'unresumable'
  /** The resolution is none of `approved`, `rejected` and `escalated`. The thread stays paused. */
  | 'unknown_resolution'
  /** The deployment routes approvals but does not serve `runs`. */
  | 'runs_required'
  /** A second call in the same task needs approval while another is pending. */
  | 'approval_pending_in_task'
  /** `/v1` could not be reached, answered 5xx, or answered something unreadable. */
  | 'unreachable'
  /** `/v1` refused a request the adapter expected it to accept (an unexpected 4xx). */
  | 'api_error'
  /** The Resumption read answered 403: this principal did not create the approval. */
  | 'not_owner'
  /**
   * The server returned no continuation for a `langgraph` approval, and the caller named no thread. The
   * caller is not the principal that created the approval, or the deployment predates contract v1 rev 4
   * and echoes none. Not fatal to the worker: that approval is reported once and left alone.
   */
  | 'continuation_unavailable'
  /**
   * `expectedPrincipal` is set and the principal this process runs as is a different one. A worker run as
   * another principal than the agent sees none of the agent's approvals (a service principal sees only
   * the approvals it created), so it would start cleanly and resume nothing.
   */
  | 'principal_mismatch'
  /** `expectedPrincipal` is set and the principal this process runs as could not be learned: the check cannot be made. */
  | 'principal_unavailable'
  /** The resumed run failed after the approval was spent on the call (consumed, or dispatched through the gateway). Not retried. */
  | 'resume_failed'
  /** The outcome record could not be appended after the tool ran. */
  | 'record_failed'
  /** Policy asks for approval and the deployment cannot route one (`whenUnroutable: 'deny'`). */
  | 'unroutable'
  /**
   * The call is for a tool the deployment executes, wrapped here as a local function: this process has
   * nothing to consume and must not run it. Either a `step_up` whose approval handle says no `resume_token`
   * will issue (denied before anyone is asked to approve), or an `allow` that carries an approval handle
   * (the gateway admits the call by an approval nothing here consumes; denied after the approver acted).
   */
  | 'not_locally_executable'
  /**
   * `governanceMiddleware` handed the tool to the rest of the middleware chain for one governed call, and
   * something downstream (a retry middleware, say) invoked it a second time. The approval was spent on the
   * first invocation; the second is refused without running the tool.
   */
  | 'tool_reinvoked'
  /**
   * `governanceMiddleware` handed the tool to the rest of the middleware chain and the chain returned
   * without ever invoking it. The approval was spent; the outcome is recorded as failed.
   */
  | 'tool_not_executed'
  /** A tool declared gateway-executed was called without an external run (no thread_id, or a deployment that serves no runs). Denied before any decision. */
  | 'run_required';

/** A typed adapter failure. `code` is the stable part; the message is for people. */
export class GovernanceError extends Error {
  readonly code: GovernanceErrorCode;

  constructor(code: GovernanceErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'GovernanceError';
    this.code = code;
  }
}

/** Whether `error` says the principal this process runs as is not the expected one, or cannot be checked. */
export function isPrincipalFailure(error: unknown): boolean {
  return (
    error instanceof GovernanceError &&
    (error.code === 'principal_mismatch' || error.code === 'principal_unavailable')
  );
}

/** The message of any thrown value. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What a denial returned to the model carries: a failure exit, or one of the two answers that are not failures. */
export type DenialCode =
  | GovernanceErrorCode
  | 'denied'
  | 'rejected'
  /** An open approval for this exact call is tracked under a different continuation. */
  | 'continuation_conflict';
