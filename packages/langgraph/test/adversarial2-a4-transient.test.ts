/**
 * A4: a transient failure inside the re-entry chain (read the approval, read its Resumption, fetch the key
 * set, consume it) writes no denial into the thread and is not reported as a resume. The node pauses again,
 * `resumeApproval` throws `unreachable` and releases its claim, and the retry runs the tool exactly once.
 */
import { ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';

import { resumeApproval } from '../src/resume.js';
import { governedToolNode } from '../src/governed.js';
import { runResumer } from '../src/worker.js';
import type { ResumeOutcome } from '../src/resume.js';
import { ask, buildGraph, call, makeTools, start, TOOL_REFS } from './graph.js';
import type { Counters } from './graph.js';
import { createHarness, status } from './harness.js';
import type { Harness } from './harness.js';
import { until } from './wait.js';

const CFG = { configurable: { thread_id: 't1' } };

async function paused() {
  const h = await createHarness();
  const counters: Counters = { runs: [] };
  const graph = buildGraph({
    script: [ask(call('c1', 'send_email', { to: 'a@b.c' }))],
    toolNode: governedToolNode([makeTools(counters).sendEmail], {
      toolRefs: TOOL_REFS,
      governance: h.governance,
    }),
  });
  await graph.invoke(start(), CFG);
  const id = h.approvals()[0] ?? '';
  const worker = h.anotherGovernance();
  worker.registerTool('send_email', 'ext:local:send_email');
  return { h, counters, graph, id, worker };
}

const toolMessages = async (graph: ReturnType<typeof buildGraph>): Promise<ToolMessage[]> =>
  ((await graph.getState(CFG)).values as { messages: BaseMessage[] }).messages.filter(
    (m): m is ToolMessage => m instanceof ToolMessage
  );

const isPaused = async (graph: ReturnType<typeof buildGraph>): Promise<boolean> =>
  (await graph.getState(CFG)).tasks.some((t) => t.interrupts.length > 0);

const KINDS = {
  '429': () => status(429),
  '503': () => status(503),
  'a dropped connection': () => {
    throw new TypeError('fetch failed');
  },
} as const;

const TARGETS = {
  'reading the approval': (r: Request) =>
    r.method === 'GET' && /\/v1\/approvals\/[^/]+$/.test(new URL(r.url).pathname),
  'reading its Resumption': (r: Request) =>
    r.method === 'GET' && new URL(r.url).pathname.endsWith('/resumption'),
  'fetching the key set': (r: Request) => new URL(r.url).pathname === '/.well-known/jwks.json',
  'consuming it': (r: Request) => new URL(r.url).pathname.endsWith('/consume'),
} as const;

/** Fails the first request of the node's re-entry chain (everything after the re-run's `/decisions`) that matches. */
function failOnceInNode(h: Harness, matches: (r: Request) => boolean, fail: () => Response): void {
  let inNode = false;
  let failed = false;
  h.intercept = (request) => {
    const path = new URL(request.url).pathname;
    if (request.method === 'POST' && path === '/v1/decisions') inNode = true;
    if (inNode && !failed && matches(request)) {
      failed = true;
      return fail();
    }
    return undefined;
  };
}

describe('A4: a transient failure in the re-entry chain leaves the approval good and the thread unwritten', () => {
  for (const [kind, fail] of Object.entries(KINDS)) {
    for (const [target, matches] of Object.entries(TARGETS)) {
      it(`${kind} while ${target}: nothing is written, the resume is reported as unreachable, the retry runs the tool once`, async () => {
        const { h, counters, graph, id, worker } = await paused();
        await h.approve(id);
        failOnceInNode(h, matches, fail);
        await expect(resumeApproval(graph, id, { governance: worker })).rejects.toMatchObject({
          code: 'unreachable',
        });
        // Nothing ran, nothing was written, the approval is still good, and the thread is still paused on it.
        expect(counters.runs).toHaveLength(0);
        expect(await toolMessages(graph)).toHaveLength(0);
        expect(await isPaused(graph)).toBe(true);
        expect(h.mock.state.obligations.get(id)?.state).toBe('approved');
        // The retry, as the worker would make it.
        const outcome = await resumeApproval(graph, id, { governance: worker });
        expect(outcome).toMatchObject({ status: 'resumed', resolution: 'approved' });
        expect(counters.runs).toHaveLength(1);
        expect(h.mock.state.obligations.get(id)?.state).toBe('consumed');
        const messages = await toolMessages(graph);
        expect(messages.map((m) => m.content)).toEqual(['sent to a@b.c']);
        expect(h.mock.state.records).toHaveLength(1);
        expect(h.approvals()).toHaveLength(1);
      });
    }
  }

  it('the worker retries on its own and onResumed fires once, at the end', async () => {
    const { h, counters, graph, id, worker } = await paused();
    await h.approve(id);
    failOnceInNode(h, TARGETS['consuming it'], KINDS['429']);
    const resumed: [string, ResumeOutcome][] = [];
    const errors: string[] = [];
    const handle = await runResumer(graph, {
      governance: worker,
      reconcileIntervalMs: 30,
      pausedGraceMs: 200,
      onResumed: (approvalId, outcome) => resumed.push([approvalId, outcome]),
      onError: (e) => errors.push(e.code),
    });
    await until(() => counters.runs.length === 1);
    await until(() => resumed.length >= 1);
    await handle.stop();
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.[1]).toMatchObject({ status: 'resumed', resolution: 'approved' });
    expect(errors).toContain('unreachable');
    expect(h.mock.state.obligations.get(id)?.state).toBe('consumed');
    // No second approval, so no continuation_conflict anywhere.
    expect(h.approvals()).toHaveLength(1);
  });

  it('a consume whose answer is lost after the server consumed it: the retry finds it consumed, runs nothing, and says so', async () => {
    const { h, counters, graph, id, worker } = await paused();
    await h.approve(id);
    let inNode = false;
    let dropped = false;
    h.intercept = async (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === 'POST' && path === '/v1/decisions') inNode = true;
      if (inNode && !dropped && path.endsWith('/consume')) {
        dropped = true;
        await h.mock.app.fetch(request.clone());
        throw new TypeError('socket hang up');
      }
      return undefined;
    };
    await expect(resumeApproval(graph, id, { governance: worker })).rejects.toMatchObject({
      code: 'unreachable',
    });
    expect(h.mock.state.obligations.get(id)?.state).toBe('consumed');
    await expect(resumeApproval(graph, id, { governance: worker })).rejects.toBeDefined();
    // At most once: the tool did not run, and nothing was written over the thread.
    expect(counters.runs).toHaveLength(0);
    expect(await toolMessages(graph)).toHaveLength(0);
  });
});
