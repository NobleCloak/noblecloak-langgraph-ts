import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { argDigest } from '@noblecloak/client';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import {
  Command,
  END,
  interrupt,
  MemorySaver,
  MessagesAnnotation,
  START,
  StateGraph,
} from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { describe, expect, it, vi } from 'vitest';

import { denialCodeOf } from './denial.js';
import { governed, governedToolNode, peekResume } from './governed.js';
import { principalOfToken } from './governance.js';
import { resumeApproval } from './resume.js';
import { ask, buildGraph, call, makeTools, start, textOf, TOOL_REFS } from '../test/graph.js';
import type { Counters } from '../test/graph.js';
import { createHarness, status } from '../test/harness.js';
import type { Harness, HarnessOptions } from '../test/harness.js';

const CFG = { configurable: { thread_id: 't1' } };

/** Whether `needle` is anywhere in what the saver has stored: the checkpoints and their pending writes. */
function storedBytes(saver: SqliteSaver, needle: string): boolean {
  const db = saver.db as unknown as {
    prepare(sql: string): { all(): Record<string, unknown>[] };
  };
  const text = (value: unknown): string =>
    value instanceof Uint8Array ? Buffer.from(value).toString('latin1') : String(value);
  for (const table of ['checkpoints', 'writes']) {
    for (const row of db.prepare(`SELECT * FROM ${table}`).all()) {
      if (Object.values(row).some((value) => text(value).includes(needle))) return true;
    }
  }
  return false;
}

async function setup(
  options: HarnessOptions & {
    script: Parameters<typeof buildGraph>[0]['script'];
    failSend?: boolean;
    searchDelayMs?: number;
    log?: string[];
  },
  tools: ('search' | 'sendEmail' | 'deleteAccount' | 'createIssue')[] = ['sendEmail']
) {
  const h = await createHarness(options);
  const counters: Counters = { runs: [] };
  const made = makeTools(counters, {
    ...(options.failSend === undefined ? {} : { failSend: options.failSend }),
    ...(options.searchDelayMs === undefined ? {} : { searchDelayMs: options.searchDelayMs }),
    ...(options.log === undefined ? {} : { log: options.log }),
    probe: () => ({
      consumes: h.seen('POST', /\/consume$/).length,
      records: h.seen('POST', '/v1/records').length,
    }),
  });
  const graph = buildGraph({
    script: options.script,
    toolNode: governedToolNode(
      tools.map((name) => made[name]),
      { toolRefs: TOOL_REFS, governance: h.governance }
    ),
  });
  return { h, counters, graph };
}

const messagesOf = async (
  graph: ReturnType<typeof buildGraph>,
  config = CFG
): Promise<BaseMessage[]> =>
  ((await graph.getState(config)).values as { messages: BaseMessage[] }).messages;

const toolMessages = (messages: BaseMessage[]): ToolMessage[] =>
  messages.filter((m): m is ToolMessage => m instanceof ToolMessage);

const decisionBodies = (
  h: Harness
): {
  action: { arguments: unknown };
  continuation?: unknown;
  actor?: unknown;
  context?: unknown;
}[] => h.seen('POST', '/v1/decisions').map((r) => r.body as never);

const tamper = (h: Harness, path: string, change: (data: Record<string, unknown>) => void) => {
  h.intercept = async (request) => {
    if (new URL(request.url).pathname !== path) return undefined;
    const real = await h.mock.app.fetch(request);
    const json = (await real.json()) as { data: Record<string, unknown> };
    change(json.data);
    return Response.json(json, { status: real.status });
  };
};

