/**
 * `governanceMiddleware` beyond the shared conformance scenarios: what only the middleware decides (a tool
 * it was given no catalog name for, a tool the agent does not have, its `handleToolErrors`).
 */
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { createMiddleware, toolRetryMiddleware } from 'langchain';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { gatewayCallContext } from '../src/gateway.js';
import { governanceMiddleware } from '../src/middleware.js';
import { resumeApproval } from '../src/resume.js';
import { ask, buildAgent, call, makeTools, start, textOf, TOOL_REFS } from './graph.js';
import type { Counters } from './graph.js';
import { createHarness } from './harness.js';

/** `createAgent`'s graph type does not surface `getState` through its generics; it is a compiled graph. */
interface ReadableAgent {
  getState(config: typeof CFG): Promise<{ values: unknown }>;
}

const CFG = { configurable: { thread_id: 'mw-1' } };

async function world(options: {
  script: Parameters<typeof buildAgent>[0]['script'];
  toolRefs: Record<string, string>;
  handleToolErrors?: boolean;
  governance?: NonNullable<Parameters<typeof createHarness>[0]>['governance'];
  /** Middleware placed after governance (inner to it). */
  after?: Parameters<typeof buildAgent>[0]['middleware'];
}) {
  const h = await createHarness(
    options.governance === undefined ? {} : { governance: options.governance }
  );
  const counters: Counters = { runs: [] };
  const made = makeTools(counters);
  const agent = buildAgent({
    script: options.script,
    tools: [made.search],
    middleware: [
      governanceMiddleware(h.governance, {
        toolRefs: options.toolRefs,
        ...(options.handleToolErrors === undefined
          ? {}
          : { handleToolErrors: options.handleToolErrors }),
      }),
      ...(options.after ?? []),
    ],
  });
  const toolMessages = async (): Promise<ToolMessage[]> =>
    (
      (await (agent as unknown as ReadableAgent).getState(CFG)).values as {
        messages: BaseMessage[];
      }
    ).messages.filter((m): m is ToolMessage => m instanceof ToolMessage);
  return { h, counters, agent, toolMessages };
}

