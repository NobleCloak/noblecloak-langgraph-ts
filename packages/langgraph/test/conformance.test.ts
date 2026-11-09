/**
 * Adapter conformance: real graphs with a persistent (SQLite) checkpointer, driven against the spec
 * package's mock. Each scenario builds its agent and its worker from separate graph and governance
 * instances over the same checkpointer file, as two processes would. Every negative is shown able to
 * fail: the mock can be told to misbehave (`breaks`), and the ledger-gap scenario runs a deliberately
 * broken adapter through the same assertions.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { beforeAll, describe, expect, it } from 'vitest';

import { denialCodeOf } from '../src/denial.js';
import { governed, governedToolNode } from '../src/governed.js';
import type { Governance } from '../src/governance.js';
import { resumeApproval } from '../src/resume.js';
import { governanceMiddleware } from '../src/middleware.js';
import { runResumer, waitAndResume } from '../src/worker.js';
import { ask, buildAgent, buildGraph, call, makeTools, start, textOf, TOOL_REFS } from './graph.js';
import type { Counters } from './graph.js';
import { createHarness, status } from './harness.js';
import type { Harness, HarnessOptions } from './harness.js';
import { sleep, until } from './wait.js';

/** The three ways a builder governs an agent; every scenario runs through each. */
const ENTRY_POINTS = [
  'governed',
  'governedToolNode',
  // createAgent's default tool behaviour (`v2`): one task per tool call.
  'governanceMiddleware',
  // createAgent's `v1` tool behaviour: one task per model message, as a ToolNode runs it.
  'governanceMiddleware (v1 tool node)',
] as const;
type EntryPoint = (typeof ENTRY_POINTS)[number];
/** Set by the `beforeAll` of the entry point whose scenarios are running (a file runs its tests in order). */
let entryPoint: EntryPoint = 'governedToolNode';

type Graph = ReturnType<typeof buildGraph> | ReturnType<typeof buildAgent>;
const THREAD = { configurable: { thread_id: 'conformance-thread' } };

type ToolRefName = keyof typeof TOOL_REFS;
type ToolName = 'search' | 'sendEmail' | 'deleteAccount' | 'createIssue';

/** An agent or a worker: its own checkpointer connection, its own governance, the same tools. */
function process_(
  h: Harness,
  file: string,
  counters: Counters,
  options: {
    script?: Parameters<typeof buildGraph>[0]['script'];
    governance?: Governance;
    tools?: ToolName[];
    failSend?: boolean;
  } = {}
): { graph: Graph; governance: Governance } {
  const governance = options.governance ?? h.anotherGovernance();
  const made = makeTools(counters, options.failSend === true ? { failSend: true } : {});
  const tools = (options.tools ?? ['sendEmail']).map((name) => made[name]);
  const checkpointer = SqliteSaver.fromConnString(file);
  const script = options.script ?? [];
  let graph: Graph;
  switch (entryPoint) {
    case 'governed':
      graph = buildGraph({
        script,
        checkpointer,
        toolNode: new ToolNode(
          tools.map((inner) =>
            governed(inner, { toolRef: TOOL_REFS[inner.name as ToolRefName], governance })
          )
        ),
      });
      break;
    case 'governedToolNode':
      graph = buildGraph({
        script,
        checkpointer,
        toolNode: governedToolNode(tools, { toolRefs: TOOL_REFS, governance }),
      });
      break;
    case 'governanceMiddleware':
    case 'governanceMiddleware (v1 tool node)':
      graph = buildAgent({
        script,
        checkpointer,
        tools,
        version: entryPoint === 'governanceMiddleware' ? 'v2' : 'v1',
        middleware: [governanceMiddleware(governance, { toolRefs: TOOL_REFS })],
      });
      break;
  }
  return { graph, governance };
}

async function world(
  options: HarnessOptions & {
    script: Parameters<typeof buildGraph>[0]['script'];
    tools?: ToolName[];
    failSend?: boolean;
  }
) {
  const h = await createHarness(options);
  const dir = mkdtempSync(join(tmpdir(), 'nc-langgraph-'));
  const file = join(dir, 'checkpoints.sqlite');
  const counters: Counters = { runs: [] };
  const agent = process_(h, file, counters, {
    script: options.script,
    governance: h.governance,
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.failSend === undefined ? {} : { failSend: options.failSend }),
  });
  /** A second process over the same checkpoint file. */
  const worker = (): { graph: Graph; governance: Governance } =>
    process_(h, file, counters, {
      script: options.script,
      ...(options.tools === undefined ? {} : { tools: options.tools }),
      ...(options.failSend === undefined ? {} : { failSend: options.failSend }),
    });
  const messages = async (graph: Graph = agent.graph): Promise<BaseMessage[]> =>
    ((await graph.getState(THREAD)).values as { messages: BaseMessage[] }).messages;
  const paused = async (graph: Graph = agent.graph): Promise<boolean> =>
    (await graph.getState(THREAD)).tasks.some((t) => t.interrupts.length > 0);
  return { h, file, counters, agent, worker, messages, paused };
}

