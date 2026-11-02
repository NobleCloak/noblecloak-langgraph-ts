/** A6: a worker that stops for a fatal reason says so through `onFatal`, without the builder awaiting `failed`. */
import { describe, expect, it } from 'vitest';

import type { GovernanceError } from '../src/errors.js';
import { runResumer } from '../src/worker.js';
import { start } from './graph.js';
import { ours, world } from './foreign.js';
import type { Harness } from './harness.js';
import { sleep, until } from './wait.js';

/** The server refuses the Resumption of `approvalId` with 403 not_owner: it disagrees about who created it. */
const refuse = (h: Harness, approvalId: string): void => {
  h.intercept = (request) =>
    new URL(request.url).pathname === `/v1/approvals/${approvalId}/resumption`
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
};

describe('A6: onFatal', () => {
  it('is called once with not_owner when the worker stops itself, and failed resolves with the same error', async () => {
    const { h, agent } = await world();
    const fatal: GovernanceError[] = [];
    const worker = await runResumer(agent, {
      governance: ours(h),
      reconcileIntervalMs: 20,
      onFatal: (e) => fatal.push(e),
    });
    await agent.invoke(start(), { configurable: { thread_id: 'mine' } });
    refuse(h, h.approvals()[0] ?? '');
    await h.approve(h.approvals()[0] ?? '');
    await until(() => fatal.length === 1);
    await sleep(100);
    expect(fatal).toHaveLength(1);
    expect(fatal[0]?.code).toBe('not_owner');
    expect(await worker.failed).toBe(fatal[0]);
    await worker.stop();
  });

  it('a throwing onFatal does not break the worker, and failed still resolves', async () => {
    const { h, agent } = await world();
    const worker = await runResumer(agent, {
      governance: ours(h),
      reconcileIntervalMs: 20,
      onFatal: () => {
        throw new Error('callback bug');
      },
    });
    await agent.invoke(start(), { configurable: { thread_id: 'mine' } });
    refuse(h, h.approvals()[0] ?? '');
    await h.approve(h.approvals()[0] ?? '');
    expect(await worker.failed).toMatchObject({ code: 'not_owner' });
    await worker.stop();
  });

  it('is not called for a worker that is stopped', async () => {
    const { h, agent } = await world();
    const governance = h.anotherGovernance();
    governance.registerTool('send_email', 'ext:local:send_email');
    let called = false;
    const worker = await runResumer(agent, {
      governance,
      reconcileIntervalMs: 0,
      onFatal: () => {
        called = true;
      },
    });
    await worker.stop();
    expect(called).toBe(false);
  });
});
