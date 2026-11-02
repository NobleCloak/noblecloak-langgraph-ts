/**
 * The coordination state of one adapter: which approvals this process handed to a graph or spent, and the
 * slots of the calls of a task. Internal: reachable from the package's own
 * modules through `coordinationOf` (governance.ts) and not exported from the package entry point.
 */

/** What a call of a task decided, once it knows: whether it holds the approval slot, and whether it pauses the node. */
interface Settled {
  /** The call needs approval and is the earliest in the message that does: every later one that needs it is denied. */
  readonly claimed: boolean;
  /**
   * The call interrupts the node. A claimant that resumed is settled only once its outcome is known: after
   * `/consume` succeeded or a denial was decided (not pausing), or when it stepped aside (pausing).
   */
  readonly pausing: boolean;
}

/** One governed call's place in its task: the ordering that decides which call may pause, and whether the others may run. */
export interface TaskSlot {
  /** Resolves true when a call earlier in the task holds the approval slot. */
  lowerClaimed(): Promise<boolean>;
  /** Resolves true when some other call of the task pauses the node: then no call of the task runs on this pass (D-LG14). */
  siblingsPause(): Promise<boolean>;
  /** Called once the call's decision is known. Idempotent. */
  settle(claimed: boolean, pausing?: boolean): void;
}

interface SlotState {
  readonly position: number;
  readonly settled: Promise<Settled>;
  readonly resolve: (settled: Settled) => void;
  done: boolean;
}

interface Group {
  readonly slots: Map<string, SlotState>;
  sequence: number;
}

const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

export class Coordination {
  readonly #dispatched = new Map<string, number>();
  readonly #handedOver = new Map<string, number>();
  readonly #groups = new Map<string, Group>();

  /** Notes that the approval has been spent on its call (consumed, or handed to the gateway). */
  markDispatched(approvalId: string): void {
    const now = Date.now();
    for (const [id, at] of this.#dispatched)
      if (now - at > 24 * 3600 * 1000) this.#dispatched.delete(id);
    this.#dispatched.set(approvalId, now);
  }

  /**
   * Claims the approval for one hand-over to a graph in this process. False when this process already
   * handed it over (a duplicate stream event, a reconcile racing the stream): the second does not
   * resume the thread again. This is not the replay guard, which the tool node applies where the tool
   * runs; it only keeps one process from resuming one thread twice for one answer.
   */
  claimResume(approvalId: string): boolean {
    const now = Date.now();
    for (const [id, at] of this.#handedOver)
      if (now - at > 24 * 3600 * 1000) this.#handedOver.delete(id);
    if (this.#handedOver.has(approvalId)) return false;
    this.#handedOver.set(approvalId, now);
    return true;
  }

  /** Lets go of a claim whose hand-over failed before anything ran, so a retry can get through. */
  releaseResume(approvalId: string): void {
    this.#handedOver.delete(approvalId);
  }

  /** Whether this process spent the approval on its call: after that, a failed resume is not a retryable one. */
  wasDispatched(approvalId: string): boolean {
    return this.#dispatched.has(approvalId);
  }

  /**
   * Registers a governed call in its task. Calls of one task run together. The one earliest in the model's
   * message that needs approval holds the slot and the others that need it are denied (D-LG11); order is
   * the position in the message, so the choice does not depend on which answer arrives first. If any call
   * of the task will pause the node, no call of the task runs on this pass (D-LG14): a pass that pauses
   * the node is re-run from the top when it resumes, so a call that ran on it would run again. The
   * coordination lives here, in the slot every call of the task shares, so it holds for `governed` used
   * alone inside a stock `ToolNode`.
   */
  enterTask(taskKey: string, callId: string, position: number | undefined): TaskSlot {
    let group = this.#groups.get(taskKey);
    if (group === undefined) {
      group = { slots: new Map(), sequence: 0 };
      this.#groups.set(taskKey, group);
    }
    const mine = group;
    let resolve!: (settled: Settled) => void;
    const settled = new Promise<Settled>((r) => {
      resolve = r;
    });
    const own = position ?? mine.sequence;
    mine.sequence += 1;
    const slot: SlotState = { position: own, settled, resolve, done: false };
    mine.slots.set(callId, slot);
    // Every call of the task is started in one pass; one turn of the event loop lets them all enter.
    const others = async (earlier: boolean): Promise<Settled[]> => {
      await yieldToEventLoop();
      return Promise.all(
        [...mine.slots.entries()]
          .filter(([id, other]) => id !== callId && (!earlier || other.position < slot.position))
          .map(([, other]) => other.settled)
      );
    };
    return {
      lowerClaimed: async () => (await others(true)).some((s) => s.claimed),
      siblingsPause: async () => (await others(false)).some((s) => s.pausing),
      settle: (claimed, pausing = false) => {
        if (slot.done) return;
        slot.done = true;
        slot.resolve({ claimed, pausing });
        if ([...mine.slots.values()].every((s) => s.done) && this.#groups.get(taskKey) === mine) {
          this.#groups.delete(taskKey);
        }
      },
    };
  }
}