/** The ledger assertion the suite makes after a gated call ran: the outcome record is linked to the approval. */
function assertLedger(h: Harness, approvalId: string): void {
  const obligation = h.mock.state.obligations.get(approvalId);
  expect(obligation?.state, 'the approval was consumed').toBe('consumed');
  expect(obligation?.outcomeRecordId, 'the outcome record is linked to the approval').toBeDefined();
  const record = h.mock.state.records.find((r) => r.approval_id === approvalId);
  expect(record?.outcome?.status).toBe('succeeded');
}

/** The part of better-sqlite3's database the tampering uses. */
interface Db {
  prepare(sql: string): { all(...args: unknown[]): unknown[]; run(...args: unknown[]): unknown };
}

/** Edits the arguments of a tool call in every stored checkpoint of a thread: an edit at rest. */
async function tamperToolCallArgs(
  file: string,
  threadId: string,
  toolCallId: string,
  args: Record<string, unknown>
): Promise<void> {
  const saver = SqliteSaver.fromConnString(file);
  const db = saver.db as unknown as Db;
  const rows = db
    .prepare('SELECT checkpoint_id, type, checkpoint FROM checkpoints WHERE thread_id = ?')
    .all(threadId) as { checkpoint_id: string; type: string; checkpoint: Uint8Array }[];
  for (const row of rows) {
    const checkpoint = (await saver.serde.loadsTyped(row.type, row.checkpoint)) as {
      channel_values?: { messages?: { tool_calls?: { id?: string; args: unknown }[] }[] };
    };
    for (const message of checkpoint.channel_values?.messages ?? []) {
      for (const toolCall of message.tool_calls ?? []) {
        if (toolCall.id === toolCallId) toolCall.args = args;
      }
    }
    const [type, blob] = await saver.serde.dumpsTyped(checkpoint);
    db.prepare(
      'UPDATE checkpoints SET type = ?, checkpoint = ? WHERE thread_id = ? AND checkpoint_id = ?'
    ).run(type, blob, threadId, row.checkpoint_id);
  }
}

const SEND = [ask(call('c1', 'send_email', { to: 'a@b.c' }))];

