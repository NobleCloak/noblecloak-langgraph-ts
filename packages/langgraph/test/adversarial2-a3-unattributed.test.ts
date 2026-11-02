/** A3: the worker never writes a record, or reports a failure, for an approval it cannot attribute to this deployment. */
import { describe, expect, it } from 'vitest';

import { runResumer } from '../src/worker.js';
import { start } from './graph.js';
import { foreignApproval, ours, world } from './foreign.js';
import { sleep } from './wait.js';

describe('A3: the worker never writes a record for an approval it cannot attribute', () => {
  it("another principal's withdrawn approval gets no unresumable record and no report", async () => {
    const { h, agent } = await world();
    await agent.invoke(start(), { configurable: { thread_id: 'mine' } });
    const mine = h.approvals()[0] ?? '';
    await h.approve(mine);
    const theirs = await foreignApproval(h, 'theirs');
    const withdrawn = await h.as(h.tokens.creator_user, 'POST', `/v1/approvals/${theirs}/withdraw`);
    expect(withdrawn.status).toBe(200);
    const errors: string[] = [];
    const worker = await runResumer(agent, {
      governance: ours(h),
      reconcileIntervalMs: 50,
      notPausedRetryMs: 100,
      onError: (e, id) => errors.push(`${e.code}@${id === theirs ? 'THEIRS' : (id ?? '')}`),
    });
    await sleep(600);
    await worker.stop();
    expect(errors.filter((e) => e.endsWith('@THEIRS'))).toEqual([]);
    expect(
      h.mock.state.records.filter((r: { approval_id?: string }) => r.approval_id === theirs)
    ).toEqual([]);
    // It never reached the worker: the listing and the stream are asked for with created_by=me.
    expect(h.seen('GET', new RegExp(theirs))).toEqual([]);
  });
});