describe('governed: the decision table', () => {
  it("allow: runs the tool, appends the outcome record, and decides inside the thread's run", async () => {
    const { h, counters, graph } = await setup(
      { script: [ask(call('c1', 'search', { q: 'bug' }))] },
      ['search']
    );
    await graph.invoke(start(), CFG);
    expect(counters.runs).toHaveLength(1);
    expect(toolMessages(await messagesOf(graph))[0]?.content).toBe('found bug');
    const [decision] = decisionBodies(h);
    expect(decision?.action).toEqual({ tool_ref: 'mcp:tracker:search', arguments: { q: 'bug' } });
    expect(decision?.actor).toEqual({ run_id: expect.stringMatching(/^run_/) as unknown });
    expect(decision?.context).toEqual({ invocation_channel: 'headless', call_id: 'c1' });
    const [record] = h.seen('POST', '/v1/records');
    expect(record?.body).toMatchObject({
      tool_ref: 'mcp:tracker:search',
      decision: 'allow',
      outcome: { status: 'succeeded' },
      context: { invocation_channel: 'headless' },
    });
    expect(h.mock.state.records).toHaveLength(1);
  });

  it('deny: does not run, and tells the model why', async () => {
    const { h, counters, graph } = await setup(
      { script: [ask(call('c1', 'delete_account', { id: '9' }))] },
      ['deleteAccount']
    );
    await graph.invoke(start(), CFG);
    expect(counters.runs).toHaveLength(0);
    const [message] = toolMessages(await messagesOf(graph));
    expect(denialCodeOf(message)).toBe('denied');
    expect(textOf(message)).toContain('(deny)');
    expect(message?.tool_call_id).toBe('c1');
    expect(h.seen('POST', '/v1/records')).toHaveLength(0);
  });

  it('step_up, pending, approvals routed: interrupts with the approval, and attaches the continuation', async () => {
    const { h, counters, graph } = await setup({
      script: [ask(call('c1', 'send_email', { to: 'a@b.c' }))],
    });
    const result = await graph.invoke(start(), CFG);
    expect(counters.runs).toHaveLength(0);
    const interrupts = (result as { __interrupt__?: { value: unknown }[] }).__interrupt__;
    expect(interrupts).toHaveLength(1);
    expect(interrupts?.[0]?.value).toEqual({
      approval_id: h.approvals()[0],
      tool_ref: 'ext:local:send_email',
      tool_call_id: 'c1',
      summary: 'Approval required to run ext:local:send_email.',
    });
    const continuation = decisionBodies(h)[0]?.continuation as {
      kind: string;
      delivery: string;
      correlation: Record<string, string>;
    };
    expect(continuation.kind).toBe('langgraph');
    expect(continuation.delivery).toBe('pull');
    // D-LG9: exactly these three, in this order.
    expect(Object.keys(continuation.correlation)).toEqual([
      'thread_id',
      'checkpoint_ns',
      'tool_call_id',
    ]);
    expect(continuation.correlation).toEqual({
      thread_id: 't1',
      checkpoint_ns: expect.stringMatching(/^tools:/) as string,
      tool_call_id: 'c1',
    });
  });

  it('D-LG9: the continuation is the same on the re-run, and the re-run opens no second approval', async () => {
    const { h, graph } = await setup({ script: [ask(call('c1', 'send_email', { to: 'a@b.c' }))] });
    await graph.invoke(start(), CFG);
    const [id = ''] = h.approvals();
    await h.approve(id);
    await resumeApproval(graph, id, { governance: h.governance });
    const bodies = h
      .seen('POST', '/v1/decisions')
      .map((r) => JSON.stringify((r.body as { continuation: unknown }).continuation));
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(h.approvals()).toEqual([id]);
  });

  it('step_up, approved, resume_token_will_issue: consumes before the tool runs, then runs it once and records', async () => {
    const { h, counters, graph } = await setup({
      script: [ask(call('c1', 'send_email', { to: 'a@b.c' }))],
    });
    await graph.invoke(start(), CFG);
    const [id = ''] = h.approvals();
    await h.approve(id);
    const outcome = await resumeApproval(graph, id, { governance: h.governance });
    expect(outcome).toMatchObject({ status: 'resumed', resolution: 'approved' });
    expect(counters.runs).toHaveLength(1);
    // The commit point: the approval was consumed before the tool ran, and the record came after.
    expect(counters.runs[0]?.probe).toEqual({ consumes: 1, records: 0 });
    const [record] = h.seen('POST', '/v1/records');
    expect(record?.body).toMatchObject({
      tool_ref: 'ext:local:send_email',
      decision: 'step_up',
      approval_id: id,
      outcome: { status: 'succeeded' },
    });
    expect(h.mock.state.obligations.get(id)?.state).toBe('consumed');
    expect(h.mock.state.obligations.get(id)?.outcomeRecordId).toBeDefined();
  });

  it('digests the arguments as the model sent them, not as the schema defaults them', async () => {
    const { h, counters, graph } = await setup({
      script: [ask(call('c1', 'send_email', { to: 'a@b.c' }))],
    });
    await graph.invoke(start(), CFG);
    const [id = ''] = h.approvals();
    await h.approve(id);
    await resumeApproval(graph, id, { governance: h.governance });
    // The tool saw the default; the decision and the consume carried the raw arguments.
    expect(counters.runs[0]?.args).toEqual({ to: 'a@b.c', note: 'hello' });
    expect(decisionBodies(h)[0]?.action.arguments).toEqual({ to: 'a@b.c' });
    expect((h.seen('POST', /\/consume$/)[0]?.body as { action: unknown }).action).toEqual({
      tool_ref: 'ext:local:send_email',
      arguments: { to: 'a@b.c' },
    });
  });

  it('a Resumption with no resume_token for a call the caller consumes: refused, the tool is not run', async () => {
    const { h, counters, graph } = await setup({
      breaks: ['external_tool_no_resume_token'],
      script: [ask(call('c1', 'send_email', { to: 'a@b.c' }))],
    });
    await graph.invoke(start(), CFG);
    const [id = ''] = h.approvals();
    await h.approve(id);
    await resumeApproval(graph, id, { governance: h.governance });
    expect(counters.runs).toHaveLength(0);
    expect(h.seen('POST', /\/consume$/)).toHaveLength(0);
    const refused = toolMessages(await messagesOf(graph)).find((m) => m.tool_call_id === 'c1');
    expect(denialCodeOf(refused)).toBe('resumption_invalid');
  });

  describe('D-LG12: a resume value is only the id of an answered approval', () => {
    /** An approval of another call (same tool, other arguments), answered yes. */
    const answeredElsewhere = async (h: Harness): Promise<string> => {
      const decided = await h.as(h.tokens.creator, 'POST', '/v1/decisions', {
        action: { tool_ref: TOOL_REFS.send_email, arguments: { to: 'someone-else' } },
        continuation: {
          kind: 'langgraph',
          delivery: 'pull',
          correlation: { thread_id: 'x', checkpoint_ns: '', tool_call_id: 'y' },
        },
      });
      const id = ((await decided.json()) as { data: { approval: { id: string } } }).data.approval
        .id;
      await h.approve(id);
      return id;
    };

    const handMade: [string, (id: string, h: Harness) => unknown][] = [
      ['a boolean', () => true],
      ['a string', () => 'approved'],
      ['an object with no approval id', () => ({ kind: 'answered' })],
      [
        'the id of an approval that is still pending',
        (id) => ({ kind: 'answered', approval_id: id }),
      ],
      ['an id no approval has', () => ({ kind: 'answered', approval_id: 'no-such-approval' })],
      [
        'the earlier shape that carried the Resumption and a made-up token',
        (id) => ({
          kind: 'approved',
          approval_id: id,
          resumption: { approval_id: id, resume_token: 'made-up' },
        }),
      ],
    ];

    it.each(handMade)('%s: the tool does not run and nothing is consumed', async (_name, make) => {
      const { h, counters, graph } = await setup({
        script: [ask(call('c1', 'send_email', { to: 'a@b.c' }))],
      });
      await graph.invoke(start(), CFG);
      const [id = ''] = h.approvals();
      await graph.invoke(new Command({ resume: await make(id, h) }) as never, CFG);
      expect(counters.runs).toHaveLength(0);
      expect(h.seen('POST', /\/consume$/)).toHaveLength(0);
      expect(h.mock.state.obligations.get(id)?.state).toBe('pending');
      const refused = toolMessages(await messagesOf(graph)).find((m) => m.tool_call_id === 'c1');
      expect(refused?.status).toBe('error');
      expect(denialCodeOf(refused)).toBeDefined();
    });

    it('A5: the id of another call, answered yes: the call is a fresh pause on its own approval; nothing runs, is consumed or is written', async () => {
      const { h, counters, graph } = await setup({
        script: [ask(call('c1', 'send_email', { to: 'a@b.c' }))],
      });
      await graph.invoke(start(), CFG);
      const [id = ''] = h.approvals();
      const other = await answeredElsewhere(h);
      const result = (await graph.invoke(
        new Command({ resume: { kind: 'answered', approval_id: other } }) as never,
        CFG
      )) as { __interrupt__?: { value: { approval_id?: string } }[] };
      expect(counters.runs).toHaveLength(0);
      expect(h.seen('POST', /\/consume$/)).toHaveLength(0);
      expect(h.mock.state.obligations.get(id)?.state).toBe('pending');
      expect(result.__interrupt__?.map((i) => i.value.approval_id)).toEqual([id]);
      expect(toolMessages(await messagesOf(graph))).toHaveLength(0);
    });

    it('a real resume_token copied into a hand-made value does not run the tool either', async () => {
      const { h, counters, graph } = await setup({
        script: [ask(call('c1', 'send_email', { to: 'a@b.c' }))],
      });
      await graph.invoke(start(), CFG);
      const [id = ''] = h.approvals();
      await h.approve(id);
      const real = (await (
        await h.as(h.tokens.creator, 'GET', `/v1/approvals/${id}/resumption`)
      ).json()) as { data: Record<string, unknown> };
      await graph.invoke(
        new Command({
          resume: { kind: 'approved', approval_id: id, resumption: real.data },
        }) as never,
        CFG
      );
      expect(counters.runs).toHaveLength(0);
      expect(h.seen('POST', /\/consume$/)).toHaveLength(0);
      expect(denialCodeOf(toolMessages(await messagesOf(graph))[0])).toBe('resumption_invalid');
      // The approval is untouched: still approved, and a proper resume of a fresh turn could take it.
      expect(h.mock.state.obligations.get(id)?.state).toBe('approved');
    });

    /**
     * The server is made to accept anything at `/consume`, so that only the adapter's own checks stand
     * between a wrong Resumption and the tool. The Resumption is genuinely signed: the mock's own
     * state is edited before the approval is answered, and restored after.
     */
    const withSignedFlaw = async (
      flaw: (
        o: NonNullable<ReturnType<Harness['mock']['state']['obligations']['get']>>
      ) => () => void
    ) => {
      const made = await setup({ script: [ask(call('c1', 'send_email', { to: 'a@b.c' }))] });
      const { h, graph } = made;
      await graph.invoke(start(), CFG);
      const [id = ''] = h.approvals();
      const obligation = h.mock.state.obligations.get(id);
      if (obligation === undefined) throw new Error('no obligation');
      const restore = flaw(obligation);
      await h.approve(id);
      restore();
      h.intercept = (request) =>
        new URL(request.url).pathname.endsWith('/consume')
          ? Response.json(
              {
                data: {
                  approval_id: id,
                  state: 'consumed',
                  consumed_at: new Date().toISOString(),
                  tool_ref: TOOL_REFS.send_email,
                  action_digest: obligation.argDigest,
                },
                meta: { request_id: 'r', deployment: 'hosted' },
              },
              { status: 200 }
            )
          : undefined;
      await graph.invoke(
        new Command({ resume: { kind: 'answered', approval_id: id } }) as never,
        CFG
      );
      return { ...made, id };
    };

    it('digest_mismatch: a Resumption signed over other arguments is refused by the adapter, not by the server', async () => {
      const { h, counters, graph } = await withSignedFlaw((o) => {
        const real = o.argDigest;
        o.argDigest = '0'.repeat(64);
        return () => {
          o.argDigest = real;
        };
      });
      expect(counters.runs).toHaveLength(0);
      expect(h.seen('POST', /\/consume$/)).toHaveLength(0);
      expect(denialCodeOf(toolMessages(await messagesOf(graph))[0])).toBe('digest_mismatch');
    });

    it('tool_mismatch: a Resumption signed for another tool is refused by the adapter, not by the server', async () => {
      const { h, counters, graph } = await withSignedFlaw((o) => {
        const real = o.toolRef;
        o.toolRef = 'mcp:crm:delete_account';
        return () => {
          o.toolRef = real;
        };
      });
      expect(counters.runs).toHaveLength(0);
      expect(h.seen('POST', /\/consume$/)).toHaveLength(0);
      expect(denialCodeOf(toolMessages(await messagesOf(graph))[0])).toBe('tool_mismatch');
    });

    it('a Resumption whose signed continuation names another call is refused by the adapter', async () => {
      const { h, counters, graph } = await withSignedFlaw((o) => {
        const correlation = o.continuation.correlation as Record<string, unknown>;
        const real = correlation.tool_call_id;
        correlation.tool_call_id = 'some-other-call';
        return () => {
          correlation.tool_call_id = real;
        };
      });
      expect(counters.runs).toHaveLength(0);
      expect(h.seen('POST', /\/consume$/)).toHaveLength(0);
      expect(denialCodeOf(toolMessages(await messagesOf(graph))[0])).toBe('resumption_invalid');
    });

    it('a signed continuation of another thread is refused too', async () => {
      const { h, counters, graph } = await withSignedFlaw((o) => {
        const correlation = o.continuation.correlation as Record<string, unknown>;
        const real = correlation.thread_id;
        correlation.thread_id = 'another-thread';
        return () => {
          correlation.thread_id = real;
        };
      });
      expect(counters.runs).toHaveLength(0);
      expect(h.seen('POST', /\/consume$/)).toHaveLength(0);
      expect(denialCodeOf(toolMessages(await messagesOf(graph))[0])).toBe('resumption_invalid');
    });

    it('a refusal after the replay guard was taken does not hold the approval against a retry', async () => {
      const { h, id } = await withSignedFlaw((o) => {
        const correlation = o.continuation.correlation as Record<string, unknown>;
        const real = correlation.tool_call_id;
        correlation.tool_call_id = 'some-other-call';
        return () => {
          correlation.tool_call_id = real;
        };
      });
      // The Resumption was verified, then refused: the guard let go of the approval.
      expect(await h.governance.replayGuard.firstUse(id, new Date(Date.now() + 60_000))).toBe(true);
    });

    it('nothing secret is written into the checkpoint: no resume_token and no signature', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'nc-langgraph-ck-'));
      const file = join(dir, 'c.sqlite');
      const h = await createHarness({});
      const counters: Counters = { runs: [] };
      const made = makeTools(counters);
      const saver = SqliteSaver.fromConnString(file);
      const graph = buildGraph({
        script: [ask(call('c1', 'send_email', { to: 'a@b.c' }))],
        checkpointer: saver,
        toolNode: governedToolNode([made.sendEmail], {
          toolRefs: TOOL_REFS,
          governance: h.governance,
        }),
      });
      await graph.invoke(start(), CFG);
      const [id = ''] = h.approvals();
      await h.approve(id);
      await resumeApproval(graph, id, { governance: h.governance });
      expect(counters.runs).toHaveLength(1);
      const token = h.mock.state.obligations.get(id)?.resumeToken ?? '';
      const signature =
        (h.mock.state.obligations.get(id)?.resumption as { signature?: string } | undefined)
          ?.signature ?? '';
      expect(token).not.toBe('');
      expect(signature).not.toBe('');
      expect(storedBytes(saver, token)).toBe(false);
      expect(storedBytes(saver, signature)).toBe(false);
      // The scan can see what is there: a hand-made resume that carries the token is found.
      const planted = SqliteSaver.fromConnString(join(dir, 'planted.sqlite'));
      const again = buildGraph({
        script: [ask(call('c1', 'send_email', { to: 'a@b.c' }))],
        checkpointer: planted,
        toolNode: governedToolNode([made.sendEmail], {
          toolRefs: TOOL_REFS,
          governance: h.governance,
        }),
      });
      await again.invoke(start(), { configurable: { thread_id: 'planted' } });
      await again.invoke(
        new Command({
          resume: { kind: 'answered', approval_id: 'x', resume_token: token },
        }) as never,
        { configurable: { thread_id: 'planted' } }
      );
      expect(storedBytes(planted, token)).toBe(true);
    });
  });

  it('D-LG12: the tool is handed the very arguments that were decided, approved and consumed', async () => {
    const h = await createHarness({});
    const handed: unknown[] = [];
    const counters: Counters = { runs: [] };
    const { sendEmail } = makeTools(counters);
    const spy = Object.create(sendEmail, {
      invoke: {
        value: (input: unknown, config: unknown) => {
          handed.push(input);
          return sendEmail.invoke(input as never, config as never);
        },
      },
    }) as typeof sendEmail;
    const graph = buildGraph({
      script: [ask(call('c1', 'send_email', { to: 'a@b.c' }))],
      toolNode: governedToolNode([spy], { toolRefs: TOOL_REFS, governance: h.governance }),
    });
    await graph.invoke(start(), CFG);
    const [id = ''] = h.approvals();
    await h.approve(id);
    await resumeApproval(graph, id, { governance: h.governance });
    expect(counters.runs).toHaveLength(1);
    // The model sent `{ to }`; the schema's default for `note` is the tool's business, not the call's.
    expect(handed).toEqual([{ to: 'a@b.c' }]);
    const digest = await argDigest(handed[0] as never);
    expect(decisionBodies(h)[0]?.action.arguments).toEqual(handed[0]);
    expect(
      (h.seen('POST', /\/consume$/)[0]?.body as { action: { arguments: unknown } }).action.arguments
    ).toEqual(handed[0]);
    expect(h.mock.state.obligations.get(id)?.argDigest).toBe(digest);
  });

  it('a gateway-admitted approval (allow with an approval handle): runs without consuming or recording', async () => {
    const { h, counters, graph } = await setup(
      { script: [ask(call('c1', 'create_issue', { title: 'x' }))] },
      ['createIssue']
    );
    // An approval for the call exists, in the thread's run, and is approved: the gateway admits the call.
    await h.preapprove('t1', TOOL_REFS.create_issue, { title: 'x' });
    await graph.invoke(start(), CFG);
    expect(counters.runs).toHaveLength(1);
    expect(h.seen('POST', /\/consume$/)).toHaveLength(0);
    expect(h.seen('POST', '/v1/records')).toHaveLength(0);
  });

  it('step_up, cannot route, whenUnroutable deny (the default): denies, and sends no continuation', async () => {
    const { h, counters, graph } = await setup({
      advertise: ['decisions', 'records'],
      script: [ask(call('c1', 'send_email', { to: 'a@b.c' }))],
    });
    const result = await graph.invoke(start(), CFG);
    expect((result as { __interrupt__?: unknown }).__interrupt__).toBeUndefined();
    expect(counters.runs).toHaveLength(0);
    expect(denialCodeOf(toolMessages(await messagesOf(graph))[0])).toBe('unroutable');
    expect(decisionBodies(h)[0]?.continuation).toBeUndefined();
    expect(h.seen('POST', '/v1/runs')).toHaveLength(0);
  });

  it('step_up, cannot route, ask-locally: interrupts without a continuation; a yes runs the tool and the record says it was local', async () => {
    const { h, counters, graph } = await setup({
      advertise: ['decisions', 'records'],
      governance: { whenUnroutable: 'ask-locally' },
      script: [ask(call('c1', 'send_email', { to: 'a@b.c' }))],
    });
    const result = await graph.invoke(start(), CFG);
    const interrupts = (result as { __interrupt__?: { value: Record<string, unknown> }[] })
      .__interrupt__;
    expect(interrupts?.[0]?.value).toMatchObject({ local: true, tool_call_id: 'c1' });
    expect(interrupts?.[0]?.value.approval_id).toBeUndefined();
    expect(decisionBodies(h)[0]?.continuation).toBeUndefined();
    await graph.invoke(new Command({ resume: true }), CFG);
    expect(counters.runs).toHaveLength(1);
    const [record] = h.seen('POST', '/v1/records');
    expect(record?.body).toMatchObject({ decision: 'step_up', outcome: { status: 'succeeded' } });
    expect(JSON.stringify(record?.body)).toMatch(/local, unverified/);
    expect((record?.body as { approval_id?: string }).approval_id).toBeUndefined();
  });

  describe("m1: 'ask-locally' is reachable only when the deployment cannot route", () => {
    const askLocally = { whenUnroutable: 'ask-locally' } as const;

    it('against a deployment that routes approvals, the interrupt is the real approval and no local answer is offered', async () => {
      const { h, counters, graph } = await setup({
        governance: askLocally,
        script: [ask(call('c1', 'send_email', { to: 'a@b.c' }))],
      });
      const result = await graph.invoke(start(), CFG);
      const [pending] =
        (result as { __interrupt__?: { value: Record<string, unknown> }[] }).__interrupt__ ?? [];
      expect(pending?.value.approval_id).toBe(h.approvals()[0]);
      expect(pending?.value.local).toBeUndefined();
      expect(decisionBodies(h)[0]?.continuation).toBeDefined();
      // A yes with no signature behind it does not run the tool.
      await graph.invoke(new Command({ resume: true }) as never, CFG);
      expect(counters.runs).toHaveLength(0);
    });

    it('a step_up with no approval handle on a routing deployment is a denial, not a local question', async () => {
      const { h, counters, graph } = await setup({
        governance: askLocally,
        script: [ask(call('c1', 'send_email', { to: 'a@b.c' }))],
      });
      tamper(h, '/v1/decisions', (data) => {
        delete data.approval;
      });
      const result = await graph.invoke(start(), CFG);
      expect((result as { __interrupt__?: unknown }).__interrupt__).toBeUndefined();
      expect(counters.runs).toHaveLength(0);
      expect(denialCodeOf(toolMessages(await messagesOf(graph))[0])).toBe('api_error');
    });

    it('a call with no tool call id on a routing deployment is a denial, and the approval it opened is withdrawn', async () => {
      const h = await createHarness({ governance: askLocally });
      const counters: Counters = { runs: [] };
      const wrapped = governed(makeTools(counters).sendEmail, {
        toolRef: TOOL_REFS.send_email,
        governance: h.governance,
      });
      const answer = (await wrapped.invoke(
        { to: 'a@b.c' },
        { configurable: { thread_id: 't9' } }
      )) as ToolMessage | string;
      expect(denialCodeOf(answer)).toBe('unresumable');
      expect(counters.runs).toHaveLength(0);
      const opened = h.approvals();
      expect(opened).toHaveLength(1);
      expect(h.mock.state.obligations.get(opened[0] ?? '')?.state).toBe('withdrawn');
    });
  });

  it('ask-locally: a no ({ approved: false, reason }) denies; an answer that is neither is refused', async () => {
    const no = await setup({
      advertise: ['decisions', 'records'],
      governance: { whenUnroutable: 'ask-locally' },
      script: [ask(call('c1', 'send_email', { to: 'a@b.c' }))],
    });
    await no.graph.invoke(start(), CFG);
    await no.graph.invoke(new Command({ resume: { approved: false, reason: 'not today' } }), CFG);
    const rejected = toolMessages(await messagesOf(no.graph))[0];
    expect(denialCodeOf(rejected)).toBe('rejected');
    expect(textOf(rejected)).toContain('not today');
    expect(no.counters.runs).toHaveLength(0);

    const garbage = await setup({
      advertise: ['decisions', 'records'],
      governance: { whenUnroutable: 'ask-locally' },
      script: [ask(call('c1', 'send_email', { to: 'a@b.c' }))],
    });
    await garbage.graph.invoke(start(), CFG);
    await garbage.graph.invoke(new Command({ resume: 'sure' }), CFG);
    expect(denialCodeOf(toolMessages(await messagesOf(garbage.graph))[0])).toBe(
      'resumption_invalid'
    );
    expect(garbage.counters.runs).toHaveLength(0);
  });

  it('a 422 continuation_unsupported is "cannot route", whatever the capabilities said', async () => {
    const { h, counters, graph } = await setup({
      script: [ask(call('c1', 'send_email', { to: 'a@b.c' }))],
    });
    h.intercept = (request) =>
      new URL(request.url).pathname === '/v1/decisions'
        ? new Response(
            JSON.stringify({
              type: 'https://docs.noblecloak.com/problems/continuation_unsupported',
              title: 'x',
              status: 422,
            }),
            { status: 422, headers: { 'content-type': 'application/problem+json' } }
          )
        : undefined;
    await graph.invoke(start(), CFG);
    expect(denialCodeOf(toolMessages(await messagesOf(graph))[0])).toBe('unroutable');
    expect(counters.runs).toHaveLength(0);
  });

  it('a 422 with ask-locally interrupts locally', async () => {
    const { h, graph } = await setup({
      governance: { whenUnroutable: 'ask-locally' },
      script: [ask(call('c1', 'send_email', { to: 'a@b.c' }))],
    });
    h.intercept = (request) =>
      new URL(request.url).pathname === '/v1/decisions'
        ? new Response(
            JSON.stringify({
              type: 'https://docs.noblecloak.com/problems/continuation_unsupported',
              title: 'x',
              status: 422,
            }),
            { status: 422, headers: { 'content-type': 'application/problem+json' } }
          )
        : undefined;
    const result = await graph.invoke(start(), CFG);
    expect(
      (result as { __interrupt__?: { value: { local?: boolean } }[] }).__interrupt__?.[0]?.value
        .local
    ).toBe(true);
  });

  it('/v1 unreachable while deciding: a denial, and nothing runs ungoverned', async () => {
    const { h, counters, graph } = await setup(
      { script: [ask(call('c1', 'search', { q: 'x' }))] },
      ['search']
    );
    h.intercept = (request) => {
      if (new URL(request.url).pathname === '/v1/decisions') throw new TypeError('fetch failed');
      return undefined;
    };
    await graph.invoke(start(), CFG);
    expect(denialCodeOf(toolMessages(await messagesOf(graph))[0])).toBe('unreachable');
    expect(counters.runs).toHaveLength(0);
  });

  it('a 5xx while deciding is a denial too', async () => {
    const { h, counters, graph } = await setup(
      { script: [ask(call('c1', 'search', { q: 'x' }))] },
      ['search']
    );
    h.intercept = (request) =>
      new URL(request.url).pathname === '/v1/decisions' ? status(502) : undefined;
    await graph.invoke(start(), CFG);
    expect(denialCodeOf(toolMessages(await messagesOf(graph))[0])).toBe('unreachable');
    expect(counters.runs).toHaveLength(0);
  });

  it('a 4xx the adapter did not expect is api_error, and a denial', async () => {
    const { h, counters, graph } = await setup(
      { script: [ask(call('c1', 'search', { q: 'x' }))] },
      ['search']
    );
    h.intercept = (request) =>
      new URL(request.url).pathname === '/v1/decisions' ? status(403) : undefined;
    await graph.invoke(start(), CFG);
    expect(denialCodeOf(toolMessages(await messagesOf(graph))[0])).toBe('api_error');
    expect(counters.runs).toHaveLength(0);
  });

  it('a refused capabilities read (an expired token) is an api_error denial, not "unreachable", and onError hears it', async () => {
    const errors: [string, string][] = [];
    const { h, counters, graph } = await setup(
      {
        governance: { onError: (e) => errors.push([e.code, e.message]) },
        script: [ask(call('c1', 'search', { q: 'x' }))],
      },
      ['search']
    );
    h.intercept = (request) =>
      new URL(request.url).pathname === '/v1/capabilities' ? status(401) : undefined;
    await graph.invoke(start(), CFG);
    const message = toolMessages(await messagesOf(graph))[0];
    expect(denialCodeOf(message)).toBe('api_error');
    expect(textOf(message)).not.toContain('could not be reached');
    expect(errors).toEqual([['api_error', expect.stringContaining('401') as string]]);
    expect(counters.runs).toHaveLength(0);
  });

  it('an unreachable capabilities read is reported to onError as unreachable', async () => {
    const errors: string[] = [];
    const { h, graph } = await setup(
      {
        governance: { onError: (e) => errors.push(e.code) },
        script: [ask(call('c1', 'search', { q: 'x' }))],
      },
      ['search']
    );
    h.intercept = (request) =>
      new URL(request.url).pathname === '/v1/capabilities' ? status(503) : undefined;
    await graph.invoke(start(), CFG);
    expect(errors).toEqual(['unreachable']);
  });

  it('a decision the API refuses with a 4xx is reported to onError, not only shown to the model', async () => {
    const errors: string[] = [];
    const { h, graph } = await setup(
      {
        governance: { onError: (e) => errors.push(e.code) },
        script: [ask(call('c1', 'search', { q: 'x' }))],
      },
      ['search']
    );
    h.intercept = (request) =>
      new URL(request.url).pathname === '/v1/decisions' ? status(403) : undefined;
    await graph.invoke(start(), CFG);
    expect(errors).toEqual(['api_error']);
  });

  it('an unreadable capabilities answer denies every decision until a read succeeds', async () => {
    const { h, counters, graph } = await setup(
      { script: [ask(call('c1', 'search', { q: 'x' }))] },
      ['search']
    );
    h.intercept = (request) =>
      new URL(request.url).pathname === '/v1/capabilities' ? status(503) : undefined;
    await graph.invoke(start(), CFG);
    expect(denialCodeOf(toolMessages(await messagesOf(graph))[0])).toBe('unreachable');
    expect(h.seen('POST', '/v1/decisions')).toHaveLength(0);
    expect(counters.runs).toHaveLength(0);
    h.intercept = undefined;
    await graph.invoke(start(), { configurable: { thread_id: 't2' } });
    expect(counters.runs).toHaveLength(1);
  });

  it('a decision whose digest differs from the arguments sent is refused', async () => {
    const { h, counters, graph } = await setup(
      { script: [ask(call('c1', 'search', { q: 'x' }))] },
      ['search']
    );
    tamper(h, '/v1/decisions', (data) => {
      data.action_digest = '0'.repeat(64);
    });
    await graph.invoke(start(), CFG);
    expect(denialCodeOf(toolMessages(await messagesOf(graph))[0])).toBe('digest_mismatch');
    expect(counters.runs).toHaveLength(0);
  });

  it('a decision this adapter does not act on (defer) is refused', async () => {
    const { h, counters, graph } = await setup(
      { script: [ask(call('c1', 'search', { q: 'x' }))] },
      ['search']
    );
    tamper(h, '/v1/decisions', (data) => {
      data.decision = 'defer';
    });
    await graph.invoke(start(), CFG);
    expect(denialCodeOf(toolMessages(await messagesOf(graph))[0])).toBe('api_error');
    expect(counters.runs).toHaveLength(0);
  });

  it('approvals advertised without runs: the first use throws runs_required and nothing runs', async () => {
    const h = await createHarness({ advertise: ['approvals', 'records'] });
    const counters: Counters = { runs: [] };
    const { search } = makeTools(counters);
    const wrapped = governed(search, { toolRef: TOOL_REFS.search, governance: h.governance });
    await expect(
      wrapped.invoke({ type: 'tool_call', id: 'c1', name: 'search', args: { q: 'x' } }, CFG)
    ).rejects.toMatchObject({ code: 'runs_required' });
    expect(counters.runs).toHaveLength(0);
    expect(h.seen('POST', '/v1/decisions')).toHaveLength(0);
  });

  it('neither runs nor approvals advertised: skips the run and decides', async () => {
    const { h, counters, graph } = await setup(
      { advertise: ['decisions', 'records'], script: [ask(call('c1', 'search', { q: 'x' }))] },
      ['search']
    );
    await graph.invoke(start(), CFG);
    expect(h.seen('POST', '/v1/runs')).toHaveLength(0);
    expect(decisionBodies(h)[0]?.actor).toBeUndefined();
    expect(counters.runs).toHaveLength(1);
  });

  it('a call with no thread cannot be scoped to a run, so it is denied when the deployment routes approvals', async () => {
    const h = await createHarness();
    const { search } = makeTools({ runs: [] });
    const wrapped = governed(search, { toolRef: TOOL_REFS.search, governance: h.governance });
    const out = (await wrapped.invoke({
      type: 'tool_call',
      id: 'c1',
      name: 'search',
      args: { q: 'x' },
    })) as ToolMessage;
    expect(denialCodeOf(out)).toBe('unresumable');
  });

  it('keeps the name, schema and description of the tool it wraps', async () => {
    const h = await createHarness();
    const { sendEmail } = makeTools({ runs: [] });
    const wrapped = governed(sendEmail, {
      toolRef: TOOL_REFS.send_email,
      governance: h.governance,
    });
    expect(wrapped.name).toBe('send_email');
    expect(wrapped.description).toBe('Send an email.');
    expect(wrapped.schema).toBe(sendEmail.schema);
  });

  it('governedToolNode refuses a tool with no toolRef: it is never derived from the name', async () => {
    const h = await createHarness();
    const { search } = makeTools({ runs: [] });
    expect(() => governedToolNode([search], { toolRefs: {}, governance: h.governance })).toThrow(
      /no toolRef/
    );
  });

  it('a tool that throws after the approval was consumed: the approval is spent, the record says failed, a retry needs a new approval', async () => {
    const { h, counters, graph } = await setup({
      failSend: true,
      script: [
        ask(call('c1', 'send_email', { to: 'a@b.c' })),
        ask(call('c2', 'send_email', { to: 'a@b.c' })),
      ],
    });
    await graph.invoke(start(), CFG);
    const [id = ''] = h.approvals();
    await h.approve(id);
    await resumeApproval(graph, id, { governance: h.governance });
    expect(counters.runs).toHaveLength(1);
    const [record] = h.seen('POST', '/v1/records');
    expect(record?.body).toMatchObject({
      approval_id: id,
      outcome: { status: 'failed', error: 'smtp down' },
    });
    expect(h.mock.state.obligations.get(id)?.state).toBe('consumed');
    // The model retries the same call: it needs an approval of its own.
    const state = await graph.getState(CFG);
    expect(state.tasks[0]?.interrupts).toHaveLength(1);
    expect(h.approvals()).toHaveLength(2);
    expect(counters.runs).toHaveLength(1);
  });
});

