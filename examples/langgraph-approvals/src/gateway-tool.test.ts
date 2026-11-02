import { createGovernance, resumeApproval } from '@noblecloak/langgraph';
import { createMock } from '@noblecloak/spec';
import { describe, expect, it } from 'vitest';

import { approvePending } from './deployment.js';
import {
  buildGatewayAgent,
  fakeGateway,
  GATEWAY_THREAD_ID,
  GATEWAY_TOKEN,
  GATEWAY_TOOL_REF,
  GATEWAY_URL,
  runGatewayAgent,
} from './gateway-tool.js';

const BASE_URL = 'https://govern.example.test';

async function world() {
  const mock = await createMock({ audience: BASE_URL });
  const tokens = await mock.tokens();
  const decisions = { count: 0 };
  const fetchImpl: typeof globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'POST' && new URL(request.url).pathname === '/v1/decisions')
      decisions.count += 1;
    return Promise.resolve(mock.app.fetch(request));
  };
  const governance = createGovernance({
    baseUrl: BASE_URL,
    getToken: () => tokens.creator,
    fetch: fetchImpl,
  });
  const gateway = fakeGateway(mock);
  const graph = buildGatewayAgent({
    governance,
    gateway: { fetch: gateway.fetch, getToken: () => GATEWAY_TOKEN },
  });
  return {
    mock,
    decisions,
    tokens,
    governance,
    gateway,
    graph,
    target: { baseUrl: BASE_URL, fetch: fetchImpl },
  };
}

const messagesOf = async (w: Awaited<ReturnType<typeof world>>): Promise<string[]> =>
  (
    (await w.graph.getState({ configurable: { thread_id: GATEWAY_THREAD_ID } })).values as {
      messages: { content: unknown }[];
    }
  ).messages.map((m) => String(m.content));

describe('the gateway-tool example', () => {
  it('pauses, is approved, and the re-issued call is admitted by the gateway exactly once, naming the run', async () => {
    const w = await world();
    const approvalId = await runGatewayAgent(w.graph);
    expect(approvalId).toBeDefined();
    // Paused: the function (the gateway call) has not been made.
    expect(w.gateway.calls).toEqual([]);

    expect(await approvePending(w.target, w.tokens.approver)).toEqual([approvalId]);
    const outcome = await resumeApproval(w.graph, approvalId ?? '', { governance: w.governance });
    expect(outcome).toMatchObject({ status: 'resumed' });

    // One call, made under the run the adapter decided in, with the approved arguments.
    const runId = w.mock.state.obligations.get(approvalId ?? '')?.runId;
    expect(runId).toMatch(/^run_/);
    expect(w.gateway.calls).toEqual([
      { runId, digest: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown, admitted: true },
    ]);
    expect(w.mock.state.obligations.get(approvalId ?? '')?.state).toBe('consumed');
    // The gateway records its own call; the adapter wrote no outcome record of its own.
    expect(w.mock.state.records).toHaveLength(0);
    expect(await messagesOf(w)).toContain('Issue "Order A-7" created.');
  });

  it('the gateway refuses what the adapter never sends: no run, a second use, another token', async () => {
    const w = await world();
    const approvalId = await runGatewayAgent(w.graph);
    await approvePending(w.target, w.tokens.approver);
    await resumeApproval(w.graph, approvalId ?? '', { governance: w.governance });
    const runId = w.mock.state.obligations.get(approvalId ?? '')?.runId ?? '';
    const send = (headers: Record<string, string>) =>
      w.gateway.fetch(GATEWAY_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${GATEWAY_TOKEN}`, ...headers },
        body: JSON.stringify({ tool_ref: GATEWAY_TOOL_REF, arguments: { title: 'Order A-7' } }),
      });
    // The same approval, spent: refused.
    const again = await send({ 'X-NobleCloak-External-Run-Id': runId });
    expect(again.status).toBe(409);
    // No run named: refused.
    expect((await send({})).status).toBe(403);
    // Another run: no matching approval.
    expect((await send({ 'X-NobleCloak-External-Run-Id': 'run_other' })).status).toBe(403);
    // The `/v1` token is not the gateway's.
    const wrong = await w.gateway.fetch(GATEWAY_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${w.tokens.creator}`,
        'X-NobleCloak-External-Run-Id': runId,
      },
      body: '{}',
    });
    expect(wrong.status).toBe(401);
  });

  it('reads only the NobleCloak run header; a header of another name alone is ignored', async () => {
    const w = await world();
    const approvalId = await runGatewayAgent(w.graph);
    await approvePending(w.target, w.tokens.approver);
    const runId = w.mock.state.obligations.get(approvalId ?? '')?.runId ?? '';
    const send = (headers: Record<string, string>) =>
      w.gateway.fetch(GATEWAY_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${GATEWAY_TOKEN}`, ...headers },
        body: JSON.stringify({ tool_ref: GATEWAY_TOOL_REF, arguments: { title: 'Order A-7' } }),
      });
    const oldName = 'X-Other-External-Run-Id';
    // Another name alone: treated as no run, the refusal a missing run gets, and nothing is spent.
    const old = await send({ [oldName]: runId });
    expect(old.status).toBe(403);
    expect(await old.json()).toEqual({ error: 'external_run_required' });
    expect(w.gateway.calls.at(-1)).toMatchObject({ runId: null, admitted: false });
    // The new name admits the same, still-unspent approval, and the value is matched lower-cased, as the
    // hosted gateway does: the upper-cased id selects the run. (The stand-in's trim is defensive only;
    // fetch Headers already strips surrounding whitespace, so a test cannot reach it.)
    expect((await send({ 'X-NobleCloak-External-Run-Id': runId.toUpperCase() })).status).toBe(200);
  });

  it('an approval that was never answered is not admitted', async () => {
    const w = await world();
    const approvalId = await runGatewayAgent(w.graph);
    const runId = w.mock.state.obligations.get(approvalId ?? '')?.runId ?? '';
    const response = await w.gateway.fetch(GATEWAY_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${GATEWAY_TOKEN}`, 'X-NobleCloak-External-Run-Id': runId },
      body: JSON.stringify({ tool_ref: GATEWAY_TOOL_REF, arguments: { title: 'Order A-7' } }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'approval_required' });
  });

  it('a gateway refusal of the re-issued call is the tool error the model reads, and nothing is decided again', async () => {
    const w = await world();
    // The builder's MCP client presents the `/v1` token to the gateway: the two tokens were mixed up.
    const graph = buildGatewayAgent({
      governance: w.governance,
      gateway: { fetch: w.gateway.fetch, getToken: () => w.tokens.creator },
    });
    const approvalId = await runGatewayAgent(graph);
    await approvePending(w.target, w.tokens.approver);
    await resumeApproval(graph, approvalId ?? '', { governance: w.governance });
    const state = await graph.getState({ configurable: { thread_id: GATEWAY_THREAD_ID } });
    const texts = (state.values as { messages: { content: unknown }[] }).messages.map((m) =>
      String(m.content)
    );
    expect(texts.join('\n')).toContain('the gateway refused the call: bad_token');
    expect(w.mock.state.obligations.get(approvalId ?? '')?.state).toBe('approved');
    // Two decisions only: the first call (step_up) and the re-run after the approver acted (allow). The
    // gateway's refusal is the tool's error and decides nothing again.
    expect(w.decisions.count).toBe(2);
  });
});
