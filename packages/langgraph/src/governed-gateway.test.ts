/** A tool the deployment executes through the governed MCP gateway, declared with `gatewayTools` (D-A36). */
import { Command, MemorySaver } from '@langchain/langgraph';
import { ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { denialCodeOf } from './denial.js';
import { EXTERNAL_RUN_ID_KEY, gatewayCallContext } from './gateway.js';
import { governed, governedToolNode } from './governed.js';
import { resumeApproval } from './resume.js';
import { ask, buildGraph, call, makeTools, start, textOf, TOOL_REFS } from '../test/graph.js';
import type { Counters } from '../test/graph.js';
import { createHarness } from '../test/harness.js';
import type { HarnessOptions } from '../test/harness.js';

const CFG = { configurable: { thread_id: 't1' } };

async function setup(
  options: HarnessOptions & {
    script: Parameters<typeof buildGraph>[0]['script'];
    failCreate?: boolean;
    gatewayTools?: readonly string[];
  },
  tools: ('search' | 'createIssue')[] = ['createIssue']
) {
  const h = await createHarness(options);
  const counters: Counters = { runs: [] };
  const made = makeTools(counters, {
    ...(options.failCreate === undefined ? {} : { failCreate: options.failCreate }),
    probe: () => ({ consumes: h.seen('POST', /\/consume$/).length }),
  });
  const graph = buildGraph({
    script: options.script,
    toolNode: governedToolNode(
      tools.map((name) => made[name]),
      {
        toolRefs: TOOL_REFS,
        governance: h.governance,
        gatewayTools: options.gatewayTools ?? ['create_issue'],
      }
    ),
  });
  return { h, counters, graph };
}

const toolMessages = async (graph: ReturnType<typeof buildGraph>): Promise<ToolMessage[]> =>
  ((await graph.getState(CFG)).values as { messages: BaseMessage[] }).messages.filter(
    (m): m is ToolMessage => m instanceof ToolMessage
  );

const interruptsOf = (result: unknown): { value: Record<string, unknown> }[] =>
  (result as { __interrupt__?: { value: Record<string, unknown> }[] }).__interrupt__ ?? [];

const CREATE = [ask(call('c1', 'create_issue', { title: 'x' }))];

describe('gatewayTools: the first pass', () => {
  it('a declared tool whose decision says no resume_token will issue pauses with its continuation stored, and is not refused', async () => {
    const errors: string[] = [];
    const { h, counters, graph } = await setup({
      governance: { onError: (e) => errors.push(e.code) },
      script: CREATE,
    });
    const result = await graph.invoke(start(), CFG);
    const [paused] = interruptsOf(result);
    const [id = ''] = h.approvals();
    expect(paused?.value).toMatchObject({ approval_id: id, tool_ref: TOOL_REFS.create_issue });
    expect(counters.runs).toHaveLength(0);
    expect(errors).toEqual([]);
    expect(h.mock.state.obligations.get(id)?.state).toBe('pending');
    expect(h.seen('POST', /\/withdraw$/)).toHaveLength(0);
    const [decided] = h.seen('POST', '/v1/decisions');
    expect(decided?.body).toMatchObject({
      actor: { run_id: expect.stringMatching(/^run_/) as unknown },
      continuation: {
        kind: 'langgraph',
        correlation: { thread_id: 't1', tool_call_id: 'c1' },
      },
    });
  });

  it('the same tool not declared keeps the refusal', async () => {
    const { h, counters, graph } = await setup({ script: CREATE, gatewayTools: [] });
    const result = await graph.invoke(start(), CFG);
    expect(interruptsOf(result)).toHaveLength(0);
    expect(counters.runs).toHaveLength(0);
    const [denied] = await toolMessages(graph);
    expect(denialCodeOf(denied)).toBe('not_locally_executable');
    expect(h.mock.state.obligations.get(h.approvals()[0] ?? '')?.state).toBe('withdrawn');
  });

  it('an allow without a handle runs the function and records locally, as for any tool', async () => {
    const { h, counters, graph } = await setup(
      { script: [ask(call('c1', 'search', { q: 'bug' }))], gatewayTools: ['search'] },
      ['search']
    );
    await graph.invoke(start(), CFG);
    expect(counters.runs).toHaveLength(1);
    expect(h.seen('POST', '/v1/records')).toHaveLength(1);
  });

  it('a deny is a deny', async () => {
    const h = await createHarness();
    const tool = governed(makeTools({ runs: [] }).deleteAccount, {
      toolRef: TOOL_REFS.delete_account,
      governance: h.governance,
      executedBy: 'gateway',
    });
    const out = (await tool.invoke({ id: '9' }, {
      configurable: { thread_id: 't1' },
      toolCall: { id: 'c1', args: { id: '9' } },
    } as never)) as ToolMessage;
    expect(denialCodeOf(out)).toBe('denied');
  });

  it('a name that is not among the tools throws', async () => {
    await expect(setup({ script: CREATE, gatewayTools: ['create_isue'] })).rejects.toThrow(
      /gatewayTools names create_isue/
    );
  });
});

describe('gatewayTools: the run is mandatory', () => {
  it('a call with no thread is denied run_required before any decision', async () => {
    const h = await createHarness();
    const { createIssue } = makeTools({ runs: [] });
    const tool = governed(createIssue, {
      toolRef: TOOL_REFS.create_issue,
      governance: h.governance,
      executedBy: 'gateway',
    });
    const out = (await tool.invoke({ title: 'x' }, {
      toolCall: { id: 'c1', args: { title: 'x' } },
    } as never)) as ToolMessage;
    expect(denialCodeOf(out)).toBe('run_required');
    expect(textOf(out)).toMatch(/needs an external run/);
    expect(h.seen('POST', '/v1/decisions')).toHaveLength(0);
    expect(h.seen('POST', '/v1/runs')).toHaveLength(0);
  });

  it('a deployment that serves no runs denies run_required, and the builder is told', async () => {
    const errors: { code: string; message: string }[] = [];
    const { h, counters, graph } = await setup({
      advertise: ['decisions', 'records'],
      governance: { onError: (e) => errors.push({ code: e.code, message: e.message }) },
      script: CREATE,
    });
    await graph.invoke(start(), CFG);
    const [denied] = await toolMessages(graph);
    expect(denialCodeOf(denied)).toBe('run_required');
    expect(counters.runs).toHaveLength(0);
    expect(h.seen('POST', '/v1/decisions')).toHaveLength(0);
    expect(errors[0]?.code).toBe('run_required');
    expect(errors[0]?.message).toMatch(/does not serve runs/);
  });
});

describe('gatewayTools: a deployment that cannot route approvals', () => {
  const unroutableCases: [string, Partial<HarnessOptions>][] = [
    ["whenUnroutable 'ask-locally'", { governance: { whenUnroutable: 'ask-locally' } }],
    ["whenUnroutable 'deny' (the default)", {}],
  ];
  for (const [name, extra] of unroutableCases) {
    it(`${name}: a declared tool is denied unroutable, never asked locally, and its function never runs`, async () => {
      const { h, counters, graph } = await setup({
        advertise: ['decisions', 'records', 'runs'],
        ...extra,
        script: CREATE,
      });
      const result = await graph.invoke(start(), CFG);
      expect(interruptsOf(result)).toHaveLength(0);
      const [denied] = await toolMessages(graph);
      expect(denialCodeOf(denied)).toBe('unroutable');
      expect(counters.runs).toHaveLength(0);
      expect(h.seen('POST', '/v1/records')).toHaveLength(0);
    });
  }

  it('a 422 continuation_unsupported on a declared tool is denied unroutable, not asked locally', async () => {
    const { h, counters, graph } = await setup({
      governance: { whenUnroutable: 'ask-locally' },
      script: CREATE,
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
    expect(interruptsOf(result)).toHaveLength(0);
    expect(denialCodeOf((await toolMessages(graph))[0])).toBe('unroutable');
    expect(counters.runs).toHaveLength(0);
  });
});

describe('gatewayTools: after the approver acts', () => {
  it('the re-run is admitted by the allow branch: the function runs once, with no local record, no consume and no Resumption read', async () => {
    const { h, counters, graph } = await setup({ script: CREATE });
    await graph.invoke(start(), CFG);
    const [id = ''] = h.approvals();
    await h.approve(id);
    // `afterResume` verifies with the replay guard; `resumeApproval`'s own read asks for the resolutions it accepts.
    const verify = vi.spyOn(h.governance, 'verify');
    const outcome = await resumeApproval(graph, id, { governance: h.governance });
    expect(outcome).toMatchObject({ status: 'resumed' });
    expect(counters.runs).toHaveLength(1);
    expect(counters.runs[0]?.probe).toEqual({ consumes: 0 });
    expect(h.seen('POST', '/v1/records')).toHaveLength(0);
    expect(h.seen('POST', /\/consume$/)).toHaveLength(0);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls.filter(([, , options]) => 'replayGuard' in options)).toEqual([]);
    const decisions = h.seen('POST', '/v1/decisions');
    expect(decisions).toHaveLength(2);
    expect(decisions[1]?.body).toMatchObject({ actor: { run_id: expect.any(String) as unknown } });
    expect(textOf((await toolMessages(graph))[0])).toBe('created x');
  });

  it('the replay guard stands: an approval already spent is not admitted again, and the function does not run', async () => {
    const { h, counters, graph } = await setup({ script: CREATE });
    await graph.invoke(start(), CFG);
    const [id = ''] = h.approvals();
    await h.approve(id);
    expect(await h.governance.replayGuard.firstUse(id, new Date(Date.now() + 60_000))).toBe(true);
    await resumeApproval(graph, id, { governance: h.governance }).catch(() => undefined);
    expect(counters.runs).toHaveLength(0);
    expect(h.seen('POST', '/v1/records')).toHaveLength(0);
  });

  it('a re-invocation while the approval is still open pauses again on the same approval and correlation, without a second approval', async () => {
    const errors: string[] = [];
    const { h, counters, graph } = await setup({
      governance: { onError: (e) => errors.push(e.code) },
      script: CREATE,
    });
    await graph.invoke(start(), CFG);
    const again = await graph.invoke(null, CFG);
    const [id = ''] = h.approvals();
    expect(h.approvals()).toHaveLength(1);
    expect(interruptsOf(again)[0]?.value).toMatchObject({ approval_id: id });
    const bodies = h
      .seen('POST', '/v1/decisions')
      .map((r) => JSON.stringify((r.body as { continuation: unknown }).continuation));
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(counters.runs).toHaveLength(0);
    expect(errors).toEqual([]);
    expect(h.seen('POST', /\/withdraw$/)).toHaveLength(0);
  });

  it('a Resumption with no resume_token, reached on a step_up, pauses the node again with a truthful marker instead of resumption_invalid', async () => {
    const { h, counters, graph } = await setup({ script: CREATE });
    await graph.invoke(start(), CFG);
    const [id = ''] = h.approvals();
    await h.approve(id);
    // The hosted side would answer allow here; force the step_up that reaches the resume branch.
    h.intercept = async (request) => {
      if (new URL(request.url).pathname !== '/v1/decisions') return undefined;
      const real = await h.mock.app.fetch(request);
      const json = (await real.json()) as { data: Record<string, unknown> };
      json.data.decision = 'step_up';
      return Response.json(json, { status: real.status });
    };
    const result = await graph.invoke(
      new Command({ resume: { kind: 'answered', approval_id: id } }),
      CFG
    );
    expect(counters.runs).toHaveLength(0);
    expect(h.seen('POST', /\/consume$/)).toHaveLength(0);
    const marker = interruptsOf(result).at(-1)?.value;
    expect(marker).toMatchObject({ approval_id: id, gateway: true });
    expect(String(marker?.summary)).toMatch(/gateway executes this tool/);
    expect(await toolMessages(graph)).toHaveLength(0);
  });

  it('resumeApproval does not report a gateway pause-again as resumed: it throws unresumable and the approval is left unconsumed', async () => {
    const { h, counters, graph } = await setup({ script: CREATE });
    await graph.invoke(start(), CFG);
    const [id = ''] = h.approvals();
    await h.approve(id);
    h.intercept = async (request) => {
      if (new URL(request.url).pathname !== '/v1/decisions') return undefined;
      const real = await h.mock.app.fetch(request);
      const json = (await real.json()) as { data: Record<string, unknown> };
      json.data.decision = 'step_up';
      return Response.json(json, { status: real.status });
    };
    await expect(resumeApproval(graph, id, { governance: h.governance })).rejects.toMatchObject({
      code: 'unresumable',
    });
    expect(counters.runs).toHaveLength(0);
    expect(h.seen('POST', /\/consume$/)).toHaveLength(0);
  });

  it('a Resumption with no resume_token that the driver resumes twice ends in a resumption_invalid denial that says to re-run the node (a documented deviation from a distinct code)', async () => {
    const { h, counters, graph } = await setup({ script: CREATE });
    await graph.invoke(start(), CFG);
    const [id = ''] = h.approvals();
    await h.approve(id);
    h.intercept = async (request) => {
      if (new URL(request.url).pathname !== '/v1/decisions') return undefined;
      const real = await h.mock.app.fetch(request);
      const json = (await real.json()) as { data: Record<string, unknown> };
      json.data.decision = 'step_up';
      return Response.json(json, { status: real.status });
    };
    const answer = { kind: 'answered', approval_id: id };
    const paused = await graph.invoke(new Command({ resume: answer }), CFG);
    const pending = interruptsOf(paused).at(-1) as unknown as { id: string };
    await graph.invoke(new Command({ resume: { [pending.id]: answer } }), CFG);
    const [denied] = await toolMessages(graph);
    expect(denialCodeOf(denied)).toBe('resumption_invalid');
    expect(textOf(denied)).toMatch(/re-run the node/);
    expect(counters.runs).toHaveLength(0);
  });

  it("the gateway's refusal of the re-issued call is the tool's own error: no second decision, no record", async () => {
    const { h, counters, graph } = await setup({ script: CREATE, failCreate: true });
    await graph.invoke(start(), CFG);
    const [id = ''] = h.approvals();
    await h.approve(id);
    await resumeApproval(graph, id, { governance: h.governance }).catch(() => undefined);
    expect(counters.runs).toHaveLength(1);
    const [message] = await toolMessages(graph);
    expect(message?.status).toBe('error');
    expect(textOf(message)).toContain('tracker down');
    expect(h.seen('POST', '/v1/decisions')).toHaveLength(2);
    expect(h.seen('POST', '/v1/records')).toHaveLength(0);
  });
});

describe('gatewayTools: a refused re-issued call', () => {
  it('leaves the approval spent locally and approved upstream: a retry of the same call is continuation_conflict, and the report says the gateway never consumed it', async () => {
    const errors: string[] = [];
    const { h, counters, graph } = await setup({
      governance: { onError: (e) => errors.push(e.message) },
      script: [...CREATE, ask(call('c2', 'create_issue', { title: 'x' }))],
      failCreate: true,
    });
    await graph.invoke(start(), CFG);
    const [id = ''] = h.approvals();
    await h.approve(id);
    const outcome = await resumeApproval(graph, id, { governance: h.governance });
    expect(outcome).toMatchObject({ status: 'resumed' });
    expect(counters.runs).toHaveLength(1);
    const [first, retry] = await toolMessages(graph);
    expect(textOf(first)).toContain('tracker down');
    expect(denialCodeOf(retry)).toBe('continuation_conflict');
    expect(h.mock.state.obligations.get(id)?.state).toBe('approved');
    const report = errors.find((m) => m.includes('continuation_conflict')) ?? '';
    expect(report).toMatch(/admitted for the gateway and never consumed by it/);
    expect(report).not.toMatch(/dispatch it through the gateway instead/);
  });
});

describe('gatewayTools: the worker is a separate graph', () => {
  /** An agent graph that declares the tool pauses; a worker graph, declared or not, resumes it. */
  async function workerWorld(workerDeclares: boolean) {
    const h = await createHarness();
    const checkpointer = new MemorySaver();
    const seen: unknown[] = [];
    const make = () =>
      tool(
        (args: { title: string }, config) => {
          try {
            seen.push(gatewayCallContext(config).externalRunId);
          } catch (error) {
            seen.push((error as { code?: string }).code);
          }
          return `created ${args.title}`;
        },
        { name: 'create_issue', description: 'Create.', schema: z.object({ title: z.string() }) }
      );
    const agent = buildGraph({
      script: CREATE,
      checkpointer,
      toolNode: governedToolNode([make()], {
        toolRefs: TOOL_REFS,
        governance: h.governance,
        gatewayTools: ['create_issue'],
      }),
    });
    const worker = buildGraph({
      script: CREATE,
      checkpointer,
      toolNode: governedToolNode([make()], {
        toolRefs: TOOL_REFS,
        governance: h.governance,
        ...(workerDeclares ? { gatewayTools: ['create_issue'] } : {}),
      }),
    });
    await agent.invoke(start(), CFG);
    const [id = ''] = h.approvals();
    await h.approve(id);
    const outcome = await resumeApproval(worker, id, { governance: h.governance });
    return { h, seen, worker, id, outcome };
  }

  it('a worker graph that declares the tool is handed the run the gateway admits the call by', async () => {
    const { h, seen, outcome } = await workerWorld(true);
    expect(outcome).toMatchObject({ status: 'resumed' });
    const runId = (h.seen('POST', '/v1/decisions')[1]?.body as { actor: { run_id: string } }).actor
      .run_id;
    expect(seen).toEqual([runId]);
  });

  it('a worker graph that omits the declaration runs nothing: the call is refused not_locally_executable and the approval stays approved for the gateway', async () => {
    const { h, seen, worker, id } = await workerWorld(false);
    expect(seen).toEqual([]);
    const [denied] = await toolMessages(worker);
    expect(denialCodeOf(denied)).toBe('not_locally_executable');
    expect(h.mock.state.obligations.get(id)?.state).toBe('approved');
    expect(h.seen('POST', '/v1/records')).toHaveLength(0);
    expect(h.seen('POST', /\/consume$/)).toHaveLength(0);
  });
});

describe('gatewayCallContext', () => {
  it("hands the function the run the decision was made in, as the selector's header and _meta literals", async () => {
    const h = await createHarness();
    const seen: unknown[] = [];
    const inner = tool(
      (args: { title: string }, config) => {
        seen.push(gatewayCallContext(config));
        return `created ${args.title}`;
      },
      { name: 'create_issue', description: 'Create.', schema: z.object({ title: z.string() }) }
    );
    const graph = buildGraph({
      script: CREATE,
      toolNode: governedToolNode([inner], {
        toolRefs: TOOL_REFS,
        governance: h.governance,
        gatewayTools: ['create_issue'],
      }),
    });
    await graph.invoke(start(), CFG);
    const [id = ''] = h.approvals();
    await h.approve(id);
    await resumeApproval(graph, id, { governance: h.governance });
    const runId = (h.seen('POST', '/v1/decisions')[1]?.body as { actor: { run_id: string } }).actor
      .run_id;
    expect(seen).toEqual([
      {
        externalRunId: runId,
        header: { 'X-NobleCloak-External-Run-Id': runId },
        meta: { 'noblecloak/external-run-id': runId },
      },
    ]);
  });

  it('an undeclared tool is handed no run, and asking for one throws run_required', async () => {
    const h = await createHarness();
    const seen: unknown[] = [];
    const inner = tool(
      (args: { q: string }, config) => {
        try {
          gatewayCallContext(config);
        } catch (error) {
          seen.push((error as { code?: string }).code);
        }
        return `found ${args.q}`;
      },
      { name: 'search', description: 'Search.', schema: z.object({ q: z.string() }) }
    );
    const graph = buildGraph({
      script: [ask(call('c1', 'search', { q: 'x' }))],
      toolNode: governedToolNode([inner], { toolRefs: TOOL_REFS, governance: h.governance }),
    });
    await graph.invoke(start(), CFG);
    expect(seen).toEqual(['run_required']);
  });
});

describe('gatewayCallContext: a run id the invoker places in configurable', () => {
  it('is not handed to an undeclared tool: its function sees no key and asking for the run throws run_required', async () => {
    const h = await createHarness();
    const seen: unknown[] = [];
    const inner = tool(
      (args: { q: string }, config) => {
        seen.push(
          (config.configurable as Record<string, unknown> | undefined)?.[EXTERNAL_RUN_ID_KEY]
        );
        try {
          gatewayCallContext(config);
        } catch (error) {
          seen.push((error as { code?: string }).code);
        }
        return `found ${args.q}`;
      },
      { name: 'search', description: 'Search.', schema: z.object({ q: z.string() }) }
    );
    const graph = buildGraph({
      script: [ask(call('c1', 'search', { q: 'x' }))],
      toolNode: governedToolNode([inner], { toolRefs: TOOL_REFS, governance: h.governance }),
    });
    await graph.invoke(start(), {
      configurable: { ...CFG.configurable, [EXTERNAL_RUN_ID_KEY]: 'run_forged' },
    });
    expect(seen).toEqual([undefined, 'run_required']);
  });

  it('is replaced for a declared tool by the run the adapter decided under', async () => {
    const h = await createHarness();
    const seen: unknown[] = [];
    const inner = tool(
      (args: { title: string }, config) => {
        seen.push(gatewayCallContext(config).externalRunId);
        return `created ${args.title}`;
      },
      { name: 'create_issue', description: 'Create.', schema: z.object({ title: z.string() }) }
    );
    const graph = buildGraph({
      script: CREATE,
      toolNode: governedToolNode([inner], {
        toolRefs: TOOL_REFS,
        governance: h.governance,
        gatewayTools: ['create_issue'],
      }),
    });
    // The gateway admits the call on the first pass: the function runs with the run the adapter decided under.
    await h.preapprove('t1', TOOL_REFS.create_issue, { title: 'x' });
    await graph.invoke(start(), {
      configurable: { ...CFG.configurable, [EXTERNAL_RUN_ID_KEY]: 'run_forged' },
    });
    const runId = (h.seen('POST', '/v1/decisions')[0]?.body as { actor: { run_id: string } }).actor
      .run_id;
    expect(runId).not.toBe('run_forged');
    expect(seen).toEqual([runId]);
  });

  it('reads only a run this adapter handed off: a string or a look-alike object under the key throws run_required', () => {
    for (const value of ['run_x', { run_id: 'run_x' }, Object.freeze({ run_id: 'run_x' })]) {
      let code: unknown;
      try {
        gatewayCallContext({ configurable: { [EXTERNAL_RUN_ID_KEY]: value } });
      } catch (error) {
        code = (error as { code?: string }).code;
      }
      expect(code).toBe('run_required');
    }
  });
});