describe("governed: onRecordFailure 'throw' fails loudly when an outcome record cannot be written (D-LG13)", () => {
  const FAST_RETRY = { recordRetry: { attempts: 3, backoffMs: 1, maxBackoffMs: 2 } } as const;

  /** 'throw', and by default a tool node that does not turn a thrown error into a message: the run itself fails. */
  async function failingRun(
    options: HarnessOptions & { handleToolErrors?: boolean },
    script = [ask(call('c1', 'search', { q: 'x' }))]
  ) {
    const h = await createHarness({
      ...options,
      governance: { ...options.governance, onRecordFailure: 'throw' },
    });
    const counters: Counters = { runs: [] };
    const made = makeTools(counters);
    const graph = buildGraph({
      script,
      toolNode: governedToolNode([made.search, made.sendEmail], {
        toolRefs: TOOL_REFS,
        governance: h.governance,
        handleToolErrors: options.handleToolErrors ?? false,
      }),
    });
    return { h, counters, graph };
  }

  it('the record endpoint is down: the node throws record_failed after the tool ran once, and every attempt carries one idempotency key', async () => {
    const errors: string[] = [];
    const { h, counters, graph } = await failingRun({
      governance: { ...FAST_RETRY, onError: (e) => errors.push(e.code) },
    });
    h.intercept = (request) =>
      new URL(request.url).pathname === '/v1/records' ? status(503) : undefined;
    await expect(graph.invoke(start(), CFG)).rejects.toMatchObject({ code: 'record_failed' });
    expect(counters.runs).toHaveLength(1);
    const attempts = h.seen('POST', '/v1/records');
    expect(attempts).toHaveLength(3);
    expect(new Set(attempts.map((r) => r.headers['idempotency-key'])).size).toBe(1);
    expect(errors).toEqual(['record_failed']);
  });

  it('the error carries no tool output', async () => {
    const { h, graph } = await failingRun({ governance: FAST_RETRY });
    h.intercept = (request) =>
      new URL(request.url).pathname === '/v1/records' ? status(503) : undefined;
    const error = (await graph.invoke(start(), CFG).catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain('found x');
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('found x');
  });

  it('a transient failure, then success: the result is returned, there is one record, and no error is reported', async () => {
    const errors: string[] = [];
    const { h, counters, graph } = await failingRun({
      governance: { ...FAST_RETRY, onError: (e) => errors.push(e.code) },
    });
    let failures = 2;
    h.intercept = (request) =>
      new URL(request.url).pathname === '/v1/records' && failures-- > 0 ? status(503) : undefined;
    await graph.invoke(start(), CFG);
    expect(counters.runs).toHaveLength(1);
    expect(h.mock.state.records).toHaveLength(1);
    const attempts = h.seen('POST', '/v1/records');
    expect(attempts).toHaveLength(3);
    expect(new Set(attempts.map((r) => r.headers['idempotency-key'])).size).toBe(1);
    expect(toolMessages(await messagesOf(graph))[0]?.content).toBe('found x');
    expect(errors).toEqual([]);
  });

  it('a record the server refuses (4xx) is not retried, and fails the node too', async () => {
    const { h, counters, graph } = await failingRun({ governance: FAST_RETRY });
    h.intercept = (request) =>
      new URL(request.url).pathname === '/v1/records' ? status(400) : undefined;
    await expect(graph.invoke(start(), CFG)).rejects.toMatchObject({ code: 'record_failed' });
    expect(counters.runs).toHaveLength(1);
    expect(h.seen('POST', '/v1/records')).toHaveLength(1);
  });

  it('a throttled record (429) is retried', async () => {
    const { h, graph } = await failingRun({ governance: FAST_RETRY });
    let throttled = 1;
    h.intercept = (request) =>
      new URL(request.url).pathname === '/v1/records' && throttled-- > 0 ? status(429) : undefined;
    await graph.invoke(start(), CFG);
    expect(h.mock.state.records).toHaveLength(1);
    expect(h.seen('POST', '/v1/records')).toHaveLength(2);
  });

  it('a gated call whose record fails: the approval is consumed, the tool ran once, and the resumer is told', async () => {
    const { h, counters, graph } = await failingRun({ governance: FAST_RETRY }, [
      ask(call('c1', 'send_email', { to: 'a@b.c' })),
    ]);
    await graph.invoke(start(), CFG);
    const [id = ''] = h.approvals();
    await h.approve(id);
    h.intercept = (request) =>
      new URL(request.url).pathname === '/v1/records' ? status(503) : undefined;
    await expect(resumeApproval(graph, id, { governance: h.governance })).rejects.toMatchObject({
      code: 'record_failed',
    });
    expect(counters.runs).toHaveLength(1);
    expect(h.mock.state.obligations.get(id)?.state).toBe('consumed');
    expect(h.mock.state.records).toHaveLength(0);
  });

  it("'throw' under the ToolNode default: the model reads the error instead of the tool result, and onError hears it", async () => {
    const errors: string[] = [];
    const { h, counters, graph } = await failingRun({
      handleToolErrors: true,
      governance: { ...FAST_RETRY, onError: (e) => errors.push(e.code) },
    });
    h.intercept = (request) =>
      new URL(request.url).pathname === '/v1/records' ? status(503) : undefined;
    await graph.invoke(start(), CFG);
    expect(counters.runs).toHaveLength(1);
    const [message] = toolMessages(await messagesOf(graph));
    expect(message?.status).toBe('error');
    expect(textOf(message)).not.toContain('found x');
    expect(errors).toEqual(['record_failed']);
  });

  it('the retries are bounded: the wait never grows past maxBackoffMs, and the attempts are the configured number', async () => {
    const { h, graph } = await failingRun({
      governance: { recordRetry: { attempts: 5, backoffMs: 1, maxBackoffMs: 3 } },
    });
    h.intercept = (request) =>
      new URL(request.url).pathname === '/v1/records' ? status(503) : undefined;
    await expect(graph.invoke(start(), CFG)).rejects.toMatchObject({ code: 'record_failed' });
    expect(h.seen('POST', '/v1/records')).toHaveLength(5);
  });
});

describe("m6: peekResume reads LangGraph's private scratchpad", () => {
  /** A node that peeks, then interrupts: records what each saw. */
  function probe() {
    const peeked: unknown[] = [];
    const taken: unknown[] = [];
    const graph = new StateGraph(MessagesAnnotation)
      .addNode('n', (_state, config) => {
        peeked.push(peekResume(config));
        taken.push(interrupt({ approval_id: 'x' }));
        return { messages: [] };
      })
      .addEdge(START, 'n')
      .addEdge('n', END)
      .compile({ checkpointer: new MemorySaver() });
    return { graph, peeked, taken };
  }
  const value = { kind: 'answered', approval_id: 'x' };

  it("pinned to the installed LangGraph: nothing before a resume, and the resume value (not interrupt()'s map) before interrupt() takes it", async () => {
    const { graph, peeked, taken } = probe();
    const config = { configurable: { thread_id: 'pin-1' } };
    await graph.invoke({ messages: [] }, config);
    await graph.invoke(new Command({ resume: value }) as never, config);
    expect(peeked).toEqual([undefined, value]);
    expect(taken).toEqual([value]);
  });

  it('pinned: the same when the resume is addressed by interrupt id, as resumeApproval does', async () => {
    const { graph, peeked, taken } = probe();
    const config = { configurable: { thread_id: 'pin-2' } };
    await graph.invoke({ messages: [] }, config);
    const state = await graph.getState(config);
    const id = state.tasks[0]?.interrupts[0]?.id ?? '';
    expect(id).not.toBe('');
    await graph.invoke(new Command({ resume: { [id]: value } }) as never, config);
    expect(peeked).toEqual([undefined, value]);
    expect(taken).toEqual([value]);
  });

  it('fails closed: a scratchpad of a shape it does not know reads as no resume', () => {
    expect(peekResume({})).toBeUndefined();
    expect(peekResume({ configurable: {} })).toBeUndefined();
    expect(peekResume({ configurable: { __pregel_scratchpad: 'x' } })).toBeUndefined();
    expect(
      peekResume({ configurable: { __pregel_scratchpad: { resume: {}, interruptCounter: 0 } } })
    ).toBeUndefined();
    expect(
      peekResume({
        configurable: { __pregel_scratchpad: { resume: [value], interruptCounter: 'a' } },
      })
    ).toBeUndefined();
    expect(
      peekResume({ configurable: { __pregel_scratchpad: { resume: [], interruptCounter: 5 } } })
    ).toBeUndefined();
  });
});

describe('governed: two gated calls in one model message (D-LG11)', () => {
  const script = [
    ask(call('c1', 'send_email', { to: 'a' }), call('c2', 'send_email', { to: 'b' })),
    // After the first approval the model, told to retry, asks for the second call again.
    ask(call('c3', 'send_email', { to: 'b' })),
  ];

  it('the first pauses, the second is denied with the retry message, and the retried call goes through its own approval', async () => {
    const { h, counters, graph } = await setup({ script });
    // The earlier call's answer arrives later than the other's: the choice is by position, not timing.
    h.intercept = async (request, body) => {
      const to = (body as { action?: { arguments?: { to?: string } } } | undefined)?.action
        ?.arguments?.to;
      if (new URL(request.url).pathname === '/v1/decisions' && to === 'a') {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return undefined;
    };
    const first = await graph.invoke(start(), CFG);
    const pending = (first as { __interrupt__?: { value: { tool_call_id: string } }[] })
      .__interrupt__;
    expect(pending?.map((p) => p.value.tool_call_id)).toEqual(['c1']);
    // The later call is decided without a continuation: it opens nothing the retry cannot take over.
    const bodies = decisionBodies(h);
    expect(
      bodies.find((b) => (b.action.arguments as { to: string }).to === 'a')?.continuation
    ).toBeDefined();
    expect(
      bodies.find((b) => (b.action.arguments as { to: string }).to === 'b')?.continuation
    ).toBeUndefined();
    expect(counters.runs).toHaveLength(0);

    const [first_id = ''] = h.approvals();
    await h.approve(first_id);
    await resumeApproval(graph, first_id, { governance: h.governance });
    // c1 ran; c2 was denied again on the re-run (its sibling still held the pause) with the retry message.
    expect(counters.runs.map((r) => r.args)).toEqual([{ to: 'a', note: 'hello' }]);
    const denied = toolMessages(await messagesOf(graph)).find((m) => m.tool_call_id === 'c2');
    expect(denialCodeOf(denied)).toBe('approval_pending_in_task');
    expect(textOf(denied)).toMatch(/Retry this call after that approval resolves/);

    // The retry (c3) pauses for the approval of its own and then runs.
    const state = await graph.getState(CFG);
    expect(state.tasks[0]?.interrupts[0]?.value).toMatchObject({ tool_call_id: 'c3' });
    const second =
      h
        .approvals()
        .find((id) => id !== first_id && h.mock.state.obligations.get(id)?.state === 'pending') ??
      '';
    await h.approve(second);
    await resumeApproval(graph, second, { governance: h.governance });
    expect(counters.runs.map((r) => (r.args as { to: string }).to)).toEqual(['a', 'b']);
  });

  it('m5: the call that pauses is the one earliest in the message, whichever tool call enters the task first', async () => {
    const h = await createHarness({});
    const counters: Counters = { runs: [] };
    const made = makeTools(counters);
    const email = governed(made.sendEmail, {
      toolRef: TOOL_REFS.send_email,
      governance: h.governance,
    });
    // A tool node that starts the calls in reverse: the later call of the message enters the task first.
    const reversed = async (
      state: { messages: BaseMessage[] },
      config: Record<string, unknown>
    ): Promise<{ messages: ToolMessage[] }> => {
      const message = [...state.messages].reverse().find((m) => AIMessage.isInstance(m));
      const calls = [...((message as AIMessage | undefined)?.tool_calls ?? [])].reverse();
      const outputs = await Promise.all(
        calls.map(
          (c) =>
            email.invoke(
              { ...c, type: 'tool_call' } as never,
              { ...config, state, toolCallId: c.id ?? '' } as never
            ) as Promise<ToolMessage>
        )
      );
      return { messages: outputs };
    };
    const graph = buildGraph({
      script: [ask(call('c1', 'send_email', { to: 'a' }), call('c2', 'send_email', { to: 'b' }))],
      toolNode: { invoke: reversed } as never,
    });
    const result = await graph.invoke(start(), CFG);
    const pending = (result as { __interrupt__?: { value: { tool_call_id: string } }[] })
      .__interrupt__;
    expect(pending?.map((p) => p.value.tool_call_id)).toEqual(['c1']);
  });

  it('m2: a call denied with the retry message leaves no open approval behind, and its retry opens its own', async () => {
    const { h, counters, graph } = await setup({ script });
    await graph.invoke(start(), CFG);
    const open = (): string[] =>
      [...h.mock.state.obligations.values()]
        .filter((o) => o.state === 'pending' || o.state === 'approved')
        .map((o) => o.id);
    // The sibling is decided after the node paused: give its answer time to arrive.
    const [first = ''] = h.approvals();
    await vi.waitFor(() => {
      expect(h.approvals()).toHaveLength(2);
      expect(open()).toEqual([first]);
    });
    // The sibling's approval was opened without a continuation and is withdrawn: only the pausing call's is open.
    const denied = h.approvals()[1] ?? '';
    expect(h.mock.state.obligations.get(denied)?.state).toBe('withdrawn');
    await h.approve(first);
    await resumeApproval(graph, first, { governance: h.governance });
    expect(counters.runs).toHaveLength(1);
    // The retry (c3) is decided afresh: a pending approval of its own, carrying its own continuation.
    const [retry = ''] = open();
    expect(retry).not.toBe(first);
    expect(retry).not.toBe(denied);
    expect(h.mock.state.obligations.get(retry)?.continuation.correlation).toMatchObject({
      tool_call_id: 'c3',
    });
    expect(open()).toEqual([retry]);
    expect(toolMessages(await messagesOf(graph)).map((m) => denialCodeOf(m))).not.toContain(
      'continuation_conflict'
    );
  });

  it('adv-2: after the pausing call is rejected, its sibling is still told to retry, and no approval is opened for the re-run', async () => {
    const { h, counters, graph } = await setup({ script });
    await graph.invoke(start(), CFG);
    const [id = ''] = h.approvals();
    await h.reject(id, 'no');
    await resumeApproval(graph, id, { governance: h.governance });
    expect(counters.runs).toHaveLength(0);
    const messages = toolMessages(await messagesOf(graph));
    expect(denialCodeOf(messages.find((m) => m.tool_call_id === 'c1'))).toBe('rejected');
    expect(denialCodeOf(messages.find((m) => m.tool_call_id === 'c2'))).toBe(
      'approval_pending_in_task'
    );
    // Only the retry (c3) holds an approval besides the rejected one: the re-run's own is withdrawn.
    await vi.waitFor(() => {
      const kept = h
        .approvals()
        .filter((approval) => h.mock.state.obligations.get(approval)?.state !== 'withdrawn');
      expect(kept).toHaveLength(2);
    });
  });

  it('the earlier call needs no approval: both are decided on their own, and it runs once, after the approval', async () => {
    const { h, counters, graph } = await setup(
      {
        script: [ask(call('c1', 'search', { q: 'x' }), call('c2', 'send_email', { to: 'b' }))],
      },
      ['search', 'sendEmail']
    );
    const result = await graph.invoke(start(), CFG);
    const pending = (result as { __interrupt__?: { value: { tool_call_id: string } }[] })
      .__interrupt__;
    expect(pending?.map((p) => p.value.tool_call_id)).toEqual(['c2']);
    // D-LG14: the allowed call waits for the pause; nothing ran on the pass that paused the node.
    expect(counters.runs).toHaveLength(0);
    const [id = ''] = h.approvals();
    await h.approve(id);
    await resumeApproval(graph, id, { governance: h.governance });
    expect(counters.runs.map((r) => r.name).sort()).toEqual(['search', 'send_email']);
  });
});

describe('governed: allowed calls of one model message', () => {
  it('adv-4: run side by side; a slow tool does not hold back the next call', async () => {
    const log: string[] = [];
    const { counters, graph } = await setup(
      {
        searchDelayMs: 150,
        log,
        script: [ask(call('c1', 'search', { q: 'one' }), call('c2', 'search', { q: 'two' }))],
      },
      ['search']
    );
    await graph.invoke(start(), CFG);
    expect(counters.runs).toHaveLength(2);
    // Both started before either ended.
    expect(log.slice(0, 2).sort()).toEqual(['start one', 'start two']);
  });

  it('adv-4: a hung allowed tool does not hold back the decision of a later call', async () => {
    const log: string[] = [];
    const { h, graph } = await setup(
      {
        searchDelayMs: 300,
        log,
        script: [
          ask(call('c1', 'search', { q: 'one' }), call('c2', 'delete_account', { id: '9' })),
        ],
      },
      ['search', 'deleteAccount']
    );
    const result = graph.invoke(start(), CFG);
    // The later call is decided (and denied) while the first one's tool is still running.
    await vi.waitFor(
      () => {
        expect(h.seen('POST', '/v1/decisions')).toHaveLength(2);
        expect(log).toContain('start one');
      },
      { timeout: 250 }
    );
    expect(log).not.toContain('end one');
    await result;
  });

  it('D-LG14: a gated call that decides late still keeps an allowed call that is ahead of it from running', async () => {
    const { h, counters, graph } = await setup(
      { script: [ask(call('c1', 'search', { q: 'x' }), call('c2', 'send_email', { to: 'b' }))] },
      ['search', 'sendEmail']
    );
    // The gated call's answer arrives long after the allowed one's.
    h.intercept = async (request, body) => {
      const to = (body as { action?: { arguments?: { to?: string } } } | undefined)?.action
        ?.arguments?.to;
      if (new URL(request.url).pathname === '/v1/decisions' && to === 'b') {
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      return undefined;
    };
    const result = await graph.invoke(start(), CFG);
    expect((result as { __interrupt__?: unknown[] }).__interrupt__).toHaveLength(1);
    expect(counters.runs).toHaveLength(0);
  });

  it('D-LG14: the same holds for governed tools in a stock ToolNode', async () => {
    const h = await createHarness({});
    const counters: Counters = { runs: [] };
    const made = makeTools(counters);
    const graph = buildGraph({
      script: [ask(call('c1', 'search', { q: 'x' }), call('c2', 'send_email', { to: 'b' }))],
      toolNode: new ToolNode([
        governed(made.search, { toolRef: TOOL_REFS.search, governance: h.governance }),
        governed(made.sendEmail, { toolRef: TOOL_REFS.send_email, governance: h.governance }),
      ]),
    });
    await graph.invoke(start(), CFG);
    expect(counters.runs).toHaveLength(0);
    const [id = ''] = h.approvals();
    await h.approve(id);
    await resumeApproval(graph, id, { governance: h.governance });
    expect(counters.runs.map((r) => r.name).sort()).toEqual(['search', 'send_email']);
  });

  it('D-LG14: calls of a task where nothing pauses still run side by side', async () => {
    const log: string[] = [];
    const { counters, graph } = await setup(
      {
        searchDelayMs: 150,
        log,
        script: [
          ask(
            call('c1', 'search', { q: 'one' }),
            call('c2', 'search', { q: 'two' }),
            call('c3', 'delete_account', { id: '9' })
          ),
        ],
      },
      ['search', 'deleteAccount']
    );
    await graph.invoke(start(), CFG);
    expect(counters.runs.map((r) => r.name)).toEqual(['search', 'search']);
    expect(log.slice(0, 2).sort()).toEqual(['start one', 'start two']);
  });
});

describe('governed: the ledger keeps one record per execution', () => {
  it('D-LG14: an allowed sibling of a call that pauses runs once, after the approval, with one record', async () => {
    const { h, counters, graph } = await setup(
      {
        script: [ask(call('c1', 'search', { q: 'x' }), call('c2', 'send_email', { to: 'a@b.c' }))],
      },
      ['search', 'sendEmail']
    );
    await graph.invoke(start(), CFG);
    const [id = ''] = h.approvals();
    await h.approve(id);
    await resumeApproval(graph, id, { governance: h.governance });
    expect(counters.runs.map((r) => r.name).sort()).toEqual(['search', 'send_email']);
    const listed = (await (
      await h.as(h.tokens.creator, 'GET', '/v1/records?tool=mcp:tracker:search')
    ).json()) as { data: unknown[] };
    expect(listed.data).toHaveLength(1);
  });

  it('D-LG14: a rejection lets the allowed sibling run once, and the rejected call never runs', async () => {
    const { h, counters, graph } = await setup(
      {
        script: [ask(call('c1', 'search', { q: 'x' }), call('c2', 'send_email', { to: 'a@b.c' }))],
      },
      ['search', 'sendEmail']
    );
    await graph.invoke(start(), CFG);
    const [id = ''] = h.approvals();
    await h.reject(id, 'no');
    await resumeApproval(graph, id, { governance: h.governance });
    expect(counters.runs.map((r) => r.name)).toEqual(['search']);
    const messages = toolMessages(await messagesOf(graph));
    expect(messages.find((m) => m.tool_call_id === 'c1')?.content).toBe('found x');
    expect(denialCodeOf(messages.find((m) => m.tool_call_id === 'c2'))).toBe('rejected');
  });

  it('D-LG14: two allowed siblings and a gated one: each allowed call runs once after the approval', async () => {
    const { h, counters, graph } = await setup(
      {
        script: [
          ask(
            call('c1', 'search', { q: 'one' }),
            call('c2', 'send_email', { to: 'a@b.c' }),
            call('c3', 'search', { q: 'two' })
          ),
        ],
      },
      ['search', 'sendEmail']
    );
    await graph.invoke(start(), CFG);
    expect(counters.runs).toHaveLength(0);
    const [id = ''] = h.approvals();
    await h.approve(id);
    await resumeApproval(graph, id, { governance: h.governance });
    expect(counters.runs.map((r) => r.name).sort()).toEqual(['search', 'search', 'send_email']);
    expect(h.mock.state.records).toHaveLength(3);
  });
});

describe('governed: the principal an approval is opened as (D-LG15)', () => {
  it('reports the principal when it opens an approval, and not when the re-run finds the approval already open', async () => {
    const opened: { approvalId: string; toolRef: string; principal: string | undefined }[] = [];
    const { h, graph } = await setup({
      governance: { onApprovalOpened: (o) => opened.push(o) },
      script: [ask(call('c1', 'send_email', { to: 'a@b.c' }))],
    });
    await graph.invoke(start(), CFG);
    const [id = ''] = h.approvals();
    await h.approve(id);
    await resumeApproval(graph, id, { governance: h.governance });
    expect(opened).toEqual([
      {
        approvalId: id,
        toolRef: TOOL_REFS.send_email,
        principal: principalOfToken(h.tokens.creator),
      },
    ]);
  });

  it('logs the first approval it opens once when no callback is given', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const { graph } = await setup({ script: [ask(call('c1', 'send_email', { to: 'a@b.c' }))] });
      await graph.invoke(start(), CFG);
      expect(info).toHaveBeenCalledTimes(1);
      expect(String(info.mock.calls[0]?.[0])).toMatch(/opened approval .* as principal /);
    } finally {
      info.mockRestore();
    }
  });

  it('an expected principal that is another refuses the call with principal_mismatch, says so to the builder, and asks nothing of /v1', async () => {
    const errors: string[] = [];
    const { h, counters, graph } = await setup({
      governance: { expectedPrincipal: 'the-worker', onError: (e) => errors.push(e.code) },
      script: [ask(call('c1', 'send_email', { to: 'a@b.c' }))],
    });
    // The stock tool node writes a thrown error into the thread as an error message.
    await graph.invoke(start(), CFG);
    const [refused] = toolMessages(await messagesOf(graph));
    expect(textOf(refused)).toContain('runs as principal');
    expect(errors).toContain('principal_mismatch');
    expect(counters.runs).toHaveLength(0);
    expect(h.seen('POST', '/v1/decisions')).toHaveLength(0);
    expect(h.seen('GET', '/v1/capabilities')).toHaveLength(0);
  });

  it('an expected principal that cannot be learned refuses the call with principal_unavailable', async () => {
    const errors: string[] = [];
    const { h, graph } = await setup({
      governance: {
        expectedPrincipal: 'the-worker',
        getToken: () => 'opaque-token',
        onError: (e) => errors.push(e.code),
      },
      script: [ask(call('c1', 'send_email', { to: 'a@b.c' }))],
    });
    await graph.invoke(start(), CFG);
    const [refused] = toolMessages(await messagesOf(graph));
    expect(textOf(refused)).toContain('no readable sub claim');
    expect(errors).toContain('principal_unavailable');
    expect(h.seen('POST', '/v1/decisions')).toHaveLength(0);
  });

  describe('a token provider whose sub changes after the first call', () => {
    const SECOND = { configurable: { thread_id: 't2' } };
    const arrange = async (expectedPrincipal: boolean) => {
      const probe = await createHarness();
      const source: { h?: Harness } = {};
      let swapped = false;
      const errors: string[] = [];
      const made = await setup(
        {
          governance: {
            ...(expectedPrincipal
              ? { expectedPrincipal: principalOfToken(probe.tokens.creator) ?? '' }
              : {}),
            getToken: () =>
              swapped ? (source.h?.tokens.approver ?? '') : (source.h?.tokens.creator ?? ''),
            onError: (e) => errors.push(e.code),
          },
          script: [ask(call('c1', 'search', { q: 'x' }))],
        },
        ['search']
      );
      source.h = made.h;
      return { ...made, errors, swap: () => (swapped = true) };
    };

    it('with expectedPrincipal the next governed call is refused with principal_mismatch: the tool does not run and no decision is posted', async () => {
      const { h, counters, graph, errors, swap } = await arrange(true);
      await graph.invoke(start(), CFG);
      expect(counters.runs).toHaveLength(1);
      const decided = h.seen('POST', '/v1/decisions').length;
      swap();
      await graph.invoke(start(), SECOND);
      const [refused] = toolMessages(await messagesOf(graph, SECOND));
      expect(textOf(refused)).toContain('runs as principal');
      expect(errors).toContain('principal_mismatch');
      expect(counters.runs).toHaveLength(1);
      expect(h.seen('POST', '/v1/decisions')).toHaveLength(decided);
    });

    it('without expectedPrincipal a changed sub is not checked', async () => {
      const { counters, graph, errors, swap } = await arrange(false);
      await graph.invoke(start(), CFG);
      swap();
      await graph.invoke(start(), SECOND);
      expect(counters.runs).toHaveLength(2);
      expect(errors).toEqual([]);
    });
  });
});

describe('governed: a tool the deployment executes, wrapped as a local function (not_locally_executable)', () => {
  const pendingInterrupts = (result: unknown): unknown =>
    (result as { __interrupt__?: unknown }).__interrupt__;

  it('is denied up front, before anyone is asked: no pause, the tool is not called, and the approval this call opened is withdrawn', async () => {
    const errors: { code: string; message: string }[] = [];
    const { h, counters, graph } = await setup(
      {
        governance: {
          onError: (e) => errors.push({ code: e.code, message: e.message }),
        },
        script: [ask(call('c1', 'create_issue', { title: 'x' }))],
      },
      ['createIssue']
    );
    const result = await graph.invoke(start(), CFG);
    expect(pendingInterrupts(result)).toBeUndefined();
    expect(counters.runs).toHaveLength(0);
    const [denied] = toolMessages(await messagesOf(graph));
    expect(denialCodeOf(denied)).toBe('not_locally_executable');
    expect(textOf(denied)).toMatch(/executed by the deployment/);
    expect(textOf(denied)).toMatch(/not run/);
    // The decision opened one approval, and the adapter withdrew it: nothing is left pending.
    const [id = ''] = h.approvals();
    expect(h.approvals()).toHaveLength(1);
    expect(h.mock.state.obligations.get(id)?.state).toBe('withdrawn');
    expect(h.seen('POST', `/v1/approvals/${id}/withdraw`)).toHaveLength(1);
    expect(h.seen('POST', /\/consume$/)).toHaveLength(0);
    expect(h.seen('POST', '/v1/records')).toHaveLength(0);
    // The builder is told, with the approval's id and what to do.
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('not_locally_executable');
    expect(errors[0]?.message).toContain(`approval ${id}`);
    expect(errors[0]?.message).toMatch(/resume_token_will_issue false.*through the gateway/);
    expect(errors[0]?.message).toMatch(/was withdrawn/);
    // The denial says what became of the approval, and not that none was asked for.
    expect(textOf(denied)).toContain('The approval this call opened was withdrawn.');
    expect(textOf(denied)).not.toMatch(/no approval was asked for/);
  });

  it('when the withdraw fails, neither the report nor the denial says it was withdrawn', async () => {
    const errors: { code: string; message: string }[] = [];
    const { h, counters, graph } = await setup(
      {
        governance: { onError: (e) => errors.push({ code: e.code, message: e.message }) },
        script: [ask(call('c1', 'create_issue', { title: 'x' }))],
      },
      ['createIssue']
    );
    h.intercept = (request) =>
      new URL(request.url).pathname.endsWith('/withdraw') ? status(503) : undefined;
    await graph.invoke(start(), CFG);
    expect(counters.runs).toHaveLength(0);
    const [denied] = toolMessages(await messagesOf(graph));
    expect(denialCodeOf(denied)).toBe('not_locally_executable');
    expect(textOf(denied)).toContain('could not be withdrawn');
    expect(textOf(denied)).not.toMatch(/was withdrawn|no approval was asked for/);
    const [id = ''] = h.approvals();
    const still = await h.governance.api.getApproval(id);
    expect(still.ok && still.data.state).toBe('pending');
    const refusal = errors.find((e) => e.code === 'not_locally_executable');
    expect(refusal?.message).toContain('could not be withdrawn and stays open until it expires');
    expect(refusal?.message).not.toMatch(/call opened was withdrawn/);
    expect(errors.map((e) => e.code)).toContain('api_error');
  });

  it('a repeat of the call is denied the same way, opens its own approval and withdraws it: the model is never left waiting', async () => {
    const { h, counters, graph } = await setup(
      {
        script: [
          ask(call('c1', 'create_issue', { title: 'x' })),
          ask(call('c2', 'create_issue', { title: 'x' })),
        ],
      },
      ['createIssue']
    );
    await graph.invoke(start(), CFG);
    const codes = toolMessages(await messagesOf(graph)).map((m) => denialCodeOf(m));
    expect(codes).toEqual(['not_locally_executable', 'not_locally_executable']);
    expect(counters.runs).toHaveLength(0);
    expect(h.approvals().map((id) => h.mock.state.obligations.get(id)?.state)).toEqual([
      'withdrawn',
      'withdrawn',
    ]);
  });

  it("leaves an approval alone that this call only matched: another call opened it, so it is not this call's to withdraw", async () => {
    const errors: string[] = [];
    const { h, counters, graph } = await setup(
      {
        governance: { onError: (e) => errors.push(e.code) },
        script: [ask(call('c1', 'create_issue', { title: 'x' }))],
      },
      ['createIssue']
    );
    // The same call, in the same run, was already decided and is pending: this call matches it (`created: false`).
    const runId = await h.governance.runFor('t1');
    const opened = await h.as(h.tokens.creator, 'POST', '/v1/decisions', {
      actor: { run_id: runId },
      action: { tool_ref: TOOL_REFS.create_issue, arguments: { title: 'x' } },
    });
    const earlier = (
      (await opened.json()) as { data: { approval: { id: string; created: boolean } } }
    ).data.approval;
    expect(earlier.created).toBe(true);
    const result = await graph.invoke(start(), CFG);
    expect(pendingInterrupts(result)).toBeUndefined();
    expect(counters.runs).toHaveLength(0);
    const [denied] = toolMessages(await messagesOf(graph));
    expect(denialCodeOf(denied)).toBe('not_locally_executable');
    const decided = decisionBodies(h);
    expect(decided).toHaveLength(1);
    expect(h.approvals()).toEqual([earlier.id]);
    expect(h.mock.state.obligations.get(earlier.id)?.state).toBe('pending');
    expect(h.seen('POST', /\/withdraw$/)).toHaveLength(0);
    expect(errors).toEqual(['not_locally_executable']);
    expect(textOf(denied)).toContain('another call opened');
    expect(textOf(denied)).not.toMatch(/was withdrawn|no approval was asked for/);
  });

  it('is not the answer for a plain allow, a tool the caller executes, or a deployment that cannot route approvals', async () => {
    // A tool the caller executes pauses as before: resume_token_will_issue is true.
    const caller = await setup({ script: [ask(call('c1', 'send_email', { to: 'a@b.c' }))] }, [
      'sendEmail',
    ]);
    const paused = await caller.graph.invoke(start(), CFG);
    expect(pendingInterrupts(paused)).toBeDefined();
    expect(caller.h.mock.state.obligations.get(caller.h.approvals()[0] ?? '')?.state).toBe(
      'pending'
    );
    // An allowed call runs and records, with no handle in play.
    const allowed = await setup({ script: [ask(call('c1', 'search', { q: 'x' }))] }, ['search']);
    await allowed.graph.invoke(start(), CFG);
    expect(allowed.counters.runs).toHaveLength(1);
    expect(allowed.h.seen('POST', '/v1/records')).toHaveLength(1);
  });
});
