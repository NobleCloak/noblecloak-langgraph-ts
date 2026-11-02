/** Opens an approval on the mock, approves it, and verifies its Resumption through a governance object. */
import { argDigest } from '@noblecloak/client';
import type { ResumptionPayload } from '@noblecloak/client';

import type { Governance } from '../src/governance.js';
import type { Harness } from './harness.js';

export async function verifyViaMock(
  harness: Harness,
  governance: Governance
): Promise<ResumptionPayload> {
  const args = { to: 'x@y.z' };
  const decided = await harness.as(harness.tokens.creator, 'POST', '/v1/decisions', {
    action: { tool_ref: 'ext:local:send_email', arguments: args },
    continuation: {
      kind: 'langgraph',
      delivery: 'pull',
      correlation: { thread_id: 't', checkpoint_ns: '', tool_call_id: 'c' },
    },
  });
  const body = (await decided.json()) as { data: { approval: { id: string } } };
  const id = body.data.approval.id;
  await harness.approve(id);
  const read = await harness.as(harness.tokens.creator, 'GET', `/v1/approvals/${id}/resumption`);
  const resumption = ((await read.json()) as { data: { signature: string } }).data;
  return governance.verify(
    resumption.signature,
    { tool_ref: 'ext:local:send_email', arg_digest: await argDigest(args) },
    {}
  );
}
