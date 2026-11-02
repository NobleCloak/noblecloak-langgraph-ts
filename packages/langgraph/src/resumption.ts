/** What both halves of the adapter read out of a Resumption: its continuation, and what a verification failure means. */
import type { GovernanceErrorCode } from './errors.js';
import type { Correlation } from './types.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The correlation of a langgraph continuation, or undefined when the payload carries no usable one. */
export function correlationOf(payload: {
  readonly continuation?: unknown;
}): Correlation | undefined {
  const continuation = payload.continuation;
  if (!isRecord(continuation) || continuation.kind !== 'langgraph') return undefined;
  const c = continuation.correlation;
  if (
    !isRecord(c) ||
    typeof c.thread_id !== 'string' ||
    typeof c.checkpoint_ns !== 'string' ||
    typeof c.tool_call_id !== 'string'
  ) {
    return undefined;
  }
  return { thread_id: c.thread_id, checkpoint_ns: c.checkpoint_ns, tool_call_id: c.tool_call_id };
}

/** The failure exit each verification failure of the client library maps to. */
export const RESUMPTION_ERROR_CODES: Record<string, GovernanceErrorCode> = {
  malformed: 'resumption_invalid',
  unsupported_alg: 'resumption_invalid',
  unknown_kid: 'resumption_invalid',
  bad_signature: 'resumption_invalid',
  expired: 'unresumable',
  not_approved: 'unknown_resolution',
  tool_mismatch: 'tool_mismatch',
  digest_mismatch: 'digest_mismatch',
  replayed: 'replayed',
};
