/** The values that cross the pause: what the node interrupts with, and what a resume hands back. */
/** What a governed call interrupts with. `approval_id` is absent on the `ask-locally` path. */
export interface GovernedInterrupt {
  readonly approval_id?: string;
  readonly tool_ref: string;
  readonly tool_call_id: string;
  readonly summary: string;
  /** True on the `ask-locally` path: no signed answer will exist. */
  readonly local?: true;
  /**
   * Set when this attempt lost a race on the approval (another attempt holds the replay guard, or consumed
   * it) and stepped aside: the node pauses again so that nothing is written into the thread over the
   * winner's result. `resumeApproval` reports it to its caller.
   */
  readonly lost?: 'replayed' | 'consumed';
  /**
   * Set when the answer could not be acted on right now because `/v1` could not be reached (a network
   * error, a 5xx, a 429 or 408 while reading the approval, reading its Resumption, fetching the key set or
   * consuming it) and nothing ran or was spent for certain. The node pauses again, so that no denial is
   * written into the thread over an approval that is still good; `resumeApproval` throws `unreachable`
   * and releases its claim, so a retry of the resume acts on the approval again.
   */
  readonly retry?: true;
  /**
   * Set when the tool is declared gateway-executed and the answered approval carries nothing to consume
   * here: the gateway admits the call on the node's re-run. The node pauses again, so that no denial is
   * written into the thread over an approval that is still good.
   */
  readonly gateway?: true;
}

/** The continuation's correlation: the three values identical on the first run and on the re-run. */
export interface Correlation {
  readonly thread_id: string;
  readonly checkpoint_ns: string;
  readonly tool_call_id: string;
}

/**
 * What `resumeApproval` hands to LangGraph: which approval was answered, and nothing else. The answer
 * itself (its state, the signed Resumption, the `resume_token`) is read from the server, by the tool
 * node, where the tool is about to run; nothing secret is written into the checkpoint.
 */
export interface ResumeValue {
  readonly kind: 'answered';
  readonly approval_id: string;
}

/**
 * The plain answer a driver resumes an `ask-locally` pause with. Nothing signs it, so the outcome record
 * says it was local and unverified.
 */
export type LocalAnswer = boolean | { readonly approved: boolean; readonly reason?: string };
