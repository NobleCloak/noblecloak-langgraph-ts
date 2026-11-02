/**
 * D-LG13 (as amended): when the outcome record cannot be written, the adapter is never silent and never
 * misleading. By default it tells the model the truth (the tool ran, the outcome is unrecorded) instead of
 * throwing, in a stock `ToolNode` and in `governedToolNode` alike; `onRecordFailure: 'throw'` keeps the throw.
 */
import { ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { describe, expect, it } from 'vitest';

import { denialCodeOf, NOT_RUN } from '../src/denial.js';
import { governed, governedToolNode } from '../src/governed.js';
import { resumeApproval } from '../src/resume.js';
import { ask, buildGraph, call, makeTools, start, textOf, TOOL_REFS } from './graph.js';
import type { Counters } from './graph.js';
import { createHarness, status } from './harness.js';
import type { HarnessOptions } from './harness.js';

const CFG = { configurable: { thread_id: 't1' } };
const FAST = { recordRetry: { attempts: 3, backoffMs: 1, maxBackoffMs: 2 } } as const;
const TRANSPORT = 'ECONNRESET records.internal.example:5432';

/** The exact words the model reads, per tool name. */
const unrecorded = (tool: string): string =>
  `The tool ${tool} ran, but its outcome could not be recorded, so its result is withheld. Do not call ${tool} again for this request: it already ran. Tell the user that this action was carried out and was not recorded, so that a person can follow up.`;

type NodeKind = 'stock' | 'governedToolNode';

async function world(
  kind: NodeKind,
  script: Parameters<typeof buildGraph>[0]['script'],
  options: HarnessOptions & { handleToolErrors?: boolean; failSend?: boolean } = {}
) {
  const h = await createHarness({ ...options, governance: { ...FAST, ...options.governance } });
  const counters: Counters = { runs: [] };
  const made = makeTools(counters, { failSend: options.failSend === true });
  const tools = [made.search, made.sendEmail];
  const toolNode =
    kind === 'governedToolNode'
      ? governedToolNode(tools, {
          toolRefs: TOOL_REFS,
          governance: h.governance,
          ...(options.handleToolErrors === undefined
            ? {}
            : { handleToolErrors: options.handleToolErrors }),
        })
      : new ToolNode(
          tools.map((t) =>
            governed(t, {
              toolRef: TOOL_REFS[t.name as keyof typeof TOOL_REFS],
              governance: h.governance,
            })
          ),
          options.handleToolErrors === undefined
            ? {}
            : { handleToolErrors: options.handleToolErrors }
        );
  const graph = buildGraph({ script, toolNode });
  const recordsDown = (): void => {
    h.intercept = (request) => {
      if (new URL(request.url).pathname !== '/v1/records') return undefined;
      throw new Error(TRANSPORT);
    };
  };
  return { h, counters, graph, recordsDown };
}

const toolMessages = async (graph: ReturnType<typeof buildGraph>): Promise<ToolMessage[]> =>
  ((await graph.getState(CFG)).values as { messages: BaseMessage[] }).messages.filter(
    (m): m is ToolMessage => m instanceof ToolMessage
  );

describe.each<NodeKind>(['stock', 'governedToolNode'])(
  "onRecordFailure 'tell-model' (the default), %s",
  (kind) => {
    it('an allowed call: the model reads the fixed truthful text, the tool ran once, onError heard record_failed once, one key', async () => {
      const errors: { code: string; cause: unknown }[] = [];
      const w = await world(kind, [ask(call('c1', 'search', { q: 'x' }))], {
        governance: { onError: (e) => errors.push({ code: e.code, cause: e.cause }) },
      });
      w.recordsDown();
      await w.graph.invoke(start(), CFG);
      const [message, ...rest] = await toolMessages(w.graph);
      expect(rest).toEqual([]);
      expect(message?.content).toBe(unrecorded('search'));
      expect(textOf(message)).not.toMatch(/fix your mistakes|found x|ECONNRESET|5432|Error:/);
      expect(denialCodeOf(message)).toBe('record_failed');
      expect(w.counters.runs).toHaveLength(1);
      expect(errors.map((e) => e.code)).toEqual(['record_failed']);
      expect(String(errors[0]?.cause)).toContain(TRANSPORT);
      const attempts = w.h.seen('POST', '/v1/records');
      expect(attempts).toHaveLength(3);
      expect(new Set(attempts.map((r) => r.headers['idempotency-key'])).size).toBe(1);
      expect(w.h.mock.state.records).toHaveLength(0);
    });

    it('a refused record (4xx, not retried) is told the same way and reported once', async () => {
      const errors: string[] = [];
      const w = await world(kind, [ask(call('c1', 'search', { q: 'x' }))], {
        governance: { onError: (e) => errors.push(e.code) },
      });
      w.h.intercept = (r) => (new URL(r.url).pathname === '/v1/records' ? status(400) : undefined);
      await w.graph.invoke(start(), CFG);
      expect((await toolMessages(w.graph))[0]?.content).toBe(unrecorded('search'));
      expect(w.h.seen('POST', '/v1/records')).toHaveLength(1);
      expect(errors).toEqual(['record_failed']);
      expect(w.counters.runs).toHaveLength(1);
    });

    it('a tool that itself threw, whose record also fails: the model is told the same fixed text', async () => {
      const w = await world(kind, [ask(call('c1', 'send_email', { to: 'a@b.c' }))], {
        failSend: true,
      });
      await w.graph.invoke(start(), CFG);
      const [id = ''] = w.h.approvals();
      await w.h.approve(id);
      w.recordsDown();
      await resumeApproval(w.graph, id, { governance: w.h.governance });
      expect((await toolMessages(w.graph))[0]?.content).toBe(unrecorded('send_email'));
      expect(w.counters.runs).toHaveLength(1);
    });

    it('a gated call: the approval is consumed, the tool ran once, the model reads the fixed text, the resumer is not failed', async () => {
      const errors: string[] = [];
      const w = await world(kind, [ask(call('c1', 'send_email', { to: 'a@b.c' }))], {
        governance: { onError: (e) => errors.push(e.code) },
      });
      await w.graph.invoke(start(), CFG);
      const [id = ''] = w.h.approvals();
      await w.h.approve(id);
      w.recordsDown();
      await resumeApproval(w.graph, id, { governance: w.h.governance });
      expect(w.counters.runs).toHaveLength(1);
      expect(w.h.seen('POST', /\/consume$/)).toHaveLength(1);
      expect(w.h.mock.state.obligations.get(id)?.state).toBe('consumed');
      const [message] = await toolMessages(w.graph);
      expect(message?.content).toBe(unrecorded('send_email'));
      expect(textOf(message)).not.toMatch(/fix your mistakes|sent to|ECONNRESET/);
      expect(errors).toEqual(['record_failed']);
      expect(w.h.mock.state.records).toHaveLength(0);
    });

    it('a transient record failure, then success: the normal result, one record, nothing reported', async () => {
      const errors: string[] = [];
      const w = await world(kind, [ask(call('c1', 'search', { q: 'x' }))], {
        governance: { onError: (e) => errors.push(e.code) },
      });
      let failures = 2;
      w.h.intercept = (r) =>
        new URL(r.url).pathname === '/v1/records' && failures-- > 0 ? status(503) : undefined;
      await w.graph.invoke(start(), CFG);
      expect((await toolMessages(w.graph))[0]?.content).toBe('found x');
      expect(w.h.mock.state.records).toHaveLength(1);
      expect(errors).toEqual([]);
    });

    it('the model calls the allowed tool again anyway: nothing special, it runs again (this time recorded)', async () => {
      const w = await world(kind, [
        ask(call('c1', 'search', { q: 'x' })),
        ask(call('c2', 'search', { q: 'x' })),
      ]);
      let refused = 1;
      w.h.intercept = (r) =>
        new URL(r.url).pathname === '/v1/records' && refused-- > 0 ? status(400) : undefined;
      await w.graph.invoke(start(), CFG);
      const messages = await toolMessages(w.graph);
      expect(messages.map((m) => m.content)).toEqual([unrecorded('search'), 'found x']);
      expect(w.counters.runs).toHaveLength(2);
      expect(w.h.mock.state.records).toHaveLength(1);
    });

    it('the model calls a gated tool again after the message: a new decision and a new approval, as usual', async () => {
      const w = await world(kind, [
        ask(call('c1', 'send_email', { to: 'a@b.c' })),
        ask(call('c2', 'send_email', { to: 'a@b.c' })),
      ]);
      await w.graph.invoke(start(), CFG);
      const [first = ''] = w.h.approvals();
      await w.h.approve(first);
      w.recordsDown();
      await resumeApproval(w.graph, first, { governance: w.h.governance });
      expect(w.counters.runs).toHaveLength(1);
      expect(w.h.approvals()).toHaveLength(2);
      expect((await w.graph.getState(CFG)).tasks[0]?.interrupts).toHaveLength(1);
    });

    it('the wording cannot be read as a denial: it says the tool ran and invites no retry', () => {
      const text = unrecorded('search');
      expect(text).not.toContain(NOT_RUN);
      expect(text).not.toMatch(/not run|retry|try again/i);
      expect(text).toMatch(/ran/);
    });
  }
);

describe("onRecordFailure 'throw'", () => {
  it('with handleToolErrors: false the invoke rejects with record_failed, after the tool ran once', async () => {
    const errors: string[] = [];
    const w = await world('governedToolNode', [ask(call('c1', 'search', { q: 'x' }))], {
      handleToolErrors: false,
      governance: { onRecordFailure: 'throw', onError: (e) => errors.push(e.code) },
    });
    w.recordsDown();
    await expect(w.graph.invoke(start(), CFG)).rejects.toMatchObject({ code: 'record_failed' });
    expect(w.counters.runs).toHaveLength(1);
    expect(errors).toEqual(['record_failed']);
  });

  it('with a bare governed tool in a ToolNode that does not handle errors, the same', async () => {
    const w = await world('stock', [ask(call('c1', 'search', { q: 'x' }))], {
      handleToolErrors: false,
      governance: { onRecordFailure: 'throw' },
    });
    w.recordsDown();
    await expect(w.graph.invoke(start(), CFG)).rejects.toMatchObject({ code: 'record_failed' });
  });

  it('under a stock node (handleToolErrors default) the thrown error becomes an error message in the thread: pinned', async () => {
    const w = await world('stock', [ask(call('c1', 'search', { q: 'x' }))], {
      governance: { onRecordFailure: 'throw' },
    });
    w.recordsDown();
    await w.graph.invoke(start(), CFG);
    const [message] = await toolMessages(w.graph);
    expect(message?.status).toBe('error');
    expect(textOf(message)).toContain('The outcome record of mcp:tracker:search');
    expect(textOf(message)).toContain('Please fix your mistakes');
    expect(textOf(message)).not.toContain('found x');
    expect(w.counters.runs).toHaveLength(1);
  });
});

describe('onRecordFailure option', () => {
  it("defaults to 'tell-model' and rejects an unknown value", async () => {
    const h = await createHarness();
    expect(h.governance.onRecordFailure).toBe('tell-model');
    const h2 = await createHarness({ governance: { onRecordFailure: 'throw' } });
    expect(h2.governance.onRecordFailure).toBe('throw');
    await expect(
      createHarness({ governance: { onRecordFailure: 'ignore' as never } })
    ).rejects.toThrow(/onRecordFailure/);
  });
});
