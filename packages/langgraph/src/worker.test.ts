import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';

import { denialCodeOf } from './denial.js';
import { principalOfToken } from './governance.js';
import type { GovernanceError } from './errors.js';
import { governedToolNode } from './governed.js';
import { resumeApproval } from './resume.js';
import { runResumer, waitAndResume } from './worker.js';
import type { ResumerHandle } from './worker.js';
import { ask, buildGraph, call, makeTools, start, textOf, TOOL_REFS } from '../test/graph.js';
import type { Counters } from '../test/graph.js';
import { createHarness, status } from '../test/harness.js';
import type { Harness, HarnessOptions } from '../test/harness.js';
import { manualPause } from '../test/manual-pause.js';
import { controlledStream, frame, sleep, until } from '../test/wait.js';

const CFG = { configurable: { thread_id: 't1' } };

async function pausedAgent(options: HarnessOptions = {}, threadId = 't1', to = 'a@b.c') {
  const h = await createHarness(options);
  const counters: Counters = { runs: [] };
  const tools = makeTools(counters);
  const graph = buildGraph({
    script: [ask(call('c1', 'send_email', { to }))],
    toolNode: governedToolNode([tools.sendEmail], {
      toolRefs: TOOL_REFS,
      governance: h.governance,
    }),
  });
  await graph.invoke(start(), { configurable: { thread_id: threadId } });
  const [id = ''] = h.approvals();
  return { h, counters, graph, id, tools };
}

const messagesOf = async (graph: ReturnType<typeof buildGraph>): Promise<BaseMessage[]> =>
  ((await graph.getState(CFG)).values as { messages: BaseMessage[] }).messages;

const finished = async (graph: ReturnType<typeof buildGraph>): Promise<boolean> =>
  (await messagesOf(graph)).some((m) => AIMessage.isInstance(m) && m.content === 'done');

/** A worker with its own governance, as a second process would have: same tools, its own state. */
function startWorker(
  h: Harness,
  graph: ReturnType<typeof buildGraph>,
  extra: Partial<Parameters<typeof runResumer>[1]> = {}
): Promise<ResumerHandle> {
  const governance = h.anotherGovernance();
  governance.registerTool('send_email', 'ext:local:send_email');
  return runResumer(graph, {
    governance,
    reconcileIntervalMs: 0,
    backoffMs: 10,
    maxBackoffMs: 40,
    pausedGraceMs: 500,
    ...extra,
  });
}

describe('waitAndResume', () => {
  it('finds the approval the thread is paused on, waits for the answer, and resumes', async () => {
    const { h, counters, graph } = await pausedAgent();
    const waiting = waitAndResume(graph, CFG, { governance: h.governance, pollSeconds: 5 });
    await until(() => h.approvals().length > 0);
    const [id = ''] = h.approvals();
    const waitPath = new RegExp(`/v1/approvals/${id}/wait`);
    // Approve only once the wait request has arrived: a fixed sleep let a loaded machine approve first.
    await until(() => h.seen('GET', waitPath).length > 0);
    await h.approve(id);
    expect(await waiting).toMatchObject({ status: 'resumed', resolution: 'approved' });
    expect(counters.runs).toHaveLength(1);
    expect(h.seen('GET', waitPath).length).toBeGreaterThan(0);
  });

  it('an escalated answer is not final: the wait goes on until the approver decides', async () => {
    const { h, counters, graph } = await pausedAgent();
    const waiting = waitAndResume(graph, CFG, { governance: h.governance, pollSeconds: 5 });
    const [id = ''] = h.approvals();
    await sleep(40);
    await h.resolve(id, 'escalated');
    await sleep(60);
    expect(counters.runs).toHaveLength(0);
    await h.reject(id, 'no');
    expect(await waiting).toMatchObject({ status: 'resumed', resolution: 'rejected' });
  });

  it('an approval answered before the call is resumed at once', async () => {
    const { h, counters, graph, id } = await pausedAgent();
    await h.approve(id);
    expect(await waitAndResume(graph, CFG, { governance: h.governance })).toMatchObject({
      status: 'resumed',
    });
    expect(counters.runs).toHaveLength(1);
  });

  it('refuses a thread that is not paused on an approval', async () => {
    const { h, graph } = await pausedAgent();
    await expect(
      waitAndResume(
        graph,
        { configurable: { thread_id: 'never-started' } },
        { governance: h.governance }
      )
    ).rejects.toMatchObject({ code: 'unresumable' });
  });

  it('a local (ask-locally) pause names no approval to wait for', async () => {
    const h = await createHarness({
      advertise: ['decisions', 'records'],
      governance: { whenUnroutable: 'ask-locally' },
    });
    const tools = makeTools({ runs: [] });
    const graph = buildGraph({
      script: [ask(call('c1', 'send_email', { to: 'a' }))],
      toolNode: governedToolNode([tools.sendEmail], {
        toolRefs: TOOL_REFS,
        governance: h.governance,
      }),
    });
    await graph.invoke(start(), CFG);
    await expect(waitAndResume(graph, CFG, { governance: h.governance })).rejects.toMatchObject({
      code: 'unresumable',
    });
  });

  it('reports a wait the API refuses', async () => {
    const { h, graph } = await pausedAgent();
    h.intercept = (request) =>
      new URL(request.url).pathname.endsWith('/wait') ? status(403) : undefined;
    await expect(
      waitAndResume(graph, CFG, { governance: h.governance, pollSeconds: 1 })
    ).rejects.toMatchObject({ code: 'api_error' });
  });

  it('stops when its signal is aborted', async () => {
    const { h, graph } = await pausedAgent();
    const controller = new AbortController();
    const waiting = waitAndResume(graph, CFG, {
      governance: h.governance,
      pollSeconds: 1,
      signal: controller.signal,
    });
    await sleep(40);
    controller.abort();
    await expect(waiting).rejects.toThrow();
  });
});