describe('governanceMiddleware', () => {
  it('names each tool to governance when it is built', async () => {
    const w = await world({ script: [], toolRefs: { search: TOOL_REFS.search } });
    expect(w.h.governance.toolRefFor('search')).toBe(TOOL_REFS.search);
  });

  it('a call to a tool the agent does not have runs nothing, asks governance nothing, and the model is told', async () => {
    const w = await world({
      script: [ask(call('c1', 'wire_money', { to: 'x' }))],
      toolRefs: { search: TOOL_REFS.search },
    });
    await w.agent.invoke(start(), CFG);
    expect(w.counters.runs).toHaveLength(0);
    expect(w.h.seen('POST', '/v1/decisions')).toHaveLength(0);
    const [message] = await w.toolMessages();
    expect(message?.status).toBe('error');
    expect(textOf(message)).toContain('wire_money');
  });

  it('a later middleware that supplies a tool the agent lacks: the tool never runs, nothing is decided, nothing is recorded', async () => {
    const ran: string[] = [];
    const wire = tool(
      (args: { to: string }) => {
        ran.push(args.to);
        return 'wired';
      },
      { name: 'wire_money', description: 'Wire money.', schema: z.object({ to: z.string() }) }
    );
    const supplier = createMiddleware({
      name: 'supplies-a-tool',
      wrapToolCall: (request, handler) =>
        request.toolCall.name === 'wire_money'
          ? handler({ ...request, tool: wire })
          : handler(request),
    });
    const w = await world({
      script: [ask(call('c1', 'wire_money', { to: 'x' }))],
      toolRefs: { search: TOOL_REFS.search, wire_money: 'ext:bank:wire_money' },
      after: [supplier],
    });
    await w.agent.invoke(start(), CFG);
    expect(ran).toEqual([]);
    expect(w.h.seen('POST', '/v1/decisions')).toHaveLength(0);
    expect(w.h.mock.state.records).toHaveLength(0);
    const [message] = await w.toolMessages();
    expect(message?.status).toBe('error');
    expect(textOf(message)).toContain('wire_money is not a valid tool');
  });

  it('a retry middleware after governance cannot run the tool again: one execution, one approval, one failed record, and the model reads the governance error', async () => {
    const h = await createHarness();
    let runs = 0;
    const flaky = tool(
      (args: { to: string; note: string }) => {
        runs += 1;
        throw new Error(`smtp down ${args.to}`);
      },
      {
        name: 'send_email',
        description: 'Send an email.',
        schema: z.object({ to: z.string(), note: z.string().default('hello') }),
      }
    );
    const agent = buildAgent({
      script: [ask(call('c1', 'send_email', { to: 'a' }))],
      tools: [flaky],
      middleware: [
        governanceMiddleware(h.governance, { toolRefs: { send_email: TOOL_REFS.send_email } }),
        toolRetryMiddleware({
          maxRetries: 2,
          initialDelayMs: 1,
          jitter: false,
          onFailure: 'error',
        }),
      ],
    });
    await agent.invoke(start(), CFG);
    const [id = ''] = h.approvals();
    await h.approve(id);
    await resumeApproval(agent, id, { governance: h.governance });
    expect(runs).toBe(1);
    expect(h.approvals()).toHaveLength(1);
    const failed = h.mock.state.records.filter((r) => r.outcome?.status === 'failed');
    expect(failed).toHaveLength(1);
    const state = (await (agent as unknown as ReadableAgent).getState(CFG)).values as {
      messages: BaseMessage[];
    };
    const message = state.messages.find((m): m is ToolMessage => m instanceof ToolMessage);
    expect(message?.status).toBe('error');
    expect(textOf(message)).toContain('the approval was spent; a retry needs a new call');
    expect(textOf(message)).not.toContain('retrying');
  });

  describe('the outcome record is written from the one real execution, not from what the chain returns', () => {
    async function approvedSend(
      after: NonNullable<Parameters<typeof buildAgent>[0]['middleware']>,
      body: (args: { to: string }) => string
    ) {
      const h = await createHarness();
      const counter = { runs: 0 };
      const send = tool(
        (args: { to: string; note: string }) => {
          counter.runs += 1;
          return body(args);
        },
        {
          name: 'send_email',
          description: 'Send an email.',
          schema: z.object({ to: z.string(), note: z.string().default('hello') }),
        }
      );
      const agent = buildAgent({
        script: [ask(call('c1', 'send_email', { to: 'a' }))],
        tools: [send],
        middleware: [
          governanceMiddleware(h.governance, { toolRefs: { send_email: TOOL_REFS.send_email } }),
          ...after,
        ],
      });
      await agent.invoke(start(), CFG);
      const [id = ''] = h.approvals();
      await h.approve(id);
      await resumeApproval(agent, id, { governance: h.governance });
      const state = (await (agent as unknown as ReadableAgent).getState(CFG)).values as {
        messages: BaseMessage[];
      };
      const message = state.messages.find((m): m is ToolMessage => m instanceof ToolMessage);
      return { h, counter, message };
    }

    it("a retry middleware with the default onFailure 'continue': the tool throws once, and the one record is failed with the real error", async () => {
      const { h, counter, message } = await approvedSend(
        [toolRetryMiddleware({ maxRetries: 2, initialDelayMs: 1, jitter: false })],
        (args) => {
          throw new Error(`smtp down ${args.to}`);
        }
      );
      expect(counter.runs).toBe(1);
      expect(h.approvals()).toHaveLength(1);
      expect(h.mock.state.records).toHaveLength(1);
      const [record] = h.mock.state.records;
      expect(record?.outcome?.status).toBe('failed');
      expect(record?.outcome?.error).toContain('smtp down a');
      // The chain's own error message is what the model reads; the record is the tool's.
      expect(message?.status).toBe('error');
    });

    it('a downstream middleware that returns a message without invoking the tool: the record is failed tool_not_executed, nothing ran, the model reads the governance error', async () => {
      const skipper = createMiddleware({
        name: 'skips-the-tool',
        wrapToolCall: (request) =>
          new ToolMessage({
            name: request.toolCall.name,
            content: 'cached answer',
            tool_call_id: request.toolCall.id ?? '',
          }),
      });
      const { h, counter, message } = await approvedSend([skipper], () => 'sent');
      expect(counter.runs).toBe(0);
      expect(h.mock.state.records).toHaveLength(1);
      const [record] = h.mock.state.records;
      expect(record?.outcome?.status).toBe('failed');
      expect(record?.outcome?.error).toContain('returned without running the tool');
      expect(textOf(message)).not.toContain('cached answer');
      expect(textOf(message)).toContain('returned without running the tool');
    });

    it('a downstream middleware that invokes the tool once and returns normally: the record is succeeded', async () => {
      const passthrough = createMiddleware({
        name: 'passes-through',
        wrapToolCall: (request, handler) => handler(request),
      });
      const { h, counter, message } = await approvedSend([passthrough], () => 'sent');
      expect(counter.runs).toBe(1);
      expect(h.mock.state.records).toHaveLength(1);
      expect(h.mock.state.records[0]?.outcome?.status).toBe('succeeded');
      expect(textOf(message)).toBe('sent');
    });
  });

  it.each([undefined, true])(
    "a record that cannot be written under onRecordFailure 'throw' fails the run with the governance error, not a message to the model (handleToolErrors %s)",
    async (handleToolErrors) => {
      const w = await world({
        script: [ask(call('c1', 'search', { q: 'x' }))],
        toolRefs: { search: TOOL_REFS.search },
        governance: {
          onRecordFailure: 'throw',
          recordRetry: { attempts: 2, backoffMs: 1, maxBackoffMs: 2 },
        },
        ...(handleToolErrors === undefined ? {} : { handleToolErrors }),
      });
      w.h.intercept = (request) => {
        if (new URL(request.url).pathname !== '/v1/records') return undefined;
        return new Response('{}', { status: 500 });
      };
      await expect(w.agent.invoke(start(), CFG)).rejects.toMatchObject({
        name: 'GovernanceError',
        // createAgent wraps what a middleware throws; the typed error is its cause.
        cause: { code: 'record_failed' },
      });
      expect(w.counters.runs).toHaveLength(1);
      expect(await w.toolMessages()).toHaveLength(0);
    }
  );

  it.each([undefined, true, false])(
    'a tool the agent has but the map does not name is never run ungoverned: a configuration error fails the run (handleToolErrors %s)',
    async (handleToolErrors) => {
      const w = await world({
        script: [ask(call('c1', 'search', { q: 'x' }))],
        toolRefs: {},
        ...(handleToolErrors === undefined ? {} : { handleToolErrors }),
      });
      await expect(w.agent.invoke(start(), CFG)).rejects.toThrow(
        'governanceMiddleware: no toolRef for the tool search; add it to toolRefs or remove it from the agent'
      );
      expect(w.counters.runs).toHaveLength(0);
      expect(w.h.seen('POST', '/v1/decisions')).toHaveLength(0);
    }
  );

  it('a tool with no toolRef fails the run before the model is called, whatever the script would have asked', async () => {
    const w = await world({ script: [ask(call('c1', 'search', { q: 'x' }))], toolRefs: {} });
    await expect(w.agent.invoke(start(), CFG)).rejects.toThrow(
      'governanceMiddleware: no toolRef for the tool search'
    );
    // No model turn happened: the thread holds the human message only.
    expect(await w.toolMessages()).toHaveLength(0);
    const values = (await (w.agent as unknown as ReadableAgent).getState(CFG)).values as {
      messages?: BaseMessage[];
    };
    expect((values.messages ?? []).some((m) => AIMessage.isInstance(m))).toBe(false);
    expect(w.counters.runs).toHaveLength(0);
  });

  it('an allowed call runs once and is recorded', async () => {
    const w = await world({
      script: [ask(call('c1', 'search', { q: 'x' }))],
      toolRefs: { search: TOOL_REFS.search },
    });
    await w.agent.invoke(start(), CFG);
    expect(w.counters.runs).toHaveLength(1);
    expect(w.h.mock.state.records).toHaveLength(1);
    const [message] = await w.toolMessages();
    expect(textOf(message)).toBe('found x');
  });
});

