import type { ResumptionReplayGuard } from '@noblecloak/client';

/**
 * The default replay guard: remembers acted-on approvals in memory until they expire, and can forget
 * one, so a resume that failed before it did anything can be tried again in this process. One process;
 * across processes `/consume` is the atomic single use.
 */
export class ForgettingReplayGuard implements ResumptionReplayGuard {
  readonly #seen = new Map<string, number>();
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  firstUse(key: string, expiresAt: Date): boolean {
    const now = this.#now().getTime();
    for (const [seen, until] of this.#seen) if (until <= now) this.#seen.delete(seen);
    if (this.#seen.has(key)) return false;
    this.#seen.set(key, expiresAt.getTime());
    return true;
  }

  forget(key: string): void {
    this.#seen.delete(key);
  }
}

/** A guard that can also forget a key. */
export interface ForgettableGuard extends ResumptionReplayGuard {
  forget(key: string): void | Promise<void>;
}

export const isForgettable = (guard: ResumptionReplayGuard): guard is ForgettableGuard =>
  typeof (guard as Partial<ForgettableGuard>).forget === 'function';
