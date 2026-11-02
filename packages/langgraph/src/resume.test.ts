import { ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { describe, expect, it } from 'vitest';

import { denialCodeOf } from './denial.js';
import { governed, governedToolNode } from './governed.js';
import { resumeApproval } from './resume.js';
import { ask, buildGraph, call, makeTools, start, textOf, TOOL_REFS } from '../test/graph.js';
import type { Counters } from '../test/graph.js';
import { createHarness, status } from '../test/harness.js';
import type { Harness, HarnessOptions } from '../test/harness.js';
import { manualPause } from '../test/manual-pause.js';
import { createSigner } from '../test/sign.js';

const CFG = { configurable: { thread_id: 't1' } };
const FAST = { pausedGraceMs: 60 };

async function pausedAgent(options: HarnessOptions = {}) {
  const h = await createHarness(options);
  const counters: Counters = { runs: [] };
  const tools = makeTools(counters);
  const graph = buildGraph({
    script: [ask(call('c1', 'send_email', { to: 'a@b.c' }))],
    toolNode: governedToolNode([tools.sendEmail], {
      toolRefs: TOOL_REFS,
      governance: h.governance,
    }),
  });
  await graph.invoke(start(), CFG);
  const [id = ''] = h.approvals();
  return { h, counters, graph, id };
}

const messagesOf = async (graph: {
  getState: (c: typeof CFG) => Promise<{ values: unknown }>;
}): Promise<BaseMessage[]> =>
  ((await graph.getState(CFG)).values as { messages: BaseMessage[] }).messages;

const toolMessagesOf = (messages: BaseMessage[]): ToolMessage[] =>
  messages.filter((m): m is ToolMessage => m instanceof ToolMessage);

const isPaused = async (graph: {
  getState: (c: typeof CFG) => Promise<{ tasks: readonly { interrupts: readonly unknown[] }[] }>;
}): Promise<boolean> => (await graph.getState(CFG)).tasks.some((t) => t.interrupts.length > 0);

/** A worker's own governance: its own caches and its own replay guard, the same tools. */
const worker = (h: Harness) => {
  const governance = h.anotherGovernance();
  governance.registerTool('send_email', 'ext:local:send_email');
  return governance;
};

describe('resumeApproval: the resolution table', () => {
  it('approved: verifies, then resumes; the tool runs once', async () => {
    const { h, counters, graph, id } = await pausedAgent();
    await h.approve(id);
    const outcome = await resumeApproval(graph, id, { governance: h.governance });
    expect(outcome).toMatchObject({ status: 'resumed', resolution: 'approved' });
    expect(counters.runs).toHaveLength(1);
    expect(await isPaused(graph)).toBe(false);
    expect(h.seen('GET', '/.well-known/jwks.json')).toHaveLength(1);
  });

  it("rejected: the tool does not run and the model gets a denial carrying the approver's reason; the agent continues", async () => {
    const { h, counters, graph, id } = await pausedAgent();
    await h.reject(id, 'wrong recipient');
    const outcome = await resumeApproval(graph, id, { governance: h.governance });
    expect(outcome).toMatchObject({ status: 'resumed', resolution: 'rejected' });
    expect(counters.runs).toHaveLength(0);
    const messages = await messagesOf(graph);
    const denial = messages.find((m): m is ToolMessage => m instanceof ToolMessage);
    expect(denialCodeOf(denial)).toBe('rejected');
    expect(textOf(denial)).toContain('wrong recipient');
    expect(messages.at(-1)?.content).toBe('done');
    // The rejection is read from the node's resume value: no second `/decisions`, so no second approval.
    expect(h.approvals()).toEqual([id]);
    expect(h.seen('POST', /\/withdraw$/)).toHaveLength(0);
    expect(h.seen('POST', '/v1/decisions')).toHaveLength(1);
    expect(h.seen('POST', /\/consume$/)).toHaveLength(0);
  });

  /**
   * A resume value that names an approval another attempt already consumed: the re-run's `/decisions`
   * opens an obligation of its own, which is not wanted and is withdrawn.
   */
  const strayScenario = async (options: HarnessOptions) => {
    const made = await pausedAgent(options);
    const { h, graph, id } = made;
    await h.approve(id);
    await h.as(h.tokens.creator, 'POST', `/v1/approvals/${id}/consume`, {
      resume_token: h.mock.state.obligations.get(id)?.resumeToken,
      action: { tool_ref: TOOL_REFS.send_email, arguments: { to: 'a@b.c' } },
    });
    const drive = () =>
      graph
        .invoke(new Command({ resume: { kind: 'answered', approval_id: id } }) as never, CFG)
        .then(() => undefined);
    return { ...made, drive };
  };

  it('a stray approval the re-run opened is withdrawn, and nothing runs or is written into the thread', async () => {
    const { h, counters, graph, id, drive } = await strayScenario({});
    await drive();
    const strays = h.approvals().filter((x) => x !== id);
    expect(strays).toHaveLength(1);
    expect(h.mock.state.obligations.get(strays[0] ?? '')?.state).toBe('withdrawn');
    expect(counters.runs).toHaveLength(0);
    // The approval was spent by another attempt: this one steps aside and leaves the thread paused.
    expect(await isPaused(graph)).toBe(true);
    expect(toolMessagesOf(await messagesOf(graph))).toHaveLength(0);
  });

  it('a stray approval that cannot be withdrawn is reported, and the call is still not run', async () => {
    const errors: string[] = [];
    const { h, counters, drive } = await strayScenario({
      governance: { onError: (e) => errors.push(`${e.code}: ${e.message}`) },
    });
    h.intercept = (request) =>
      new URL(request.url).pathname.endsWith('/withdraw') ? status(409) : undefined;
    await drive();
    expect(counters.runs).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^api_error: The unwanted approval \S+ could not be withdrawn \(409/);
  });

  it('a stray approval whose withdraw throws is reported with the cause', async () => {
    const errors: { code: string; cause: unknown }[] = [];
    const { h, drive } = await strayScenario({
      governance: { onError: (e) => errors.push({ code: e.code, cause: e.cause }) },
    });
    h.intercept = (request) => {
      if (new URL(request.url).pathname.endsWith('/withdraw')) throw new TypeError('fetch failed');
      return undefined;
    };
    await drive();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('api_error');
    expect(errors[0]?.cause).toBeDefined();
  });

  it("rejected with onRejected 'halt': ends the run, answering every call of the turn and not resuming the graph", async () => {
    const { h, counters, graph, id } = await pausedAgent({ governance: { onRejected: 'halt' } });
    await h.reject(id, 'wrong recipient');
    const outcome = await resumeApproval(graph, id, { governance: h.governance });
    expect(outcome).toEqual({ status: 'halted', resolution: 'rejected' });
    expect(counters.runs).toHaveLength(0);
    const messages = await messagesOf(graph);
    // The model never saw the denial: no turn followed it.
    expect(messages.some((m) => m.content === 'done')).toBe(false);
    const denial = messages.at(-1);
    expect(denial).toBeInstanceOf(ToolMessage);
    expect(textOf(denial)).toContain('wrong recipient');
    expect(await isPaused(graph)).toBe(false);
    // The re-run never happened, so no stray approval was opened.
    expect(h.approvals()).toEqual([id]);
  });

  it('halting answers the other calls of the same turn too, so the thread holds no dangling call', async () => {
    const h = await createHarness({ governance: { onRejected: 'halt' } });
    const counters: Counters = { runs: [] };
    const tools = makeTools(counters);
    const graph = buildGraph({
      script: [ask(call('c1', 'send_email', { to: 'a' }), call('c2', 'search', { q: 'x' }))],
      toolNode: governedToolNode([tools.sendEmail, tools.search], {
        toolRefs: TOOL_REFS,
        governance: h.governance,
      }),
    });
    await graph.invoke(start(), CFG);
    const [id = ''] = h.approvals();
    await h.reject(id);
    await resumeApproval(graph, id, { governance: h.governance });
    const answered = (await messagesOf(graph)).filter(
      (m): m is ToolMessage => m instanceof ToolMessage
    );
    expect(answered.map((m) => m.tool_call_id).sort()).toEqual(['c1', 'c2']);
  });

  it('escalated: not final, the thread stays paused', async () => {
    const { h, graph, id } = await pausedAgent();
    expect((await h.resolve(id, 'escalated')).status).toBe(200);
    const outcome = await resumeApproval(graph, id, { governance: h.governance });
    expect(outcome).toEqual({ status: 'waiting', reason: 'escalated' });
    expect(await isPaused(graph)).toBe(true);
  });

  it('m5: a signed Resumption whose resolution is escalated (state approved) is not final: the thread stays paused', async () => {
    const { h, counters, graph, id } = await pausedAgent();
    await h.approve(id);
    // The deployment signs an `escalated` statement for an approval it reports as approved.
    const signer = await createSigner();
    const obligation = h.mock.state.obligations.get(id);
    const payload = { ...(obligation?.resumption as Record<string, unknown>) };
    delete payload.signature;
    if (obligation !== undefined) {
      obligation.resumption = {
        ...payload,
        resolution: 'escalated',
        signature: await signer.sign({ ...payload, resolution: 'escalated' }),
      };
    }
    const governance = h.anotherGovernance({ jwks: signer.jwks });
    governance.registerTool('send_email', 'ext:local:send_email');
    expect(await resumeApproval(graph, id, { governance })).toEqual({
      status: 'waiting',
      reason: 'escalated',
    });
    expect(await isPaused(graph)).toBe(true);
    expect(counters.runs).toHaveLength(0);
    expect(h.seen('POST', /\/consume$/)).toHaveLength(0);
  });

  it('pending: nothing to resume yet', async () => {
    const { h, graph, id } = await pausedAgent();
    expect(await resumeApproval(graph, id, { governance: h.governance })).toEqual({
      status: 'waiting',
      reason: 'pending',
    });
    expect(h.seen('GET', `/v1/approvals/${id}/resumption`)).toHaveLength(0);
  });

  it('any other resolution: leaves the thread paused and raises unknown_resolution; the tool never runs', async () => {
    const { h, counters, graph, id } = await pausedAgent({ breaks: ['skip_request_validation'] });
    expect((await h.resolve(id, 'deferred_to_committee')).status).toBe(200);
    await expect(resumeApproval(graph, id, { governance: h.governance })).rejects.toMatchObject({
      code: 'unknown_resolution',
    });
    expect(await isPaused(graph)).toBe(true);
    expect(counters.runs).toHaveLength(0);
    // A refused resolution does not use up the Resumption: a later answer is not "replayed".
    await expect(resumeApproval(graph, id, { governance: h.governance })).rejects.toMatchObject({
      code: 'unknown_resolution',
    });
  });

  it('expired: the thread is resumed with a denial that says so', async () => {
    const { h, counters, graph, id } = await pausedAgent();
    h.mock.state.clockOffsetMs += 2 * 3600 * 1000;
    const outcome = await resumeApproval(graph, id, { governance: h.governance });
    expect(outcome).toMatchObject({ status: 'resumed', state: 'expired' });
    const denial = (await messagesOf(graph)).find(
      (m): m is ToolMessage => m instanceof ToolMessage
    );
    expect(denialCodeOf(denial)).toBe('unresumable');
    expect(textOf(denial)).toContain('expired');
    expect(counters.runs).toHaveLength(0);
    // An expired approval is not decided again on the re-run: no second approval is opened.
    expect(h.approvals()).toEqual([id]);
  });

  it('withdrawn: the thread is resumed with a denial that says so', async () => {
    const { h, counters, graph, id } = await pausedAgent();
    await h.as(h.tokens.creator, 'POST', `/v1/approvals/${id}/withdraw`);
    const outcome = await resumeApproval(graph, id, { governance: h.governance, threadId: 't1' });
    expect(outcome).toMatchObject({ status: 'resumed', state: 'withdrawn' });
    const denial = (await messagesOf(graph)).find(
      (m): m is ToolMessage => m instanceof ToolMessage
    );
    expect(textOf(denial)).toContain('withdrawn');
    expect(counters.runs).toHaveLength(0);
    expect(h.approvals()).toEqual([id]);
  });

  it('a consumed approval is skipped', async () => {
    const { h, graph, id } = await pausedAgent();
    await h.approve(id);
    await resumeApproval(graph, id, { governance: h.governance });
    expect(await resumeApproval(graph, id, { governance: h.governance })).toEqual({
      status: 'skipped',
      reason: 'consumed',
    });
  });

  it('a consumed approval whose thread is still paused on it (a crash after the consume) is raised, not skipped, and the tool is not re-run', async () => {
    const { h, counters, graph, id } = await pausedAgent();
    await h.approve(id);
    // The approval is spent, as the consume does before the tool runs; the checkpoint never advanced.
    const obligation = h.mock.state.obligations.get(id);
    if (obligation === undefined) throw new Error('no obligation');
    obligation.state = 'consumed';
    await expect(
      resumeApproval(graph, id, { governance: h.governance, threadId: 't1' })
    ).rejects.toMatchObject({
      code: 'unresumable',
      message: expect.stringContaining('consumed') as unknown,
    });
    // Without the thread named, it is the one the continuation names.
    await expect(resumeApproval(graph, id, { governance: h.governance })).rejects.toMatchObject({
      code: 'unresumable',
    });
    expect(counters.runs).toHaveLength(0);
  });

  it('a thread that is not paused on the approval is skipped, not resumed', async () => {
    const { h, graph, id } = await pausedAgent();
    await h.approve(id);
    expect(
      await resumeApproval(graph, id, {
        governance: h.governance,
        threadId: 't1',
        pausedGraceMs: 0,
      })
    ).toMatchObject({ status: 'resumed' });
    // A second approval, for a thread that has moved on.
    const other = await manualPause(h, { threadId: 'other' });
    await h.approve(other.approvalId);
    await other.graph.invoke(
      new (await import('@langchain/langgraph')).Command({ resume: 'x' }),
      other.config
    );
    expect(
      await resumeApproval(other.graph, other.approvalId, { governance: worker(h), ...FAST })
    ).toEqual({
      status: 'skipped',
      reason: 'not_paused',
    });
  });
});

describe('resumeApproval: the failure exits', () => {
  it('resumption_invalid: a signature by a key that is not in the key set; the thread stays paused', async () => {
    const { h, counters, graph, id } = await pausedAgent({ breaks: ['sign_unlisted_key'] });
    await h.approve(id);
    await expect(resumeApproval(graph, id, { governance: h.governance })).rejects.toMatchObject({
      code: 'resumption_invalid',
    });
    expect(await isPaused(graph)).toBe(true);
    expect(counters.runs).toHaveLength(0);
  });

  it('tool_mismatch: a signature over a payload bound to another tool and digest', async () => {
    const { h, counters, graph, id } = await pausedAgent({
      breaks: ['unbound_resumption_signature'],
    });
    await h.approve(id);
    await expect(resumeApproval(graph, id, { governance: h.governance })).rejects.toMatchObject({
      code: 'tool_mismatch',
    });
    expect(counters.runs).toHaveLength(0);
  });

  it('resumption_invalid: a signature that does not match its payload', async () => {
    const h = await createHarness();
    const a = await manualPause(h, { threadId: 'ta' });
    const run = (
      (await (await h.as(h.tokens.creator, 'POST', '/v1/runs', { kind: 'external' })).json()) as {
        data: { id: string };
      }
    ).data.id;
    const b = await manualPause(h, { threadId: 'tb', runId: run });
    await h.approve(a.approvalId);
    await h.approve(b.approvalId);
    const ofA = (
      (await (
        await h.as(h.tokens.creator, 'GET', `/v1/approvals/${a.approvalId}/resumption`)
      ).json()) as { data: { signature: string } }
    ).data;
    const ofB = (
      (await (
        await h.as(h.tokens.creator, 'GET', `/v1/approvals/${b.approvalId}/resumption`)
      ).json()) as { data: { signature: string } }
    ).data;
    // a's header and payload under b's signature.
    const forged = [...ofA.signature.split('.').slice(0, 2), ofB.signature.split('.')[2]].join('.');
    h.intercept = async (request) => {
      if (new URL(request.url).pathname !== `/v1/approvals/${a.approvalId}/resumption`)
        return undefined;
      const real = await h.mock.app.fetch(request);
      const json = (await real.json()) as { data: Record<string, unknown> };
      json.data.signature = forged;
      return Response.json(json);
    };
    await expect(
      resumeApproval(a.graph, a.approvalId, { governance: worker(h), ...FAST })
    ).rejects.toMatchObject({ code: 'resumption_invalid' });
    expect(a.resumed).toHaveLength(0);
  });

  it('resumption_invalid: a Resumption that is not a JWS', async () => {
    const { h, graph, id } = await pausedAgent();
    await h.approve(id);
    h.intercept = async (request) => {
      if (!new URL(request.url).pathname.endsWith('/resumption')) return undefined;
      const real = await h.mock.app.fetch(request);
      const json = (await real.json()) as { data: Record<string, unknown> };
      json.data.signature = 'not-a-jws';
      return Response.json(json);
    };
    await expect(resumeApproval(graph, id, { governance: h.governance })).rejects.toMatchObject({
      code: 'resumption_invalid',
    });
  });

  it('tool_mismatch: the Resumption is for another tool than the paused call', async () => {
    const { h, graph, id } = await pausedAgent();
    await h.approve(id);
    const governance = h.anotherGovernance();
    governance.registerTool('send_email', 'ext:local:other_tool');
    await expect(resumeApproval(graph, id, { governance })).rejects.toMatchObject({
      code: 'tool_mismatch',
    });
    expect(await isPaused(graph)).toBe(true);
  });

  it('tool_mismatch: a worker that governs no tool of that name refuses to guess', async () => {
    const { h, graph, id } = await pausedAgent();
    await h.approve(id);
    await expect(
      resumeApproval(graph, id, { governance: h.anotherGovernance() })
    ).rejects.toMatchObject({
      code: 'tool_mismatch',
      message: expect.stringContaining('send_email') as string,
    });
  });

  it('digest_mismatch: the checkpointed arguments are not the ones that were approved', async () => {
    const h = await createHarness();
    const paused = await manualPause(h, {
      checkpointArgs: { to: 'someone-else@example.com' },
      approvedArgs: { to: 'a@b.c' },
    });
    await h.approve(paused.approvalId);
    await expect(
      resumeApproval(paused.graph, paused.approvalId, { governance: worker(h) })
    ).rejects.toMatchObject({ code: 'digest_mismatch' });
    expect(paused.resumed).toHaveLength(0);
  });

  it('replayed: a Resumption this process already acted on', async () => {
    const { h, counters, graph, id } = await pausedAgent();
    await h.approve(id);
    await h.governance.replayGuard.firstUse(id, new Date(Date.now() + 3600_000));
    await expect(resumeApproval(graph, id, { governance: h.governance })).rejects.toMatchObject({
      code: 'replayed',
    });
    expect(counters.runs).toHaveLength(0);
    expect(await isPaused(graph)).toBe(true);
  });

  it('replayed: of two resumes of one approval at once, one resumes and the other is refused', async () => {
    const { h, counters, graph, id } = await pausedAgent();
    await h.approve(id);
    const results = await Promise.allSettled([
      resumeApproval(graph, id, { governance: h.governance, ...FAST }),
      resumeApproval(graph, id, { governance: h.governance, ...FAST }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected');
    expect(refused).toMatchObject({ reason: { code: 'replayed' } });
    expect(counters.runs).toHaveLength(1);
  });

  it('a resume that failed to start is not held against a retry', async () => {
    const { h, counters, graph, id } = await pausedAgent();
    await h.approve(id);
    const real = graph.invoke.bind(graph);
    let failures = 1;
    (graph as { invoke: unknown }).invoke = (...args: Parameters<typeof real>) => {
      if (failures-- > 0) return Promise.reject(new Error('checkpointer unavailable'));
      return real(...args);
    };
    await expect(resumeApproval(graph, id, { governance: h.governance })).rejects.toThrow(
      /checkpointer/
    );
    await expect(resumeApproval(graph, id, { governance: h.governance })).resolves.toMatchObject({
      status: 'resumed',
    });
    expect(counters.runs).toHaveLength(1);
  });

  it("a halt that failed to write is not held against a retry (onRejected: 'halt')", async () => {
    const { h, graph, id } = await pausedAgent({ governance: { onRejected: 'halt' } });
    await h.reject(id, 'wrong recipient');
    const real = graph.updateState.bind(graph);
    let failures = 1;
    (graph as { updateState: unknown }).updateState = (...args: Parameters<typeof real>) => {
      if (failures-- > 0) return Promise.reject(new Error('checkpointer unavailable'));
      return real(...args);
    };
    await expect(resumeApproval(graph, id, { governance: h.governance })).rejects.toThrow(
      /checkpointer/
    );
    expect(await isPaused(graph)).toBe(true);
    await expect(resumeApproval(graph, id, { governance: h.governance })).resolves.toEqual({
      status: 'halted',
      resolution: 'rejected',
    });
    expect(await isPaused(graph)).toBe(false);
  });

  /** An agent whose tool node lets a tool's error fail the run, as a tool that cannot be handled would. */
  const failingAgent = async (options: HarnessOptions) => {
    const h = await createHarness(options);
    const counters: Counters = { runs: [] };
    const tools = makeTools(counters, { failSend: true });
    const graph = buildGraph({
      script: [ask(call('c1', 'send_email', { to: 'a@b.c' }))],
      toolNode: new ToolNode(
        [governed(tools.sendEmail, { toolRef: TOOL_REFS.send_email, governance: h.governance })],
        { handleToolErrors: false }
      ),
    });
    await graph.invoke(start(), CFG);
    const [id = ''] = h.approvals();
    await h.approve(id);
    return { h, counters, graph, id };
  };

  it('a tool that fails the run after its approval was consumed is resume_failed, with the tool error as cause, and is not retried', async () => {
    const { h, counters, graph, id } = await failingAgent({});
    await expect(resumeApproval(graph, id, { governance: h.governance })).rejects.toMatchObject({
      code: 'resume_failed',
      cause: expect.objectContaining({ message: 'smtp down' }) as unknown,
    });
    expect(counters.runs).toHaveLength(1);
    expect(await isPaused(graph)).toBe(true);
    // The approval is spent: the retry is stopped, it does not run the tool again.
    await expect(resumeApproval(graph, id, { governance: h.governance })).rejects.toMatchObject({
      code: 'unresumable',
    });
    expect(counters.runs).toHaveLength(1);
  });

  it('the same holds when the gateway admits the call: a retry does not dispatch it again', async () => {
    const h = await createHarness();
    const counters: Counters = { runs: [] };
    const tools = makeTools(counters, { failCreate: true });
    const graph = buildGraph({
      script: [ask(call('c1', 'create_issue', { title: 'x' }))],
      toolNode: new ToolNode(
        [
          governed(tools.createIssue, {
            toolRef: TOOL_REFS.create_issue,
            governance: h.governance,
          }),
        ],
        { handleToolErrors: false }
      ),
    });
    // The gateway admits the call on an approval that was answered: the adapter dispatches it, once.
    await h.preapprove('t1', TOOL_REFS.create_issue, { title: 'x' });
    await expect(graph.invoke(start(), CFG)).rejects.toThrow(/tracker down/);
    expect(counters.runs).toHaveLength(1);
    // The retry meets the same approved obligation: another attempt already acted on it, so this one
    // steps aside and the tool is not dispatched again.
    const retry = (await graph.invoke(null, CFG)) as {
      __interrupt__?: { value: { lost?: string } }[];
    };
    expect(retry.__interrupt__?.[0]?.value.lost).toBe('replayed');
    expect(counters.runs).toHaveLength(1);
    expect(h.seen('POST', /\/consume$/)).toHaveLength(0);
  });

  it('consume_conflict: /consume answers 409 approval_conflict; the tool does not run and the model is told', async () => {
    const { h, counters, graph, id } = await pausedAgent();
    await h.approve(id);
    h.intercept = (request) =>
      new URL(request.url).pathname.endsWith('/consume')
        ? new Response(
            JSON.stringify({
              type: 'https://docs.noblecloak.com/problems/approval_conflict',
              title: 'x',
              status: 409,
            }),
            { status: 409, headers: { 'content-type': 'application/problem+json' } }
          )
        : undefined;
    await resumeApproval(graph, id, { governance: h.governance });
    expect(counters.runs).toHaveLength(0);
    const denial = (await messagesOf(graph)).find(
      (m): m is ToolMessage => m instanceof ToolMessage
    );
    expect(denialCodeOf(denial)).toBe('consume_conflict');
    expect(textOf(denial)).toMatch(/no longer matches/);
    expect(h.seen('POST', '/v1/records')).toHaveLength(0);
  });

  it('consume_conflict: another worker consumed it first (obligation_consumed): the loser does not run the tool', async () => {
    const { h, counters, graph, id } = await pausedAgent();
    await h.approve(id);
    // Between this worker's verification and its consume, another process consumes the approval.
    h.intercept = async (request) => {
      if (!new URL(request.url).pathname.endsWith('/consume')) return undefined;
      const token = h.mock.state.obligations.get(id)?.resumeToken;
      await h.as(h.tokens.creator, 'POST', `/v1/approvals/${id}/consume`, {
        resume_token: token,
        action: { tool_ref: 'ext:local:send_email', arguments: { to: 'a@b.c' } },
      });
      return undefined;
    };
    // The loser steps aside: its caller is told, and nothing is written into the thread.
    await expect(resumeApproval(graph, id, { governance: h.governance })).rejects.toMatchObject({
      code: 'consume_conflict',
    });
    expect(counters.runs).toHaveLength(0);
    expect(toolMessagesOf(await messagesOf(graph))).toHaveLength(0);
    expect(await isPaused(graph)).toBe(true);
  });

  it('a consume refused for another reason (the approval expired) is unresumable, and nothing runs', async () => {
    const { h, counters, graph, id } = await pausedAgent();
    await h.approve(id);
    h.intercept = (request) =>
      new URL(request.url).pathname.endsWith('/consume')
        ? new Response(
            JSON.stringify({
              type: 'https://docs.noblecloak.com/problems/obligation_expired',
              title: 'x',
              status: 409,
            }),
            { status: 409, headers: { 'content-type': 'application/problem+json' } }
          )
        : undefined;
    await resumeApproval(graph, id, { governance: h.governance });
    expect(counters.runs).toHaveLength(0);
    expect(
      denialCodeOf(
        (await messagesOf(graph)).find((m): m is ToolMessage => m instanceof ToolMessage)
      )
    ).toBe('unresumable');
  });

  it('a consume that cannot be reached: the tool does not run, nothing is written, and the resume is reported as unreachable', async () => {
    const { h, counters, graph, id } = await pausedAgent();
    await h.approve(id);
    h.intercept = (request) => {
      if (new URL(request.url).pathname.endsWith('/consume')) throw new TypeError('fetch failed');
      return undefined;
    };
    await expect(resumeApproval(graph, id, { governance: h.governance })).rejects.toMatchObject({
      code: 'unreachable',
    });
    expect(counters.runs).toHaveLength(0);
    expect(toolMessagesOf(await messagesOf(graph))).toHaveLength(0);
    expect(await isPaused(graph)).toBe(true);
  });

  it('a consume that fails on the wire is reported with its cause, and nothing of the transport reaches the thread', async () => {
    const errors: { code: string; cause: unknown }[] = [];
    const { h, graph, id } = await pausedAgent({
      governance: { onError: (e) => errors.push({ code: e.code, cause: e.cause }) },
    });
    await h.approve(id);
    h.intercept = (request) => {
      if (new URL(request.url).pathname.endsWith('/consume'))
        throw new TypeError('connect ECONNREFUSED 10.0.0.7:443');
      return undefined;
    };
    await expect(resumeApproval(graph, id, { governance: h.governance })).rejects.toMatchObject({
      code: 'unreachable',
    });
    expect(toolMessagesOf(await messagesOf(graph))).toHaveLength(0);
    expect(errors.map((e) => e.code)).toEqual(['unreachable']);
    expect(errors[0]?.cause).toBeDefined();
  });

  it('a consume that is throttled (429) leaves the approval unspent and the thread paused, and is reported; the retry runs the tool', async () => {
    const errors: string[] = [];
    const { h, counters, graph, id } = await pausedAgent({
      governance: { onError: (e) => errors.push(e.code) },
    });
    await h.approve(id);
    let throttled = true;
    h.intercept = (request) => {
      if (throttled && new URL(request.url).pathname.endsWith('/consume')) {
        throttled = false;
        return status(429);
      }
      return undefined;
    };
    await expect(resumeApproval(graph, id, { governance: h.governance })).rejects.toMatchObject({
      code: 'unreachable',
    });
    expect(counters.runs).toHaveLength(0);
    expect(toolMessagesOf(await messagesOf(graph))).toHaveLength(0);
    expect(errors).toEqual(['unreachable']);
    expect(await resumeApproval(graph, id, { governance: h.governance })).toMatchObject({
      status: 'resumed',
    });
    expect(counters.runs).toHaveLength(1);
  });

  it('unresumable: the thread has no checkpoint; a record marks the approval answered-but-unresumable', async () => {
    const h = await createHarness();
    const ghost = await manualPause(h, { threadId: 'ghost', pause: false });
    await h.approve(ghost.approvalId);
    await expect(
      resumeApproval(ghost.graph, ghost.approvalId, { governance: worker(h), ...FAST })
    ).rejects.toMatchObject({ code: 'unresumable' });
    const [record] = h.seen('POST', '/v1/records');
    expect(record?.body).toMatchObject({
      tool_ref: 'ext:local:send_email',
      approval_id: ghost.approvalId,
      outcome: { status: 'unknown', summary: expect.stringContaining('unresumable') as string },
    });
  });

  it('unresumable: the continuation expired', async () => {
    const h = await createHarness();
    const soon = new Date(Date.now() + 60_000).toISOString();
    const paused = await manualPause(h, { continuation: { expires_at: soon } });
    await h.approve(paused.approvalId);
    h.mock.state.clockOffsetMs += 5 * 60_000;
    await expect(
      resumeApproval(paused.graph, paused.approvalId, { governance: worker(h) })
    ).rejects.toMatchObject({ code: 'unresumable' });
    expect(h.seen('POST', '/v1/records')).toHaveLength(1);
    expect(paused.resumed).toHaveLength(0);
  });

  it('unresumable: the tool call is not in the checkpoint', async () => {
    const h = await createHarness();
    const paused = await manualPause(h);
    await h.approve(paused.approvalId);
    h.intercept = async (request) => {
      if (!new URL(request.url).pathname.endsWith('/resumption')) return undefined;
      const real = await h.mock.app.fetch(request);
      const json = (await real.json()) as {
        data: { continuation: { correlation: Record<string, unknown> } };
      };
      json.data.continuation.correlation.tool_call_id = 'c-other';
      return Response.json(json);
    };
    await expect(
      resumeApproval(paused.graph, paused.approvalId, { governance: worker(h) })
    ).rejects.toMatchObject({ code: 'unresumable' });
  });

  it('unresumable: an approval with no langgraph continuation has nothing to resume', async () => {
    const h = await createHarness();
    const paused = await manualPause(h);
    await h.approve(paused.approvalId);
    h.intercept = async (request) => {
      if (!new URL(request.url).pathname.endsWith('/resumption')) return undefined;
      const real = await h.mock.app.fetch(request);
      const json = (await real.json()) as { data: { continuation: Record<string, unknown> } };
      json.data.continuation.kind = 'webhook';
      return Response.json(json);
    };
    await expect(
      resumeApproval(paused.graph, paused.approvalId, { governance: worker(h) })
    ).rejects.toMatchObject({ code: 'unresumable' });
    // The closed path records an approval it cannot resume; the answered path does the same.
    expect(h.seen('POST', '/v1/records')).toHaveLength(1);
  });

  it('resumption_invalid: a validly signed Resumption of another approval than the one read', async () => {
    const h = await createHarness();
    const a = await manualPause(h, { threadId: 'ta' });
    const run = (
      (await (await h.as(h.tokens.creator, 'POST', '/v1/runs', { kind: 'external' })).json()) as {
        data: { id: string };
      }
    ).data.id;
    // Same tool and arguments in another run: another approval, the same digest.
    const b = await manualPause(h, { threadId: 'ta', runId: run });
    await h.approve(a.approvalId);
    await h.approve(b.approvalId);
    const ofB = (await (
      await h.as(h.tokens.creator, 'GET', `/v1/approvals/${b.approvalId}/resumption`)
    ).json()) as unknown;
    h.intercept = (request) =>
      new URL(request.url).pathname === `/v1/approvals/${a.approvalId}/resumption`
        ? Response.json(ofB)
        : undefined;
    await expect(
      resumeApproval(a.graph, a.approvalId, { governance: worker(h), ...FAST })
    ).rejects.toMatchObject({ code: 'resumption_invalid' });
  });

  it('resumption_invalid: the continuation read names another checkpoint_ns than the signed one', async () => {
    const { h, counters, graph, id } = await pausedAgent();
    await h.approve(id);
    const body = (await (
      await h.as(h.tokens.creator, 'GET', `/v1/approvals/${id}/resumption`)
    ).json()) as { data: { continuation: { correlation: { checkpoint_ns: string } } } };
    body.data.continuation.correlation.checkpoint_ns = 'elsewhere:1';
    h.intercept = (request) =>
      new URL(request.url).pathname === `/v1/approvals/${id}/resumption`
        ? Response.json(body)
        : undefined;
    await expect(
      resumeApproval(graph, id, { governance: worker(h), ...FAST })
    ).rejects.toMatchObject({ code: 'resumption_invalid' });
    expect(counters.runs).toHaveLength(0);
    expect(await isPaused(graph)).toBe(true);
  });

  it('not_owner: only the principal that created the approval can read its Resumption', async () => {
    const { h, graph, id } = await pausedAgent();
    await h.approve(id);
    const stranger = h.anotherGovernance({ getToken: () => h.tokens.approver });
    stranger.registerTool('send_email', 'ext:local:send_email');
    await expect(resumeApproval(graph, id, { governance: stranger })).rejects.toMatchObject({
      code: 'not_owner',
    });
  });

  it('api_error: an approval the API does not know', async () => {
    const { h, graph } = await pausedAgent();
    await expect(
      resumeApproval(graph, 'no-such-approval', { governance: h.governance })
    ).rejects.toMatchObject({ code: 'api_error' });
  });

  it('a Resumption read that answers 404 is "not resolved yet", and is reported', async () => {
    const errors: string[] = [];
    const { h, graph, id } = await pausedAgent({
      governance: { onError: (e) => errors.push(e.code) },
    });
    await h.approve(id);
    h.intercept = (request) =>
      new URL(request.url).pathname.endsWith('/resumption')
        ? new Response(
            JSON.stringify({
              type: 'https://docs.noblecloak.com/problems/not_found',
              title: 'x',
              status: 404,
            }),
            { status: 404 }
          )
        : undefined;
    expect(await resumeApproval(graph, id, { governance: h.governance })).toEqual({
      status: 'waiting',
      reason: 'pending',
    });
    expect(errors).toEqual(['api_error']);
  });

  it('an approval in a state this adapter does not know leaves the thread paused and is reported', async () => {
    const errors: string[] = [];
    const { h, graph, id } = await pausedAgent({
      governance: { onError: (e) => errors.push(`${e.code}: ${e.message}`) },
    });
    h.intercept = async (request) => {
      if (new URL(request.url).pathname !== `/v1/approvals/${id}`) return undefined;
      const real = (await (await h.as(h.tokens.creator, 'GET', `/v1/approvals/${id}`)).json()) as {
        data: Record<string, unknown>;
      };
      return Response.json({ ...real, data: { ...real.data, state: 'quarantined' } });
    };
    expect(await resumeApproval(graph, id, { governance: h.governance })).toEqual({
      status: 'waiting',
      reason: 'pending',
    });
    expect(await isPaused(graph)).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^unknown_resolution: .*quarantined/);
  });

  it('a Resumption read that answers something else is api_error', async () => {
    const { h, graph, id } = await pausedAgent();
    await h.approve(id);
    h.intercept = (request) =>
      new URL(request.url).pathname.endsWith('/resumption')
        ? new Response(
            JSON.stringify({
              type: 'https://docs.noblecloak.com/problems/invalid_request',
              title: 'x',
              status: 400,
            }),
            { status: 400 }
          )
        : undefined;
    await expect(resumeApproval(graph, id, { governance: h.governance })).rejects.toMatchObject({
      code: 'api_error',
    });
  });
});

describe('resumeApproval: finding the thread', () => {
  it('waits for the checkpoint to show the pause: an approval can be answered before the graph has paused', async () => {
    const { h, counters, graph, id } = await pausedAgent();
    await h.approve(id);
    // The pause is not in the checkpoint yet when the first read happens.
    const real = graph.getState.bind(graph);
    let reads = 0;
    (graph as { getState: unknown }).getState = async (...args: Parameters<typeof real>) => {
      reads += 1;
      const state = await real(...args);
      return reads === 1 ? { ...state, tasks: [] } : state;
    };
    const outcome = await resumeApproval(graph, id, {
      governance: h.governance,
      pausedGraceMs: 2000,
    });
    expect(outcome.status).toBe('resumed');
    expect(counters.runs).toHaveLength(1);
  });

  it('an expired approval is found without the caller naming the thread', async () => {
    const { h, graph, id } = await pausedAgent();
    h.mock.state.clockOffsetMs += 2 * 3600 * 1000;
    const outcome = await resumeApproval(graph, id, { governance: h.governance });
    expect(outcome).toMatchObject({ status: 'resumed', state: 'expired' });
  });

  it('an expired approval is found from the continuation by a process that did not pause it', async () => {
    const h = await createHarness();
    const elsewhere = await manualPause(h, { threadId: 'elsewhere' });
    h.mock.state.clockOffsetMs += 2 * 3600 * 1000;
    // A resumer with its own state and no thread named: the server's echo of the continuation names it.
    expect(
      await resumeApproval(elsewhere.graph, elsewhere.approvalId, {
        governance: worker(h),
        ...FAST,
      })
    ).toMatchObject({ status: 'resumed', state: 'expired' });
    expect(elsewhere.resumed).toHaveLength(1);
  });

  it.each(['expired', 'withdrawn'] as const)(
    'a %s approval of this principal whose continuation names no thread is unresumable and recorded, not skipped',
    async (close) => {
      const h = await createHarness();
      const lost = await manualPause(h, {
        threadId: 'lost',
        // A langgraph continuation with no correlation: there is no thread to go to.
        pause: false,
      });
      const obligation = h.mock.state.obligations.get(lost.approvalId);
      if (obligation === undefined) throw new Error('no obligation');
      obligation.continuation = { kind: 'langgraph', delivery: 'pull' };
      if (close === 'expired') h.mock.state.clockOffsetMs += 2 * 3600 * 1000;
      else await h.as(h.tokens.creator, 'POST', `/v1/approvals/${lost.approvalId}/withdraw`);
      await expect(
        resumeApproval(lost.graph, lost.approvalId, { governance: worker(h), ...FAST })
      ).rejects.toMatchObject({
        code: 'unresumable',
        message: expect.stringContaining('no thread') as unknown,
      });
      const records = h.seen('POST', '/v1/records');
      expect(records).toHaveLength(1);
      expect(records[0]?.body).toMatchObject({
        approval_id: lost.approvalId,
        outcome: { status: 'unknown' },
      });
    }
  );

  it('a langgraph approval for which the server returns no continuation is continuation_unavailable, not not_owner, and nothing is recorded about it', async () => {
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
    await expect(
      resumeApproval(lost.graph, lost.approvalId, { governance: worker(h), ...FAST })
    ).rejects.toMatchObject({
      code: 'continuation_unavailable',
      message: expect.stringMatching(/not the principal that created it.*predates/s) as unknown,
    });
    expect(h.seen('POST', '/v1/records')).toHaveLength(0);
  });

  it.each(['approver', 'creator'] as const)(
    'an expired approval of another kind (mcp_held, no continuation) is skipped as not_langgraph and nothing is recorded, whoever calls (%s)',
    async (who) => {
      const h = await createHarness();
      const unrelated = await manualPause(h, { threadId: 'unrelated' });
      const opened = await h.as(h.tokens.creator, 'POST', '/v1/decisions', {
        action: { tool_ref: 'ext:local:send_email', arguments: { to: 'plain@b.c' } },
      });
      const approvalId = ((await opened.json()) as { data: { approval: { id: string } } }).data
        .approval.id;
      expect(h.mock.state.obligations.get(approvalId)?.continuation.kind).toBe('mcp_held');
      h.mock.state.clockOffsetMs += 2 * 3600 * 1000;
      const governance = h.anotherGovernance({ getToken: () => h.tokens[who] });
      governance.registerTool('send_email', 'ext:local:send_email');
      const outcome = await resumeApproval(unrelated.graph, approvalId, { governance, ...FAST });
      expect(outcome).toEqual({ status: 'skipped', reason: 'not_langgraph' });
      expect(h.seen('POST', '/v1/records')).toHaveLength(0);
    }
  );

  it.each(['expired', 'withdrawn'] as const)(
    'a %s approval of another kind whose continuation the caller can read is skipped as not_langgraph on a direct call: it is not recorded as unresumable',
    async (close) => {
      const h = await createHarness();
      const other = await manualPause(h, { threadId: 'other', pause: false });
      const obligation = h.mock.state.obligations.get(other.approvalId);
      if (obligation === undefined) throw new Error('no obligation');
      // A continuation of another kind: the creator reads it, and it names no langgraph correlation.
      obligation.continuation = { kind: 'push', delivery: 'push' };
      if (close === 'expired') h.mock.state.clockOffsetMs += 2 * 3600 * 1000;
      else await h.as(h.tokens.creator, 'POST', `/v1/approvals/${other.approvalId}/withdraw`);
      expect(
        await resumeApproval(other.graph, other.approvalId, { governance: worker(h), ...FAST })
      ).toEqual({ status: 'skipped', reason: 'not_langgraph' });
      expect(h.seen('POST', '/v1/records')).toHaveLength(0);
    }
  );

  it('an approved approval of another kind is skipped as not_langgraph: its Resumption is not read', async () => {
    const h = await createHarness();
    const other = await manualPause(h, { threadId: 'other', pause: false });
    const obligation = h.mock.state.obligations.get(other.approvalId);
    if (obligation === undefined) throw new Error('no obligation');
    obligation.continuation = { kind: 'push', delivery: 'push' };
    await h.approve(other.approvalId);
    expect(
      await resumeApproval(other.graph, other.approvalId, { governance: worker(h), ...FAST })
    ).toEqual({ status: 'skipped', reason: 'not_langgraph' });
    expect(h.seen('GET', /\/resumption$/)).toHaveLength(0);
    expect(h.seen('POST', '/v1/records')).toHaveLength(0);
  });

  it('threadId, when the caller names it, wins over the continuation', async () => {
    const h = await createHarness();
    const paused = await manualPause(h, {
      threadId: 'real-thread',
      continuation: {
        correlation: {
          thread_id: 'stale-thread',
          checkpoint_ns: 'tools:manual',
          tool_call_id: 'c1',
        },
      },
    });
    h.mock.state.clockOffsetMs += 2 * 3600 * 1000;
    expect(
      await resumeApproval(paused.graph, paused.approvalId, {
        governance: worker(h),
        threadId: 'real-thread',
        ...FAST,
      })
    ).toMatchObject({ status: 'resumed', state: 'expired' });
  });

  it('an expired approval whose thread is gone is unresumable and recorded', async () => {
    const h = await createHarness();
    const ghost = await manualPause(h, { threadId: 'ghost', pause: false });
    h.mock.state.clockOffsetMs += 2 * 3600 * 1000;
    await expect(
      resumeApproval(ghost.graph, ghost.approvalId, {
        governance: worker(h),
        threadId: 'ghost',
        ...FAST,
      })
    ).rejects.toMatchObject({ code: 'unresumable' });
    expect(h.seen('POST', '/v1/records')).toHaveLength(1);
  });

  it('an expired approval whose thread is no longer paused on it is skipped', async () => {
    const h = await createHarness();
    const paused = await manualPause(h);
    h.mock.state.clockOffsetMs += 2 * 3600 * 1000;
    await paused.graph.invoke(
      new (await import('@langchain/langgraph')).Command({ resume: 'x' }),
      paused.config
    );
    expect(
      await resumeApproval(paused.graph, paused.approvalId, {
        governance: worker(h),
        threadId: paused.threadId,
        ...FAST,
      })
    ).toEqual({ status: 'skipped', reason: 'not_paused' });
  });
});

describe('resumeApproval: an approval that ended without a Resumption, on a busy checkpointer', () => {
  /** A SQLite checkpointer where other threads have written far more checkpoints than any scan would read since the pause. */
  const busyAgent = async () => {
    const h = await createHarness();
    const counters: Counters = { runs: [] };
    const tools = makeTools(counters);
    const graph = buildGraph({
      script: [ask(call('c1', 'send_email', { to: 'a@b.c' }))],
      toolNode: governedToolNode([tools.sendEmail, tools.search], {
        toolRefs: TOOL_REFS,
        governance: h.governance,
      }),
      checkpointer: SqliteSaver.fromConnString(':memory:'),
    });
    await graph.invoke(start(), CFG);
    const [id = ''] = h.approvals();
    const noise = buildGraph({
      script: [],
      toolNode: governedToolNode([tools.sendEmail, tools.search], {
        toolRefs: TOOL_REFS,
        governance: h.governance,
      }),
      checkpointer: graph.checkpointer as never,
    });
    for (let i = 0; i < 200; i += 1) {
      await noise.invoke(start(`noise ${i.toString()}`), {
        configurable: { thread_id: `noise-${i.toString()}` },
      });
    }
    h.mock.state.clockOffsetMs += 2 * 3600 * 1000;
    return { h, counters, graph, id };
  };

  it('the thread is found from the continuation, however much traffic followed the pause and whichever process resumes', async () => {
    const { h, graph, id } = await busyAgent();
    // A resumer with its own state, and no thread named: nothing scans the checkpointer for it.
    const outcome = await resumeApproval(graph, id, { governance: worker(h) });
    expect(outcome).toMatchObject({ status: 'resumed', state: 'expired' });
    expect(await isPaused(graph)).toBe(false);
  });
});

describe('A7: an approval that ended unanswered is a state, not a resolution', () => {
  it.each(['expired', 'withdrawn'] as const)(
    'a %s approval resumes the thread with `state` and no `resolution`',
    async (close) => {
      const { h, graph, id } = await pausedAgent();
      if (close === 'expired') h.mock.state.clockOffsetMs += 2 * 3600 * 1000;
      else await h.as(h.tokens.creator, 'POST', `/v1/approvals/${id}/withdraw`);
      const outcome = await resumeApproval(graph, id, { governance: h.governance });
      expect(outcome.status).toBe('resumed');
      expect(outcome).toMatchObject({ state: close });
      expect('resolution' in outcome).toBe(false);
    }
  );

  it('an answered approval resumes with `resolution` and no `state`', async () => {
    const { h, graph, id } = await pausedAgent();
    await h.reject(id, 'no');
    const outcome = await resumeApproval(graph, id, { governance: h.governance });
    expect(outcome).toMatchObject({ status: 'resumed', resolution: 'rejected' });
    expect('state' in outcome).toBe(false);
  });
});