describe('governanceMiddleware: tools the gateway executes', () => {
  it('a declared gateway tool pauses on step_up without a resume_token, then runs once on allow + handle, naming the decided run and recording nothing locally', async () => {
    const h = await createHarness();
    const seenRuns: string[] = [];
    const createIssue = tool(
      (args: { title: string }, config) => {
        seenRuns.push(gatewayCallContext(config).externalRunId);
        return `created ${args.title}`;
      },
      {
        name: 'create_issue',
        description: 'Create an issue.',
        schema: z.object({ title: z.string() }),
      }
    );
    const agent = buildAgent({
      script: [ask(call('c1', 'create_issue', { title: 'x' }))],
      tools: [createIssue],
      middleware: [
        governanceMiddleware(h.governance, {
          toolRefs: { create_issue: TOOL_REFS.create_issue },
          gatewayTools: ['create_issue'],
        }),
      ],
    });
    const paused = await agent.invoke(start(), CFG);
    const [id = ''] = h.approvals();
    expect(
      (paused as { __interrupt__?: { value: unknown }[] }).__interrupt__?.[0]?.value
    ).toMatchObject({ approval_id: id });
    expect(seenRuns).toEqual([]);
    const [decided] = h.seen('POST', '/v1/decisions');
    expect(decided?.body).toMatchObject({ actor: { run_id: expect.any(String) as unknown } });

    await h.approve(id);
    const outcome = await resumeApproval(agent as never, id, { governance: h.governance });
    expect(outcome).toMatchObject({ status: 'resumed' });
    expect(seenRuns).toHaveLength(1);
    const runId = (h.seen('POST', '/v1/decisions')[1]?.body as { actor: { run_id: string } }).actor
      .run_id;
    expect(seenRuns[0]).toBe(runId);
    expect(h.seen('POST', '/v1/records')).toHaveLength(0);
    expect(h.seen('POST', /\/consume$/)).toHaveLength(0);
  });

  it('a gatewayTools name that is not in toolRefs throws at construction', async () => {
    const h = await createHarness();
    expect(() =>
      governanceMiddleware(h.governance, {
        toolRefs: { search: TOOL_REFS.search },
        gatewayTools: ['create_isue'],
      })
    ).toThrow(/gatewayTools names create_isue/);
  });
});