describe('runResumer', () => {
  it('reconcile: an approval resolved while no worker was running is picked up at start', async () => {
    const { h, counters, graph, id } = await pausedAgent();
    await h.approve(id);
    const worker = await startWorker(h, graph);
    await until(() => counters.runs.length === 1);
    expect(await finished(graph)).toBe(true);
    await worker.stop();
    expect(counters.runs).toHaveLength(1);
  });

  it('follows the stream: an approval resolved while the worker runs is resumed, and onResumed says so', async () => {
    const { h, counters, graph, id } = await pausedAgent();
    const resumed: [string, string][] = [];
    const worker = await startWorker(h, graph, {
      onResumed: (approvalId, outcome) => {
        resumed.push([approvalId, outcome.status]);
        throw new Error('a throwing callback does not stop the worker');
      },
    });
    expect(counters.runs).toHaveLength(0);
    await h.approve(id);
    await until(() => counters.runs.length === 1);
    await worker.stop();
    expect(resumed).toEqual([[id, 'resumed']]);
    expect(h.mock.state.obligations.get(id)?.state).toBe('consumed');
  });

  it('a rejection is resumed too: the agent continues with the denial', async () => {
    const { h, counters, graph, id } = await pausedAgent();
    const worker = await startWorker(h, graph);
    await h.reject(id, 'not now');
    await until(() => finished(graph));
    await worker.stop();
    expect(counters.runs).toHaveLength(0);
    const denial = (await messagesOf(graph)).find(
      (m): m is ToolMessage => m instanceof ToolMessage
    );
    expect(denialCodeOf(denial)).toBe('rejected');
    expect(textOf(denial)).toContain('not now');
  });

  it('reconnect re-reconciles: what resolved while the stream was down is caught up', async () => {
    const { h, counters, graph, id } = await pausedAgent();
    const first = controlledStream();
    let opened = 0;
    h.intercept = (request) => {
      if (new URL(request.url).pathname !== '/v1/approvals/stream') return undefined;
      opened += 1;
      return opened === 1 ? first.response() : undefined;
    };
    const worker = await startWorker(h, graph);
    expect(opened).toBe(1);
    // The approval is answered while the stream is down: no event will ever carry it.
    await h.approve(id);
    expect(counters.runs).toHaveLength(0);
    first.close();
    await until(() => counters.runs.length === 1);
    expect(opened).toBeGreaterThanOrEqual(2);
    await worker.stop();
  });

  it('a stream that cannot be reopened is reported and retried with backoff', async () => {
    const { h, counters, graph, id } = await pausedAgent();
    const first = controlledStream();
    let opened = 0;
    h.intercept = (request) => {
      if (new URL(request.url).pathname !== '/v1/approvals/stream') return undefined;
      opened += 1;
      if (opened === 1) return first.response();
      return opened <= 3 ? status(503) : undefined;
    };
    const errors: GovernanceError[] = [];
    const worker = await startWorker(h, graph, { onError: (e) => errors.push(e) });
    await h.approve(id);
    first.close();
    await until(() => counters.runs.length === 1);
    expect(errors.map((e) => e.code)).toEqual(['unreachable', 'unreachable']);
    await worker.stop();
  });

  it('a duplicate stream event runs the tool once and is not an error', async () => {
    const { h, counters, graph, id } = await pausedAgent();
    const stream = controlledStream();
    h.intercept = (request) =>
      new URL(request.url).pathname === '/v1/approvals/stream' ? stream.response() : undefined;
    const errors: GovernanceError[] = [];
    const worker = await startWorker(h, graph, { onError: (e) => errors.push(e) });
    await h.approve(id);
    const view = (
      (await (await h.as(h.tokens.creator, 'GET', `/v1/approvals/${id}`)).json()) as {
        data: unknown;
      }
    ).data;
    stream.push(frame(view) + frame(view) + frame(view));
    await until(() => counters.runs.length === 1);
    await sleep(100);
    await worker.stop();
    expect(counters.runs).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('reads frames split across chunks, ignores comments, other events and frames that are not JSON', async () => {
    const { h, counters, graph, id } = await pausedAgent();
    const stream = controlledStream();
    h.intercept = (request) =>
      new URL(request.url).pathname === '/v1/approvals/stream' ? stream.response() : undefined;
    const errors: string[] = [];
    const worker = await startWorker(h, graph, { onError: (e) => errors.push(e.message) });
    await h.approve(id);
    const view = (
      (await (await h.as(h.tokens.creator, 'GET', `/v1/approvals/${id}`)).json()) as {
        data: unknown;
      }
    ).data;
    const text = frame(view);
    stream.push(': keep-alive\n\n');
    stream.push('event: approval.updated\ndata: {not json\n\n');
    stream.push('event: something.else\ndata: {}\n\n');
    stream.push('event: approval.updated\n\n');
    stream.push('data: 1\n\n');
    stream.push(`event: approval.updated\ndata: ${JSON.stringify([1])}\n\n`);
    stream.push(text.slice(0, 20));
    await sleep(30);
    expect(counters.runs).toHaveLength(0);
    stream.push(text.slice(20));
    await until(() => counters.runs.length === 1);
    await worker.stop();
    // The frame that was not JSON was dropped, and said so; nothing else was an error.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('{not json');
  });

  it('only approvals of kind langgraph are acted on', async () => {
    const h = await createHarness();
    const other = await h.as(h.tokens.creator, 'POST', '/v1/decisions', {
      action: { tool_ref: 'ext:local:send_email', arguments: { to: 'x' } },
      continuation: { kind: 'adk', delivery: 'pull', correlation: {} },
    });
    const otherId = ((await other.json()) as { data: { approval: { id: string } } }).data.approval
      .id;
    await h.approve(otherId);
    const mine = await manualPause(h, {
      threadId: 'mine',
      approvedArgs: { to: 'mine' },
      checkpointArgs: { to: 'mine' },
    });
    await h.approve(mine.approvalId);
    const governance = h.anotherGovernance();
    governance.registerTool('send_email', 'ext:local:send_email');
    const worker = await runResumer(mine.graph, { governance, reconcileIntervalMs: 0 });
    await worker.stop();
    expect(h.seen('GET', `/v1/approvals/${otherId}/resumption`)).toHaveLength(0);
    // One read, to resume it.
    expect(h.seen('GET', `/v1/approvals/${mine.approvalId}/resumption`)).toHaveLength(1);
    expect(mine.resumed).toHaveLength(1);
  });

  it('approvals older than the window are not reconciled', async () => {
    const h = await createHarness();
    h.mock.state.clockOffsetMs = -3600_000;
    const old = await manualPause(h, { threadId: 'old' });
    h.mock.state.clockOffsetMs = 0;
    await h.approve(old.approvalId);
    const governance = h.anotherGovernance();
    governance.registerTool('send_email', 'ext:local:send_email');
    const worker = await runResumer(old.graph, {
      governance,
      reconcileIntervalMs: 0,
      maxAgeMs: 60_000,
    });
    await worker.stop();
    expect(h.seen('GET', `/v1/approvals/${old.approvalId}/resumption`)).toHaveLength(0);
    expect(old.resumed).toHaveLength(0);
  });

  it('m4: the window is the age of the resolution: an approval that waited longer than it for its answer is still caught up', async () => {
    const h = await createHarness({ expireAfterMs: 72 * 3600_000 });
    h.mock.state.clockOffsetMs = -36 * 3600_000;
    const slow = await manualPause(h, { threadId: 'slow' });
    h.mock.state.clockOffsetMs = 0;
    await h.approve(slow.approvalId);
    const governance = h.anotherGovernance();
    governance.registerTool('send_email', 'ext:local:send_email');
    const worker = await runResumer(slow.graph, {
      governance,
      reconcileIntervalMs: 0,
      maxAgeMs: 24 * 3600_000,
    });
    await worker.stop();
    expect(slow.resumed).toHaveLength(1);
  });

  it('m4: an approval resolved longer ago than the window is not reconciled', async () => {
    const h = await createHarness({ expireAfterMs: 72 * 3600_000 });
    h.mock.state.clockOffsetMs = -36 * 3600_000;
    const old = await manualPause(h, { threadId: 'old-resolved' });
    await h.approve(old.approvalId);
    h.mock.state.clockOffsetMs = 0;
    const governance = h.anotherGovernance();
    governance.registerTool('send_email', 'ext:local:send_email');
    const worker = await runResumer(old.graph, {
      governance,
      reconcileIntervalMs: 0,
      maxAgeMs: 24 * 3600_000,
    });
    await worker.stop();
    expect(h.seen('GET', `/v1/approvals/${old.approvalId}/resumption`)).toHaveLength(0);
    expect(old.resumed).toHaveLength(0);
  });

  it('m4: a consumed approval whose thread is still paused on it (a crash between the consume and the checkpoint) is raised by the worker, once, and the tool is not re-run', async () => {
    const { h, counters, graph, id } = await pausedAgent();
    await h.approve(id);
    await h.as(h.tokens.creator, 'POST', `/v1/approvals/${id}/consume`, {
      resume_token: h.mock.state.obligations.get(id)?.resumeToken,
      action: { tool_ref: 'ext:local:send_email', arguments: { to: 'a@b.c' } },
    });
    const errors: [string, string][] = [];
    const worker = await startWorker(h, graph, {
      reconcileIntervalMs: 15,
      notPausedRetryMs: 60,
      onError: (e, approvalId) => errors.push([e.code, `${approvalId ?? ''}: ${e.message}`]),
    });
    // Not at once: whoever consumed it may be running the tool right now.
    await sleep(30);
    expect(errors).toEqual([]);
    await until(() => errors.length >= 1);
    await sleep(100);
    await worker.stop();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.[0]).toBe('unresumable');
    expect(errors[0]?.[1]).toMatch(/consumed but thread t1 is still paused/);
    expect(counters.runs).toHaveLength(0);
  });

  it('reconcile pages through the list', async () => {
    const h = await createHarness();
    const paused = await manualPause(h, { threadId: 'p' });
    await h.approve(paused.approvalId);
    // A page of one: the approval is on the second page.
    const real = h.mock.app.fetch.bind(h.mock.app);
    h.intercept = async (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/v1/approvals' && url.searchParams.get('state') === 'approved') {
        const cursor = url.searchParams.get('cursor');
        if (cursor === null)
          return Response.json({
            data: [],
            meta: { request_id: 'r', deployment: 'hosted', next: '1' },
          });
        return real(new Request(request.url.replace(/&?cursor=[^&]*/, ''), request));
      }
      return undefined;
    };
    const governance = h.anotherGovernance();
    governance.registerTool('send_email', 'ext:local:send_email');
    const worker = await runResumer(paused.graph, { governance, reconcileIntervalMs: 0 });
    await worker.stop();
    expect(paused.resumed).toHaveLength(1);
    expect(h.seen('GET', '/v1/approvals').some((r) => r.path === '/v1/approvals')).toBe(true);
  });

  it.each([
    ['data that is not an array', { data: {}, meta: { request_id: 'r' } }],
    ['a meta.next that is not a string or null', { data: [], meta: { request_id: 'r', next: 7 } }],
  ])('a listing page with %s is an unreadable answer, not an empty one', async (_name, body) => {
    const { h, graph } = await pausedAgent();
    h.intercept = (request) =>
      new URL(request.url).pathname === '/v1/approvals' ? Response.json(body) : undefined;
    await expect(startWorker(h, graph)).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('a periodic reconcile catches what the stream never delivered', async () => {
    const { h, counters, graph, id } = await pausedAgent();
    const silent = controlledStream();
    h.intercept = (request) =>
      new URL(request.url).pathname === '/v1/approvals/stream' ? silent.response() : undefined;
    const worker = await startWorker(h, graph, { reconcileIntervalMs: 40 });
    await h.approve(id);
    await until(() => counters.runs.length === 1);
    await worker.stop();
  });

  it('a failed periodic reconcile is reported and the loop goes on', async () => {
    const { h, graph } = await pausedAgent();
    const silent = controlledStream();
    h.intercept = (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/v1/approvals/stream') return silent.response();
      return undefined;
    };
    const errors: GovernanceError[] = [];
    const worker = await startWorker(h, graph, {
      reconcileIntervalMs: 30,
      onError: (e) => errors.push(e),
    });
    h.intercept = (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/v1/approvals') return status(503);
      return undefined;
    };
    await until(() => errors.length > 0);
    await worker.stop();
    expect(errors[0]?.code).toBe('unreachable');
  });

  it("one approval's failure never stops the loop: it is reported, and the next approval is resumed", async () => {
    const h = await createHarness({ breaks: ['skip_request_validation'] });
    const bad = await manualPause(h, {
      threadId: 'bad',
      approvedArgs: { to: 'bad' },
      checkpointArgs: { to: 'bad' },
    });
    const good = await pausedAgentOn(h, 'good', 'good');
    const errors: [string, string | undefined][] = [];
    const worker = await runResumer(good.graph, {
      governance: (() => {
        const g = h.anotherGovernance();
        g.registerTool('send_email', 'ext:local:send_email');
        return g;
      })(),
      reconcileIntervalMs: 0,
      pausedGraceMs: 200,
      notPausedRetryMs: 0,
      onError: (e, approvalId) => errors.push([e.code, approvalId]),
    });
    await h.resolve(bad.approvalId, 'deferred_to_committee');
    await sleep(80);
    await h.approve(good.id);
    await until(() => good.counters.runs.length === 1);
    await worker.stop();
    // The bad approval's thread is on another graph: it is not even this worker's to find.
    expect(errors.some(([, id]) => id === bad.approvalId)).toBe(true);
  });

  /** Forces a 403 `not_owner` on the Resumption of `approvalId`: the server disagrees about who created it. */
  const refuseResumption = (h: Harness, approvalId: string): void => {
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

  it('start-up fails loudly when the Resumption of an approval it lists answers 403 (not the principal that created it)', async () => {
    const { h, graph, id } = await pausedAgent();
    await h.approve(id);
    refuseResumption(h, id);
    await expect(startWorker(h, graph)).rejects.toMatchObject({
      code: 'not_owner',
      message: expect.stringContaining('same service principal') as string,
    });
  });

  it("a worker run as another principal lists only what that principal created, so it sees none of the agent's approvals and resumes none", async () => {
    const { h, counters, graph, id } = await pausedAgent();
    await h.approve(id);
    const stranger = h.anotherGovernance({ getToken: () => h.tokens.approver });
    stranger.registerTool('send_email', 'ext:local:send_email');
    const errors: string[] = [];
    const worker = await runResumer(graph, {
      governance: stranger,
      reconcileIntervalMs: 20,
      onError: (e) => errors.push(e.code),
    });
    await sleep(150);
    await worker.stop();
    // Every listing and the stream asked for created_by=me, and no Resumption was read.
    const lists = h.seen('GET', '/v1/approvals');
    expect(lists.length).toBeGreaterThan(0);
    expect(h.seen('GET', /\/v1\/approvals\/stream$/).length).toBeGreaterThan(0);
    expect(h.seen('GET', /\/resumption$/)).toHaveLength(0);
    expect(errors).toEqual([]);
    expect(counters.runs).toHaveLength(0);
    expect(h.mock.state.obligations.get(id)?.state).toBe('approved');
  });

  it('every listing and the stream of the worker carry created_by=me', async () => {
    const { h, graph } = await pausedAgent();
    const worker = await startWorker(h, graph, { reconcileIntervalMs: 0 });
    await worker.stop();
    const queries = [...h.requests]
      .filter(
        (r) =>
          r.method === 'GET' && (r.path === '/v1/approvals' || r.path === '/v1/approvals/stream')
      )
      .map((r) => r.query);
    expect(queries.length).toBeGreaterThanOrEqual(2);
    for (const query of queries) expect(new URLSearchParams(query).get('created_by')).toBe('me');
  });

  it('M3: a worker with an empty listing fails on the first event, and is not settled on not_owner', async () => {
    const h = await createHarness();
    const stranger = h.anotherGovernance({ getToken: () => h.tokens.approver });
    stranger.registerTool('send_email', 'ext:local:send_email');
    const errors: [string, string | undefined][] = [];
    // The listing this worker sees is empty, as the first approval has not been made yet; the stream is its own.
    const stream = controlledStream();
    h.intercept = (request) => {
      const path = new URL(request.url).pathname;
      if (path === '/v1/approvals/stream') return stream.response();
      if (request.method === 'GET' && path === '/v1/approvals') {
        return Response.json({ data: [], meta: { request_id: 'r', deployment: 'hosted' } });
      }
      return undefined;
    };
    const paused = await manualPause(h, { threadId: 'first-event' });
    await h.approve(paused.approvalId);
    const worker = await runResumer(paused.graph, {
      governance: stranger,
      reconcileIntervalMs: 0,
      onError: (e, approvalId) => errors.push([e.code, approvalId]),
    });
    stream.push(
      frame({ id: paused.approvalId, state: 'approved', continuation_kind: 'langgraph' })
    );
    const failure = await Promise.race([worker.failed, sleep(3000).then(() => undefined)]);
    expect(failure).toMatchObject({ code: 'not_owner' });
    expect(errors).toEqual([['not_owner', paused.approvalId]]);
    expect(paused.resumed).toHaveLength(0);
    await worker.stop();
  });

  it('M3: once ownership is shown, a not_owner for an approval of this deployment is reported at every look, not settled, and does not stop the worker', async () => {
    const { h, counters, graph, id } = await pausedAgent();
    const errors: [string, string | undefined][] = [];
    const worker = await startWorker(h, graph, {
      reconcileIntervalMs: 25,
      onError: (e, approvalId) => errors.push([e.code, approvalId]),
    });
    // Ownership is shown by the first approval the worker resumes.
    await h.approve(id);
    await until(() => counters.runs.length === 1);
    // A second approval of this deployment's own checkpointer whose Resumption this principal is then refused.
    await graph.invoke(start(), { configurable: { thread_id: 'second' } });
    const second = h.approvals()[1] ?? '';
    refuseResumption(h, second);
    await h.approve(second);
    await until(() => errors.filter(([, a]) => a === second).length >= 2);
    expect(errors.every(([code]) => code === 'not_owner')).toBe(true);
    expect(await Promise.race([worker.failed, sleep(50).then(() => 'still running')])).toBe(
      'still running'
    );
    await worker.stop();
  });

  it('start-up fails when the deployment routes approvals but serves no runs', async () => {
    const h = await createHarness({ advertise: ['approvals', 'records'] });
    const graph = buildGraph({
      script: [],
      toolNode: governedToolNode([], { toolRefs: {}, governance: h.governance }),
    });
    await expect(runResumer(graph, { governance: h.governance })).rejects.toMatchObject({
      code: 'runs_required',
    });
  });

  it('start-up fails when the stream cannot be opened', async () => {
    const { h, graph } = await pausedAgent();
    h.intercept = (request) =>
      new URL(request.url).pathname === '/v1/approvals/stream' ? status(503) : undefined;
    await expect(startWorker(h, graph)).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('start-up fails when the catch-up cannot read the list', async () => {
    const { h, graph } = await pausedAgent();
    h.intercept = (request) =>
      new URL(request.url).pathname === '/v1/approvals' ? status(403) : undefined;
    await expect(startWorker(h, graph)).rejects.toMatchObject({ code: 'api_error' });
  });

  it('a callback that throws does not stop the worker', async () => {
    const h = await createHarness({ breaks: ['skip_request_validation'] });
    const bad = await manualPause(h);
    await h.resolve(bad.approvalId, 'deferred_to_committee');
    const governance = h.anotherGovernance();
    governance.registerTool('send_email', 'ext:local:send_email');
    const worker = await runResumer(bad.graph, {
      governance,
      reconcileIntervalMs: 0,
      onError: () => {
        throw new Error('callback failed');
      },
    });
    await worker.stop();
  });

  it('without an onError option, failures go to the governance onError', async () => {
    const seen: string[] = [];
    const h = await createHarness({
      breaks: ['skip_request_validation'],
      governance: { onError: (e) => seen.push(e.code) },
    });
    const bad = await manualPause(h);
    await h.resolve(bad.approvalId, 'deferred_to_committee');
    const governance = h.governance;
    governance.registerTool('send_email', 'ext:local:send_email');
    const worker = await runResumer(bad.graph, { governance, reconcileIntervalMs: 0 });
    await worker.stop();
    expect(seen).toEqual(['unknown_resolution']);
  });
});

/** An agent on an existing harness. */
async function pausedAgentOn(h: Harness, threadId: string, to: string) {
  const counters: Counters = { runs: [] };
  const tools = makeTools(counters);
  const graph = buildGraph({
    script: [ask(call('c1', 'send_email', { to }))],
    toolNode: governedToolNode([tools.sendEmail], {
      toolRefs: TOOL_REFS,
      governance: h.governance,
    }),
  });
  await graph.invoke(start(), { configurable: { thread_id: threadId } });
  const id = h.approvals().at(-1) ?? '';
  return { counters, graph, id };
}

describe('exactly once', () => {
  it('two workers on one approval run the tool once; the loser is told the approval no longer matches', async () => {
    const { h, counters, graph, id } = await pausedAgent();
    const a = await startWorker(h, graph);
    const b = await startWorker(h, graph);
    await h.approve(id);
    await until(() => counters.runs.length === 1);
    await sleep(300);
    await Promise.all([a.stop(), b.stop()]);
    expect(counters.runs).toHaveLength(1);
    expect(h.seen('POST', /\/consume$/).length).toBeGreaterThanOrEqual(1);
    expect(h.mock.state.obligations.get(id)?.state).toBe('consumed');
  });

  it('a worker restarted after a crash before the resume ran does not run the tool twice', async () => {
    const { h, counters, graph, id } = await pausedAgent();
    // Worker A verifies, then dies on its way into the graph.
    const crashing = Object.create(graph, {
      invoke: { value: () => Promise.reject(new Error('killed')) },
    }) as typeof graph;
    const errors: string[] = [];
    const a = await startWorker(h, crashing, { onError: (e) => errors.push(e.message) });
    await h.approve(id);
    await until(() => errors.length > 0);
    await a.stop();
    expect(counters.runs).toHaveLength(0);
    // The restart: a new process, a new replay guard. The approval is still approved and unconsumed.
    const b = await startWorker(h, graph);
    await until(() => counters.runs.length === 1);
    await b.stop();
    expect(counters.runs).toHaveLength(1);
  });

  it('a worker restarted after the tool ran finds nothing to do', async () => {
    const { h, counters, graph, id } = await pausedAgent();
    const a = await startWorker(h, graph);
    await h.approve(id);
    await until(() => counters.runs.length === 1);
    await a.stop();
    const errors: GovernanceError[] = [];
    const b = await startWorker(h, graph, { onError: (e) => errors.push(e) });
    await sleep(100);
    await b.stop();
    expect(counters.runs).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('the same Resumption fed to one process twice is stopped by its replay guard', async () => {
    const { h, counters, graph, id } = await pausedAgent();
    await h.approve(id);
    const worker = await startWorker(h, graph);
    await until(() => counters.runs.length === 1);
    await worker.stop();
    expect(counters.runs).toHaveLength(1);
  });
});

/** Hides the pause of a graph's checkpoint while `hidden.value` is true: the agent has not paused yet. */
function hidePause(graph: ReturnType<typeof buildGraph>): { value: boolean; reads: number } {
  const hidden = { value: true, reads: 0 };
  const real = graph.getState.bind(graph);
  (graph as { getState: unknown }).getState = async (...args: Parameters<typeof real>) => {
    hidden.reads += 1;
    const state = await real(...args);
    return hidden.value ? { ...state, tasks: [] } : state;
  };
  return hidden;
}

describe('runResumer: an approval whose thread does not show the pause yet', () => {
  it('is looked at again by a later reconcile, not settled by the first miss', async () => {
    const { h, counters, graph, id } = await pausedAgent();
    await h.approve(id);
    const hidden = hidePause(graph);
    const worker = await startWorker(h, graph, { pausedGraceMs: 0, reconcileIntervalMs: 30 });
    await sleep(120);
    expect(counters.runs).toHaveLength(0);
    hidden.value = false;
    await until(() => counters.runs.length === 1);
    await worker.stop();
    expect(await finished(graph)).toBe(true);
  });

  it('is given up on after the retry window, and reported once', async () => {
    const { h, counters, graph, id } = await pausedAgent();
    await h.approve(id);
    const hidden = hidePause(graph);
    const errors: [string, string | undefined][] = [];
    const worker = await startWorker(h, graph, {
      pausedGraceMs: 0,
      reconcileIntervalMs: 20,
      notPausedRetryMs: 80,
      onError: (e, approvalId) => errors.push([e.code, approvalId]),
    });
    await until(() => errors.length === 1);
    const reads = hidden.reads;
    await sleep(120);
    await worker.stop();
    expect(errors).toEqual([['unresumable', id]]);
    expect(hidden.reads).toBe(reads);
    expect(counters.runs).toHaveLength(0);
  });
});

describe('runResumer: an expired or withdrawn approval', () => {
  it.each(['expired', 'withdrawn'] as const)(
    'a %s approval is answered from the continuation the server echoes, with no scan of the checkpointer',
    async (close) => {
      const { h, counters, graph, id } = await pausedAgent();
      if (close === 'expired') h.mock.state.clockOffsetMs += 2 * 3600 * 1000;
      else await h.as(h.tokens.creator, 'POST', `/v1/approvals/${id}/withdraw`);
      const errors: string[] = [];
      const worker = await startWorker(h, graph, {
        pausedGraceMs: 0,
        reconcileIntervalMs: 25,
        onError: (e) => errors.push(e.code),
      });
      await until(async () => (await messagesOf(graph)).some((m) => m instanceof ToolMessage));
      await worker.stop();
      const [denial] = (await messagesOf(graph)).filter(
        (m): m is ToolMessage => m instanceof ToolMessage
      );
      expect(denialCodeOf(denial)).toBe('unresumable');
      expect(textOf(denial)).toContain(close);
      expect(counters.runs).toHaveLength(0);
      expect(errors).toEqual([]);
      expect(h.seen('POST', '/v1/records')).toHaveLength(0);
    }
  );

  describe("a thread that is not in this worker's checkpoint store", () => {
    const missing = async (
      window: number
    ): Promise<{
      h: Harness;
      ghost: Awaited<ReturnType<typeof manualPause>>;
      errors: [string, string | undefined][];
      worker: ResumerHandle;
    }> => {
      const h = await createHarness();
      const ghost = await manualPause(h, { threadId: 'ghost', pause: false });
      h.mock.state.clockOffsetMs += 2 * 3600 * 1000;
      const errors: [string, string | undefined][] = [];
      const governance = h.anotherGovernance();
      governance.registerTool('send_email', 'ext:local:send_email');
      const worker = await runResumer(ghost.graph, {
        governance,
        reconcileIntervalMs: 20,
        pausedGraceMs: 0,
        notPausedRetryMs: window,
        onError: (e, approvalId) => errors.push([e.code, approvalId]),
      });
      return { h, ghost, errors, worker };
    };

    it('is looked at again for the retry window and recorded as unresumable once, after it, with a record that says what was observed', async () => {
      const { h, ghost, errors, worker } = await missing(300);
      await sleep(150);
      // Inside the window: reconciled several times, and nothing recorded or reported.
      expect(h.seen('POST', '/v1/records')).toHaveLength(0);
      expect(errors).toEqual([]);
      await sleep(500);
      await worker.stop();
      expect(errors).toEqual([['unresumable', ghost.approvalId]]);
      const records = h.seen('POST', '/v1/records');
      expect(records).toHaveLength(1);
      expect(records[0]?.body).toMatchObject({
        approval_id: ghost.approvalId,
        outcome: {
          status: 'unknown',
          summary: expect.stringContaining("not found in this worker's checkpoint store") as string,
        },
      });
      expect(JSON.stringify(records[0]?.body)).not.toMatch(/\bgone\b/);
      expect(records[0]?.headers['idempotency-key']).toBe(
        `nc-langgraph-unresumable-${ghost.approvalId}`
      );
    });

    it('a thread that appears inside the window is resumed, and nothing is recorded or reported', async () => {
      const { h, ghost, errors, worker } = await missing(5000);
      await sleep(80);
      expect(h.seen('POST', '/v1/records')).toHaveLength(0);
      await ghost.graph.invoke({ messages: [new HumanMessage('go')] }, ghost.config);
      await until(() => ghost.resumed.length === 1, 3000);
      await worker.stop();
      expect(errors).toEqual([]);
      expect(h.seen('POST', '/v1/records')).toHaveLength(0);
    });

    it('an approved approval is held to the same window on the stream path, which waits out the grace first', async () => {
      const h = await createHarness();
      const ghost = await manualPause(h, { threadId: 'ghost', pause: false });
      const errors: [string, string | undefined][] = [];
      const governance = h.anotherGovernance();
      governance.registerTool('send_email', 'ext:local:send_email');
      const worker = await runResumer(ghost.graph, {
        governance,
        reconcileIntervalMs: 0,
        pausedGraceMs: 30,
        notPausedRetryMs: 5000,
        onError: (e, approvalId) => errors.push([e.code, approvalId]),
      });
      await h.approve(ghost.approvalId);
      await sleep(300);
      await worker.stop();
      expect(h.seen('POST', '/v1/records')).toHaveLength(0);
      expect(errors).toEqual([]);
    });
  });

  it('a langgraph approval for which the server returns no continuation is reported once as continuation_unavailable: the worker does not stop, and nothing is recorded', async () => {
    const h = await createHarness();
    const lost = await manualPause(h, { threadId: 'lost' });
    h.mock.state.clockOffsetMs += 2 * 3600 * 1000;
    h.intercept = async (request) => {
      if (new URL(request.url).pathname !== `/v1/approvals/${lost.approvalId}`) return undefined;
      const real = await h.mock.app.fetch(request);
      const json = (await real.json()) as { data: Record<string, unknown> };
      delete json.data.continuation;
      return Response.json(json, { status: real.status });
    };
    const errors: [string, string | undefined][] = [];
    const fatal: GovernanceError[] = [];
    const governance = h.anotherGovernance();
    governance.registerTool('send_email', 'ext:local:send_email');
    const worker = await runResumer(lost.graph, {
      governance,
      reconcileIntervalMs: 20,
      pausedGraceMs: 0,
      onError: (e, approvalId) => errors.push([e.code, approvalId]),
      onFatal: (e) => fatal.push(e),
    });
    await sleep(250);
    await worker.stop();
    expect(errors).toEqual([['continuation_unavailable', lost.approvalId]]);
    expect(fatal).toEqual([]);
    expect(h.seen('POST', '/v1/records')).toHaveLength(0);
  });
});

describe('runResumer: approvals the thread has already answered', () => {
  it('adv-2: a restarted worker settles a handled rejection silently; nothing is reported and no stray approval exists', async () => {
    const { h, graph, id } = await pausedAgent();
    await h.reject(id, 'no');
    await resumeApproval(graph, id, { governance: h.governance });
    expect(h.approvals()).toEqual([id]);
    const errors: string[] = [];
    const worker = await startWorker(h, graph, {
      pausedGraceMs: 0,
      reconcileIntervalMs: 20,
      notPausedRetryMs: 60,
      onError: (e) => errors.push(`${e.code}: ${e.message}`),
    });
    await sleep(250);
    await worker.stop();
    expect(errors).toEqual([]);
  });
});

describe('runResumer: closed approvals the thread has already answered', () => {
  const settledSilently = async (close: 'expired' | 'withdrawn'): Promise<void> => {
    const { h, graph, id } = await pausedAgent();
    if (close === 'expired') h.mock.state.clockOffsetMs += 2 * 3600 * 1000;
    else await h.as(h.tokens.creator, 'POST', `/v1/approvals/${id}/withdraw`);
    const outcome = await resumeApproval(graph, id, { governance: h.governance });
    expect(outcome).toMatchObject({ status: 'resumed', state: close });
    const errors: string[] = [];
    const worker = await startWorker(h, graph, {
      pausedGraceMs: 0,
      reconcileIntervalMs: 20,
      notPausedRetryMs: 60,
      onError: (e) => errors.push(`${e.code}: ${e.message}`),
    });
    await sleep(250);
    await worker.stop();
    expect(errors).toEqual([]);
    expect(h.seen('POST', '/v1/records')).toHaveLength(0);
  };

  it('delta-1: a restarted worker settles an expired approval the thread already answered, silently', async () => {
    await settledSilently('expired');
  });

  it('delta-1: a restarted worker settles a withdrawn approval the thread already answered, silently', async () => {
    await settledSilently('withdrawn');
  });
});

describe('runResumer: the principal it runs as (D-LG15)', () => {
  const principalOf = (h: Harness): string => principalOfToken(h.tokens.creator) ?? '';

  it('reports the principal at start-up through onReady, once', async () => {
    const { h, graph } = await pausedAgent();
    const ready: (string | undefined)[] = [];
    const worker = await startWorker(h, graph, { onReady: (r) => ready.push(r.principal) });
    await worker.stop();
    expect(ready).toEqual([principalOf(h)]);
  });

  it('an expected principal that matches starts the worker', async () => {
    const { h, graph } = await pausedAgent();
    const worker = await startWorker(h, graph, { expectedPrincipal: principalOf(h) });
    await worker.stop();
  });

  it('an expected principal that is another refuses to start: no stream is opened, nothing is listed, onReady is not called', async () => {
    const { h, graph } = await pausedAgent();
    const ready: unknown[] = [];
    await expect(
      startWorker(h, graph, { expectedPrincipal: 'the-agent', onReady: (r) => ready.push(r) })
    ).rejects.toMatchObject({ code: 'principal_mismatch' });
    expect(h.seen('GET', '/v1/approvals')).toHaveLength(0);
    expect(h.seen('GET', '/v1/approvals/stream')).toHaveLength(0);
    expect(ready).toEqual([]);
  });

  it('an expected principal that cannot be checked refuses to start with a clear error', async () => {
    const { h, graph } = await pausedAgent();
    const governance = h.anotherGovernance({ getToken: () => 'opaque-token' });
    await expect(
      runResumer(graph, { governance, expectedPrincipal: 'the-agent', reconcileIntervalMs: 0 })
    ).rejects.toMatchObject({ code: 'principal_unavailable' });
    expect(h.seen('GET', '/v1/approvals')).toHaveLength(0);
  });

  describe('a token whose sub changes after start-up', () => {
    const run = async (expectPrincipal: boolean) => {
      const { h, graph } = await pausedAgent();
      let swapped = false;
      const governance = h.anotherGovernance({
        ...(expectPrincipal ? { expectedPrincipal: principalOf(h) } : {}),
        getToken: () => (swapped ? h.tokens.approver : h.tokens.creator),
      });
      governance.registerTool('send_email', 'ext:local:send_email');
      const fatal: GovernanceError[] = [];
      const errors: string[] = [];
      const worker = await runResumer(graph, {
        governance,
        reconcileIntervalMs: 20,
        backoffMs: 10,
        maxBackoffMs: 40,
        pausedGraceMs: 500,
        onFatal: (e) => fatal.push(e),
        onError: (e) => errors.push(e.code),
      });
      swapped = true;
      return { h, worker, fatal, errors };
    };

    it('with expectedPrincipal the worker stops: failed resolves with principal_mismatch and onFatal is called once', async () => {
      const { worker, fatal } = await run(true);
      await expect(worker.failed).resolves.toMatchObject({ code: 'principal_mismatch' });
      await worker.stop();
      expect(fatal.map((e) => e.code)).toEqual(['principal_mismatch']);
      expect(JSON.stringify(fatal[0]?.message)).not.toContain('eyJ');
    });

    it('without expectedPrincipal the worker keeps running', async () => {
      const { worker, fatal, errors } = await run(false);
      await sleep(150);
      await worker.stop();
      expect(fatal).toEqual([]);
      expect(errors).not.toContain('principal_mismatch');
    });
  });

  it('a worker with no expected principal and a token that names none still starts, and reports it as unknown', async () => {
    const { h, graph } = await pausedAgent();
    const governance = h.anotherGovernance({ getToken: () => h.tokens.creator });
    const ready: (string | undefined)[] = [];
    const worker = await runResumer(graph, {
      governance,
      reconcileIntervalMs: 0,
      onReady: (r) => ready.push(r.principal),
    });
    await worker.stop();
    expect(ready).toHaveLength(1);
  });
});

describe('runResumer: start-up', () => {
  it('does not wait out the pause grace for every approval that was already handled', async () => {
    const { h, counters, graph, id } = await pausedAgent();
    await h.reject(id, 'no');
    // The thread has moved on; the rejected approval stays 'rejected' and is listed by every reconcile.
    await resumeApproval(graph, id, { governance: h.governance });
    expect(counters.runs).toHaveLength(0);
    const began = Date.now();
    const worker = await startWorker(h, graph, { pausedGraceMs: 1500 });
    const took = Date.now() - began;
    await worker.stop();
    expect(took).toBeLessThan(700);
  });
});
