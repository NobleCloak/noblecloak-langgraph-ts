/**
 * A2: the worker lists and streams with created_by=me, and a service principal sees only the approvals it
 * created, so another principal's approval never reaches it: it neither stops the worker nor gets a record
 * from it. A 403 on the Resumption of an approval the worker lists is a misconfiguration and fails it.
 */
import { describe, expect, it } from 'vitest';

import { runResumer } from '../src/worker.js';
import { start } from './graph.js';
import { foreignApproval, ours, world } from './foreign.js';
import { sleep, until } from './wait.js';

describe('A2: another principal of the organisation does not stop or fail our worker', () => {
  it('a foreign pending approval at start-up: the worker starts, and resumes our own approval', async () => {
    const { h, counters, agent } = await world();
    await agent.invoke(start(), { configurable: { thread_id: 'mine' } });
    const mine = h.approvals()[0] ?? '';
    const theirs = await foreignApproval(h, 'theirs');
    expect(theirs).not.toBe('');
    const worker = await runResumer(agent, {
      governance: ours(h),
      reconcileIntervalMs: 20,
      pausedGraceMs: 200,
    });
    await h.approve(theirs);
    await h.approve(mine);
    await until(() => counters.runs.length === 1);
    await worker.stop();
    expect(h.mock.state.obligations.get(mine)?.state).toBe('consumed');
  });

  it('a foreign approval already resolved at start-up: the catch-up skips it, and the worker starts and resumes our own', async () => {
    const { h, counters, agent } = await world();
    await agent.invoke(start(), { configurable: { thread_id: 'mine' } });
    const mine = h.approvals()[0] ?? '';
    const theirs = await foreignApproval(h, 'theirs');
    await h.approve(theirs);
    await h.approve(mine);
    const worker = await runResumer(agent, {
      governance: ours(h),
      reconcileIntervalMs: 20,
      pausedGraceMs: 200,
    });
    await until(() => counters.runs.length === 1);
    await worker.stop();
    expect(h.mock.state.obligations.get(mine)?.state).toBe('consumed');
  });

  it('a foreign approval resolved while the worker runs: it keeps running and resumes our own', async () => {
    const { h, counters, agent } = await world();
    const worker = await runResumer(agent, { governance: ours(h), reconcileIntervalMs: 20 });
    let failed: string | undefined;
    void worker.failed.then((e) => {
      failed = e.code;
    });
    const theirs = await foreignApproval(h, 'theirs');
    await h.approve(theirs);
    await sleep(300);
    expect(failed).toBeUndefined();
    await agent.invoke(start(), { configurable: { thread_id: 'mine' } });
    const mine = h.approvals()[1] ?? '';
    await h.approve(mine);
    await until(() => counters.runs.length === 1);
    await worker.stop();
    expect(failed).toBeUndefined();
  });

  it('a foreign approval is reported nowhere and recorded nowhere', async () => {
    const { h, agent } = await world();
    const errors: string[] = [];
    const worker = await runResumer(agent, {
      governance: ours(h),
      reconcileIntervalMs: 20,
      onError: (e, id) => errors.push(`${e.code}@${id ?? ''}`),
    });
    const theirs = await foreignApproval(h, 'theirs');
    await h.approve(theirs);
    await sleep(300);
    await worker.stop();
    expect(errors).toEqual([]);
    expect(h.seen('POST', '/v1/records')).toHaveLength(0);
  });

  it('a 403 on the Resumption of an approval of ours fails the worker loudly at start-up, with a foreign approval beside it', async () => {
    const { h, agent } = await world();
    await agent.invoke(start(), { configurable: { thread_id: 'mine' } });
    const mine = h.approvals()[0] ?? '';
    await foreignApproval(h, 'theirs');
    await h.approve(mine);
    h.intercept = (request) =>
      new URL(request.url).pathname === `/v1/approvals/${mine}/resumption`
        ? new Response(
            JSON.stringify({
              type: 'https://docs.noblecloak.com/problems/not_owner',
              title: 'x',
              status: 403,
              request_id: 'r',
            }),
            { status: 403, headers: { 'content-type': 'application/problem+json' } }
          )
        : undefined;
    await expect(
      runResumer(agent, { governance: ours(h), reconcileIntervalMs: 0 })
    ).rejects.toMatchObject({ code: 'not_owner' });
    // The foreign approval was never read.
    expect(h.seen('GET', /\/resumption$/).map((r) => r.path)).toEqual([
      `/v1/approvals/${mine}/resumption`,
    ]);
  });

  it('a 403 found while running (the first approval of ours it reads) stops the worker and says so', async () => {
    const { h, agent } = await world();
    const worker = await runResumer(agent, { governance: ours(h), reconcileIntervalMs: 20 });
    await agent.invoke(start(), { configurable: { thread_id: 'mine' } });
    const mine = h.approvals()[0] ?? '';
    h.intercept = (request) =>
      new URL(request.url).pathname === `/v1/approvals/${mine}/resumption`
        ? new Response(
            JSON.stringify({
              type: 'https://docs.noblecloak.com/problems/not_owner',
              title: 'x',
              status: 403,
              request_id: 'r',
            }),
            { status: 403, headers: { 'content-type': 'application/problem+json' } }
          )
        : undefined;
    await h.approve(mine);
    const failure = await Promise.race([worker.failed, sleep(3000).then(() => undefined)]);
    expect(failure).toMatchObject({ code: 'not_owner' });
    await worker.stop();
  });

  it('a worker run as another principal of the organisation sees none of our approvals: it starts, resumes nothing, and reads no Resumption', async () => {
    const { h, counters, agent } = await world();
    await agent.invoke(start(), { configurable: { thread_id: 'mine' } });
    const mine = h.approvals()[0] ?? '';
    await h.approve(mine);
    const stranger = h.anotherGovernance({ getToken: () => h.tokens.creator_user });
    stranger.registerTool('send_email', 'ext:local:send_email');
    const worker = await runResumer(agent, { governance: stranger, reconcileIntervalMs: 20 });
    await sleep(200);
    await worker.stop();
    expect(h.seen('GET', /\/resumption$/)).toHaveLength(0);
    expect(counters.runs).toHaveLength(0);
    expect(h.mock.state.obligations.get(mine)?.state).toBe('approved');
  });
});