describe.each(ENTRY_POINTS)('through %s', (name) => {
  beforeAll(() => {
    entryPoint = name;
  });

  describe('conformance: approve, resume, run once', () => {
    it('approve → resume (from another process) → the tool runs once, the ledger is complete, the agent finishes', async () => {
      const w = await world({ script: SEND });
      await w.agent.graph.invoke(start(), THREAD);
      expect(await w.paused()).toBe(true);
      expect(w.counters.runs).toHaveLength(0);
      const [id = ''] = w.h.approvals();
      await w.h.approve(id);
      // The paused run lives in the checkpointer, not in the process: a fresh process resumes it.
      const other = w.worker();
      const outcome = await resumeApproval(other.graph, id, { governance: other.governance });
      expect(outcome).toMatchObject({ status: 'resumed', resolution: 'approved' });
      expect(w.counters.runs).toHaveLength(1);
      assertLedger(w.h, id);
      expect(textOf((await w.messages()).at(-1))).toBe('done');
    });

    it('the same through the worker: approve an hour later, from another machine', async () => {
      const w = await world({ script: SEND });
      await w.agent.graph.invoke(start(), THREAD);
      const [id = ''] = w.h.approvals();
      // The agent process is gone; the worker starts afterwards and finds the answered approval.
      await w.h.approve(id);
      const other = w.worker();
      const worker = await runResumer(other.graph, {
        governance: other.governance,
        reconcileIntervalMs: 0,
      });
      await until(() => w.counters.runs.length === 1);
      await worker.stop();
      assertLedger(w.h, id);
    });

    it('the same through waitAndResume', async () => {
      const w = await world({ script: SEND });
      await w.agent.graph.invoke(start(), THREAD);
      const [id = ''] = w.h.approvals();
      const waiting = waitAndResume(w.agent.graph, THREAD, {
        governance: w.agent.governance,
        pollSeconds: 5,
      });
      await sleep(40);
      await w.h.approve(id);
      expect(await waiting).toMatchObject({ status: 'resumed' });
      assertLedger(w.h, id);
    });

    it('ledger gap: an adapter that runs the tool without appending the outcome record fails this suite', async () => {
      const w = await world({ script: SEND });
      // The broken build: it acts as the adapter does, but its records never reach the deployment.
      w.h.intercept = (request) =>
        new URL(request.url).pathname === '/v1/records'
          ? Response.json(
              { data: { id: 'rec_dropped' }, meta: { request_id: 'r', deployment: 'hosted' } },
              { status: 201 }
            )
          : undefined;
      await w.agent.graph.invoke(start(), THREAD);
      const [id = ''] = w.h.approvals();
      await w.h.approve(id);
      const other = w.worker();
      await resumeApproval(other.graph, id, { governance: other.governance });
      expect(w.counters.runs).toHaveLength(1);
      expect(() => {
        assertLedger(w.h, id);
      }).toThrow();
      // And the deployment itself can show the gap: a consumed approval with no outcome.
      const gap = await w.h.as(
        w.h.tokens.creator,
        'GET',
        '/v1/approvals?state=consumed&outcome=missing'
      );
      expect(((await gap.json()) as { data: { id: string }[] }).data.map((a) => a.id)).toEqual([
        id,
      ]);
    });
  });

  describe('conformance: rejection, escalation, unknown resolutions', () => {
    it('reject → the tool does not run and the agent continues with the denial', async () => {
      const w = await world({ script: SEND });
      await w.agent.graph.invoke(start(), THREAD);
      const [id = ''] = w.h.approvals();
      await w.h.reject(id, 'not today');
      const other = w.worker();
      await resumeApproval(other.graph, id, { governance: other.governance });
      expect(w.counters.runs).toHaveLength(0);
      const messages = await w.messages();
      expect(denialCodeOf(messages.find((m): m is ToolMessage => m instanceof ToolMessage))).toBe(
        'rejected'
      );
      expect(textOf(messages.at(-1))).toBe('done');
      expect(w.h.mock.state.records).toHaveLength(0);
    });

    it("reject with onRejected 'halt' → the run ends", async () => {
      const w = await world({ script: SEND, governance: { onRejected: 'halt' } });
      await w.agent.graph.invoke(start(), THREAD);
      const [id = ''] = w.h.approvals();
      await w.h.reject(id);
      const other = w.worker();
      expect(other.governance.onRejected).toBe('halt');
      expect(await resumeApproval(other.graph, id, { governance: other.governance })).toEqual({
        status: 'halted',
        resolution: 'rejected',
      });
      expect(w.counters.runs).toHaveLength(0);
      expect((await w.messages()).some((m) => m.content === 'done')).toBe(false);
      expect(await w.paused()).toBe(false);
    });

    it('escalate → the thread stays paused, and a later approval still resumes it', async () => {
      const w = await world({ script: SEND });
      await w.agent.graph.invoke(start(), THREAD);
      const [id = ''] = w.h.approvals();
      await w.h.resolve(id, 'escalated');
      const other = w.worker();
      expect(await resumeApproval(other.graph, id, { governance: other.governance })).toEqual({
        status: 'waiting',
        reason: 'escalated',
      });
      expect(await w.paused()).toBe(true);
      expect(w.counters.runs).toHaveLength(0);
      await w.h.approve(id);
      await resumeApproval(other.graph, id, { governance: other.governance });
      expect(w.counters.runs).toHaveLength(1);
    });

    it('unknown resolution → nothing runs and the thread stays paused', async () => {
      const w = await world({ script: SEND, breaks: ['skip_request_validation'] });
      await w.agent.graph.invoke(start(), THREAD);
      const [id = ''] = w.h.approvals();
      await w.h.resolve(id, 'sent_to_legal');
      const other = w.worker();
      await expect(
        resumeApproval(other.graph, id, { governance: other.governance })
      ).rejects.toMatchObject({
        code: 'unknown_resolution',
      });
      expect(w.counters.runs).toHaveLength(0);
      expect(await w.paused()).toBe(true);
    });
  });

  describe('conformance: refused Resumptions', () => {
    /** Runs the scenario and returns what the resume raised. */
    async function refused(options: {
      breaks?: HarnessOptions['breaks'];
      prepare?: (w: Awaited<ReturnType<typeof world>>, id: string) => Promise<void> | void;
      worker?: (governance: Governance, approvalId: string) => void;
    }): Promise<{ error: unknown; w: Awaited<ReturnType<typeof world>> }> {
      const w = await world({
        script: SEND,
        ...(options.breaks === undefined ? {} : { breaks: options.breaks }),
      });
      await w.agent.graph.invoke(start(), THREAD);
      const [id = ''] = w.h.approvals();
      await w.h.approve(id);
      await options.prepare?.(w, id);
      const other = w.worker();
      options.worker?.(other.governance, id);
      let error: unknown;
      try {
        await resumeApproval(other.graph, id, { governance: other.governance });
      } catch (caught) {
        error = caught;
      }
      return { error, w };
    }

    it('tampered digest: the checkpoint was edited at rest to hold other arguments than the ones approved → refused', async () => {
      const w = await world({ script: SEND });
      await w.agent.graph.invoke(start(), THREAD);
      const [id = ''] = w.h.approvals();
      await w.h.approve(id);
      // After the approval and before the resume, the paused call's arguments are changed in the file.
      await tamperToolCallArgs(w.file, THREAD.configurable.thread_id, 'c1', {
        to: 'attacker@example.com',
      });
      const other = w.worker();
      await expect(
        resumeApproval(other.graph, id, { governance: other.governance })
      ).rejects.toMatchObject({
        code: 'digest_mismatch',
      });
      expect(w.counters.runs).toHaveLength(0);
      expect(await w.paused(other.graph)).toBe(true);
      expect(w.h.seen('POST', /\/consume$/)).toHaveLength(0);
    });

    it('wrong tool: the Resumption is signed for another tool and digest than the paused call → refused', async () => {
      const { error, w } = await refused({ breaks: ['unbound_resumption_signature'] });
      expect(error).toMatchObject({ code: 'tool_mismatch' });
      expect(w.counters.runs).toHaveLength(0);
      expect(await w.paused()).toBe(true);
    });

    it('wrong tool: a worker that governs the call under another catalog name → refused', async () => {
      const w = await world({ script: SEND });
      await w.agent.graph.invoke(start(), THREAD);
      const [id = ''] = w.h.approvals();
      await w.h.approve(id);
      // A worker whose tool of that name stands for a different catalog entry.
      const other = process_(w.h, w.file, w.counters, { governance: w.h.anotherGovernance() });
      const wrong = w.h.anotherGovernance();
      wrong.registerTool('send_email', 'ext:local:other');
      await expect(resumeApproval(other.graph, id, { governance: wrong })).rejects.toMatchObject({
        code: 'tool_mismatch',
      });
      expect(w.counters.runs).toHaveLength(0);
    });

    it('unknown kid → refused', async () => {
      const { error, w } = await refused({
        breaks: ['sign_unlisted_key'],
        worker: (g) => {
          g.registerTool('send_email', 'ext:local:send_email');
        },
      });
      expect(error).toMatchObject({ code: 'resumption_invalid' });
      expect(w.counters.runs).toHaveLength(0);
      expect(await w.paused()).toBe(true);
    });

    it('bad signature → refused', async () => {
      const { error, w } = await refused({
        prepare: (w2, id) => {
          w2.h.intercept = async (request) => {
            if (!new URL(request.url).pathname.endsWith(`${id}/resumption`)) return undefined;
            const real = await w2.h.mock.app.fetch(request);
            const json = (await real.json()) as { data: { signature: string } };
            const [header = '', payload = '', signature = ''] = json.data.signature.split('.');
            // The first and last characters of the signature swapped: still canonical base64url, no longer valid.
            const swapped = `${signature.slice(-2, -1)}${signature.slice(1, -2)}${signature.slice(0, 1)}${signature.slice(-1)}`;
            json.data.signature = `${header}.${payload}.${swapped === signature ? `A${signature.slice(1)}` : swapped}`;
            return Response.json(json);
          };
        },
        worker: (g) => {
          g.registerTool('send_email', 'ext:local:send_email');
        },
      });
      expect(error).toMatchObject({ code: 'resumption_invalid' });
      expect(w.counters.runs).toHaveLength(0);
    });

    it('replay → refused: a Resumption this process already acted on is not acted on again', async () => {
      const { error, w } = await refused({
        worker: (g, id) => {
          g.registerTool('send_email', 'ext:local:send_email');
          // This process already acted on the approval (a duplicate delivery, a retry after a crash).
          void g.replayGuard.firstUse(id, new Date(Date.now() + 3600_000));
        },
      });
      expect(error).toMatchObject({ code: 'replayed' });
      expect(w.counters.runs).toHaveLength(0);
      expect(await w.paused()).toBe(true);
    });

    it('expired continuation → refused, and a record marks the approval answered-but-unresumable', async () => {
      const w = await world({ script: SEND });
      await w.agent.graph.invoke(start(), THREAD);
      const [id = ''] = w.h.approvals();
      // The continuation expires an hour after it was stored, while the approval lives longer.
      const stored = w.h.mock.state.obligations.get(id);
      if (stored !== undefined)
        stored.continuation.expires_at = new Date(Date.now() + 60_000).toISOString();
      await w.h.approve(id);
      w.h.mock.state.clockOffsetMs += 5 * 60_000;
      const other = w.worker();
      await expect(
        resumeApproval(other.graph, id, { governance: other.governance })
      ).rejects.toMatchObject({ code: 'unresumable' });
      expect(w.counters.runs).toHaveLength(0);
      expect(w.h.mock.state.records.find((r) => r.approval_id === id)?.outcome).toMatchObject({
        status: 'unknown',
      });
    });
  });

  describe('conformance: a deployment that does not route approvals', () => {
    const decisionsOnly = ['decisions', 'records'] as const;

    it("whenUnroutable 'deny' (the default): a call that needs approval is denied, nothing pauses", async () => {
      const w = await world({ script: SEND, advertise: decisionsOnly });
      await w.agent.graph.invoke(start(), THREAD);
      expect(await w.paused()).toBe(false);
      expect(w.counters.runs).toHaveLength(0);
      expect(
        denialCodeOf((await w.messages()).find((m): m is ToolMessage => m instanceof ToolMessage))
      ).toBe('unroutable');
    });

    it("whenUnroutable 'ask-locally': the thread pauses with no continuation; a local yes runs the tool and the record says so", async () => {
      const w = await world({
        script: SEND,
        advertise: decisionsOnly,
        governance: { whenUnroutable: 'ask-locally' },
      });
      await w.agent.graph.invoke(start(), THREAD);
      expect(await w.paused()).toBe(true);
      const { Command } = await import('@langchain/langgraph');
      await w.agent.graph.invoke(new Command({ resume: { approved: true } }), THREAD);
      expect(w.counters.runs).toHaveLength(1);
      const record = w.h.mock.state.records.at(-1);
      expect(record?.outcome?.summary).toMatch(/local, unverified/);
      expect(record?.approval_id).toBeUndefined();
    });

    it('allowed tools still run and are recorded', async () => {
      const w = await world({
        script: [ask(call('c1', 'search', { q: 'x' }))],
        advertise: decisionsOnly,
        tools: ['search'],
      });
      await w.agent.graph.invoke(start(), THREAD);
      expect(w.counters.runs).toHaveLength(1);
      expect(w.h.mock.state.records).toHaveLength(1);
    });
  });

  describe('conformance: runs', () => {
    it('approvals advertised without runs → runs_required, and nothing runs', async () => {
      const w = await world({ script: SEND, advertise: ['approvals', 'records'] });
      const run = w.agent.graph.invoke(start(), THREAD);
      if (name.startsWith('governanceMiddleware')) {
        // The middleware never turns a GovernanceError into a message for the model: the run fails.
        await expect(run).rejects.toMatchObject({ name: 'GovernanceError' });
      } else {
        // The tool node reports a thrown tool error to the model; what matters is that nothing ran or paused.
        await run;
      }
      expect(w.counters.runs).toHaveLength(0);
      expect(await w.paused()).toBe(false);
      await expect(w.agent.governance.assertReady()).rejects.toMatchObject({
        code: 'runs_required',
      });
      expect(w.h.seen('POST', '/v1/decisions')).toHaveLength(0);
    });

    it('a continuation_kinds list without langgraph → continuation_kind_unsupported, reported to onError, and nothing runs', async () => {
      const errors: string[] = [];
      const w = await world({
        script: SEND,
        governance: { onError: (e) => errors.push(e.code) },
      });
      w.h.intercept = async (request) => {
        if (new URL(request.url).pathname !== '/v1/capabilities') return undefined;
        const envelope = (await (await w.h.mock.app.fetch(request)).json()) as {
          data: Record<string, unknown>;
        };
        envelope.data.continuation_kinds = ['adk', 'claude_agent_sdk'];
        return new Response(JSON.stringify(envelope), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };
      const run = w.agent.graph.invoke(start(), THREAD);
      if (name.startsWith('governanceMiddleware')) {
        await expect(run).rejects.toMatchObject({ name: 'GovernanceError' });
      } else {
        // The tool node hands a thrown tool error to the model and the graph completes; the builder still hears it.
        await run;
      }
      expect(errors).toEqual(['continuation_kind_unsupported']);
      expect(w.counters.runs).toHaveLength(0);
      expect(await w.paused()).toBe(false);
      await expect(w.agent.governance.assertReady()).rejects.toMatchObject({
        code: 'continuation_kind_unsupported',
      });
      expect(w.h.seen('POST', '/v1/decisions')).toHaveLength(0);
    });

    it('one run per thread: an approval in one thread never satisfies an identical call in another', async () => {
      const w = await world({ script: SEND });
      await w.agent.graph.invoke(start(), THREAD);
      await w.agent.graph.invoke(start(), { configurable: { thread_id: 'another-thread' } });
      // Same tool, same arguments, two threads: two approvals.
      expect(w.h.approvals()).toHaveLength(2);
      const [first = '', second = ''] = w.h.approvals();
      await w.h.approve(first);
      expect(w.h.mock.state.obligations.get(second)?.state).toBe('pending');
    });
  });

  describe('conformance: two gated calls in one model message', () => {
    const script = [
      ask(call('c1', 'send_email', { to: 'a' }), call('c2', 'send_email', { to: 'b' })),
      ask(call('c3', 'send_email', { to: 'b' })),
    ];

    it.skipIf(name === 'governanceMiddleware')(
      'the first pauses, the second is denied with the retry message, and the retried call goes through its own approval',
      async () => {
        const w = await world({ script });
        await w.agent.graph.invoke(start(), THREAD);
        const state = await w.agent.graph.getState(THREAD);
        expect(
          state.tasks[0]?.interrupts.map((i) => (i.value as { tool_call_id: string }).tool_call_id)
        ).toEqual(['c1']);
        const [first = ''] = w.h.approvals();
        await w.h.approve(first);
        const other = w.worker();
        await resumeApproval(other.graph, first, { governance: other.governance });
        const denied = (await w.messages()).find(
          (m): m is ToolMessage => m instanceof ToolMessage && m.tool_call_id === 'c2'
        );
        expect(denialCodeOf(denied)).toBe('approval_pending_in_task');
        expect(textOf(denied)).toMatch(/Retry this call after that approval resolves/);
        // The denied sibling's own approval was withdrawn; the retry's is the one still pending.
        const second =
          w.h
            .approvals()
            .find(
              (id) => id !== first && w.h.mock.state.obligations.get(id)?.state === 'pending'
            ) ?? '';
        await w.h.approve(second);
        await resumeApproval(other.graph, second, { governance: other.governance });
        expect(w.counters.runs.map((r) => (r.args as { to: string }).to)).toEqual(['a', 'b']);
        assertLedger(w.h, first);
        assertLedger(w.h, second);
      }
    );
  });

  describe.runIf(name === 'governanceMiddleware')(
    'conformance: two gated calls in one model message, one task per call (createAgent v2)',
    () => {
      it('each call pauses on its own approval; approving one runs only that call', async () => {
        const w = await world({
          script: [
            ask(call('c1', 'send_email', { to: 'a' }), call('c2', 'send_email', { to: 'b' })),
          ],
        });
        await w.agent.graph.invoke(start(), THREAD);
        const waiting = (await w.agent.graph.getState(THREAD)).tasks.flatMap((t) =>
          t.interrupts.map((i) => (i.value as { tool_call_id: string }).tool_call_id)
        );
        expect(waiting.sort()).toEqual(['c1', 'c2']);
        const [first = '', second = ''] = w.h.approvals();
        expect(w.h.approvals()).toHaveLength(2);
        await w.h.approve(first);
        const other = w.worker();
        await resumeApproval(other.graph, first, { governance: other.governance });
        expect(w.counters.runs).toHaveLength(1);
        expect(w.h.mock.state.obligations.get(second)?.state).toBe('pending');
        await w.h.approve(second);
        await resumeApproval(other.graph, second, { governance: other.governance });
        expect(w.counters.runs.map((r) => (r.args as { to: string }).to).sort()).toEqual([
          'a',
          'b',
        ]);
        assertLedger(w.h, first);
        assertLedger(w.h, second);
        expect(textOf((await w.messages()).at(-1))).toBe('done');
      });
    }
  );

  describe('conformance: arguments the tool schema rejects', () => {
    it('are not decided on: no decision, no approval, no record, no run, and the model is told the schema failed', async () => {
      const w = await world({ script: [ask(call('c1', 'send_email', { to: 5 }))] });
      await w.agent.graph.invoke(start(), THREAD);
      expect(w.h.seen('POST', '/v1/decisions')).toHaveLength(0);
      expect(w.h.approvals()).toHaveLength(0);
      expect(w.h.mock.state.records).toHaveLength(0);
      expect(w.counters.runs).toHaveLength(0);
      const messages = await w.messages();
      const told = messages.find((m): m is ToolMessage => m instanceof ToolMessage);
      expect(told?.status).toBe('error');
      expect(textOf(told)).toContain('did not match expected schema');
      expect(await w.paused()).toBe(false);
    });
  });

  describe('conformance: what the earlier suites left to unit tests (m5)', () => {
    it('a tool that throws after the consume: the approval is consumed, the record says failed, the tool ran once', async () => {
      const w = await world({ script: SEND, failSend: true });
      await w.agent.graph.invoke(start(), THREAD);
      const [id = ''] = w.h.approvals();
      await w.h.approve(id);
      const other = w.worker();
      await resumeApproval(other.graph, id, { governance: other.governance });
      expect(w.counters.runs).toHaveLength(1);
      expect(w.h.mock.state.obligations.get(id)?.state).toBe('consumed');
      const record = w.h.mock.state.records.find((r) => r.approval_id === id);
      expect(record?.outcome).toMatchObject({ status: 'failed', error: 'smtp down' });
      const messages = await w.messages();
      const result = messages.find((m): m is ToolMessage => m instanceof ToolMessage);
      expect(result?.status).toBe('error');
      expect(textOf(messages.at(-1))).toBe('done');
    });

    it.each(['expired', 'withdrawn'] as const)(
      'a %s approval: another process finds the paused thread in the checkpointer and answers it with a denial that says which',
      async (close) => {
        const w = await world({ script: SEND });
        await w.agent.graph.invoke(start(), THREAD);
        const [id = ''] = w.h.approvals();
        if (close === 'expired') w.h.mock.state.clockOffsetMs += 2 * 3600_000;
        else await w.h.as(w.h.tokens.creator, 'POST', `/v1/approvals/${id}/withdraw`);
        const other = w.worker();
        expect(
          await resumeApproval(other.graph, id, { governance: other.governance })
        ).toMatchObject({ status: 'resumed', state: close });
        expect(w.counters.runs).toHaveLength(0);
        const messages = await w.messages();
        const denied = messages.find((m): m is ToolMessage => m instanceof ToolMessage);
        expect(denialCodeOf(denied)).toBe('unresumable');
        expect(textOf(denied)).toContain(close);
        expect(textOf(messages.at(-1))).toBe('done');
        expect(await w.paused()).toBe(false);
      }
    );

    it("a worker with another principal's token sees none of the agent's approvals, and a direct resume as that principal is refused; nothing runs", async () => {
      const w = await world({ script: SEND });
      await w.agent.graph.invoke(start(), THREAD);
      const [id = ''] = w.h.approvals();
      await w.h.approve(id);
      const stranger = process_(w.h, w.file, w.counters, {
        script: SEND,
        governance: w.h.anotherGovernance({ getToken: () => w.h.tokens.approver }),
      });
      // Its listing and stream ask for created_by=me, so it starts and sees nothing of ours.
      const worker = await runResumer(stranger.graph, {
        governance: stranger.governance,
        reconcileIntervalMs: 0,
      });
      await worker.stop();
      expect(w.h.seen('GET', /\/resumption$/)).toHaveLength(0);
      // Asked for this approval by name, the server refuses it: only the principal that created it reads its Resumption.
      await expect(
        resumeApproval(stranger.graph, id, { governance: stranger.governance })
      ).rejects.toMatchObject({ code: 'not_owner' });
      expect(w.counters.runs).toHaveLength(0);
      expect(await w.paused()).toBe(true);
    });
  });

  describe('conformance: exactly once', () => {
    it('a duplicate stream event', async () => {
      const w = await world({ script: SEND });
      await w.agent.graph.invoke(start(), THREAD);
      const [id = ''] = w.h.approvals();
      const other = w.worker();
      const worker = await runResumer(other.graph, {
        governance: other.governance,
        reconcileIntervalMs: 0,
      });
      await w.h.approve(id);
      // Resolving the approval published one event; replay it twice more.
      const view = (
        (await (await w.h.as(w.h.tokens.creator, 'GET', `/v1/approvals/${id}`)).json()) as {
          data: { id: string };
        }
      ).data;
      for (const listener of w.h.mock.state.listeners) {
        const obligation = w.h.mock.state.obligations.get(view.id);
        if (obligation !== undefined) {
          listener(obligation);
          listener(obligation);
        }
      }
      await until(() => w.counters.runs.length >= 1);
      await sleep(200);
      await worker.stop();
      expect(w.counters.runs).toHaveLength(1);
    });

    it('a worker restart in the middle of a resume', async () => {
      const w = await world({ script: SEND });
      await w.agent.graph.invoke(start(), THREAD);
      const [id = ''] = w.h.approvals();
      await w.h.approve(id);
      // The first worker verifies and is killed on its way into the graph.
      const dying = w.worker();
      const real = dying.graph;
      // A proxy, not a subclass: `createAgent`'s graph keeps private fields that only the real object reads.
      const killed = new Proxy(real, {
        get(target, property) {
          if (property === 'invoke') return () => Promise.reject(new Error('killed'));
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
        },
      });
      await expect(resumeApproval(killed, id, { governance: dying.governance })).rejects.toThrow(
        'killed'
      );
      expect(w.counters.runs).toHaveLength(0);
      // The restarted worker (a new process, a new replay guard) finishes it.
      const restarted = w.worker();
      await resumeApproval(restarted.graph, id, { governance: restarted.governance });
      expect(w.counters.runs).toHaveLength(1);
      // A third start finds nothing to do.
      const third = w.worker();
      expect(await resumeApproval(third.graph, id, { governance: third.governance })).toEqual({
        status: 'skipped',
        reason: 'consumed',
      });
      expect(w.counters.runs).toHaveLength(1);
      assertLedger(w.h, id);
    });

    it('a worker restarted after a crash before the resume ran does not run the tool twice (separate processes, one checkpoint file)', async () => {
      const w = await world({ script: SEND });
      await w.agent.graph.invoke(start(), THREAD);
      const [id = ''] = w.h.approvals();
      // Worker A verifies, then dies on its way into the graph.
      const a = w.worker();
      const crashing = Object.create(a.graph, {
        invoke: { value: () => Promise.reject(new Error('killed')) },
      }) as Graph;
      const errors: string[] = [];
      const first = await runResumer(crashing, {
        governance: a.governance,
        reconcileIntervalMs: 0,
        onError: (e) => errors.push(e.message),
      });
      await w.h.approve(id);
      await until(() => errors.length > 0);
      await first.stop();
      expect(w.counters.runs).toHaveLength(0);
      // The restart: a new process, its own graph, governance and replay guard. The approval is still unconsumed.
      const b = w.worker();
      const second = await runResumer(b.graph, {
        governance: b.governance,
        reconcileIntervalMs: 0,
      });
      await until(() => w.counters.runs.length === 1);
      await second.stop();
      expect(w.counters.runs).toHaveLength(1);
      assertLedger(w.h, id);
    });

    it('a worker restarted after the tool ran finds nothing to do (separate processes, one checkpoint file)', async () => {
      const w = await world({ script: SEND });
      await w.agent.graph.invoke(start(), THREAD);
      const [id = ''] = w.h.approvals();
      const a = w.worker();
      const first = await runResumer(a.graph, { governance: a.governance, reconcileIntervalMs: 0 });
      await w.h.approve(id);
      await until(() => w.counters.runs.length === 1);
      await first.stop();
      const errors: string[] = [];
      const b = w.worker();
      const second = await runResumer(b.graph, {
        governance: b.governance,
        reconcileIntervalMs: 0,
        onError: (e) => errors.push(e.message),
      });
      await sleep(150);
      await second.stop();
      expect(w.counters.runs).toHaveLength(1);
      expect(errors).toEqual([]);
    });

    it('two concurrent workers', async () => {
      const w = await world({ script: SEND });
      await w.agent.graph.invoke(start(), THREAD);
      const [id = ''] = w.h.approvals();
      await w.h.approve(id);
      const a = w.worker();
      const b = w.worker();
      const results = await Promise.allSettled([
        resumeApproval(a.graph, id, { governance: a.governance }),
        resumeApproval(b.graph, id, { governance: b.governance }),
      ]);
      expect(w.counters.runs).toHaveLength(1);
      expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
      // The loser was stopped before the graph or told the approval no longer matches: the tool ran once.
      expect(w.h.mock.state.obligations.get(id)?.state).toBe('consumed');
      assertLedger(w.h, id);
    });

    it('M5: two resumers race at /consume: one runs the tool, the loser is told and writes nothing, and the thread head shows the real result', async () => {
      const w = await world({ script: SEND });
      await w.agent.graph.invoke(start(), THREAD);
      const [id = ''] = w.h.approvals();
      await w.h.approve(id);
      const a = w.worker();
      const b = w.worker();
      // Each resumer reads the Resumption twice (the resume primitive, then the tool node). Both tool nodes
      // read before either consumes, so the two reach `/consume` together; the second consume answers 409
      // and its answer is held back, so the loser would write after the winner if it wrote anything.
      let reads = 0;
      let consumes = 0;
      let release!: () => void;
      const both = new Promise<void>((resolve) => {
        release = resolve;
      });
      w.h.intercept = async (request) => {
        const path = new URL(request.url).pathname;
        if (request.method === 'GET' && path.endsWith('/resumption')) {
          reads += 1;
          if (reads === 3 || reads === 4) {
            if (reads === 4) release();
            await Promise.race([both, sleep(3000)]);
          }
        }
        if (path.endsWith('/consume')) {
          consumes += 1;
          if (consumes === 2) await sleep(200);
        }
        return undefined;
      };
      const results = await Promise.allSettled([
        resumeApproval(a.graph, id, { governance: a.governance }),
        resumeApproval(b.graph, id, { governance: b.governance }),
      ]);
      expect(consumes).toBe(2);
      expect(w.counters.runs).toHaveLength(1);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((r) => r.status === 'rejected')).toMatchObject({
        reason: { code: 'consume_conflict' },
      });
      // The head of the thread is the winner's: the tool's own result, no denial anywhere.
      await sleep(300);
      const messages = await w.messages();
      const tools = messages.filter((m): m is ToolMessage => m instanceof ToolMessage);
      expect(tools).toHaveLength(1);
      expect(tools[0]?.content).toBe('sent to a@b.c');
      expect(denialCodeOf(tools[0])).toBeUndefined();
      expect(textOf(messages.at(-1))).toBe('done');
      assertLedger(w.h, id);
    });
  });

  describe('conformance: the deployment is unreachable', () => {
    it('while deciding: a denial; nothing runs ungoverned', async () => {
      const w = await world({ script: [ask(call('c1', 'search', { q: 'x' }))], tools: ['search'] });
      w.h.intercept = (request) =>
        new URL(request.url).pathname === '/v1/decisions' ? status(503) : undefined;
      await w.agent.graph.invoke(start(), THREAD);
      expect(w.counters.runs).toHaveLength(0);
      expect(
        denialCodeOf((await w.messages()).find((m): m is ToolMessage => m instanceof ToolMessage))
      ).toBe('unreachable');
    });
  });
});
