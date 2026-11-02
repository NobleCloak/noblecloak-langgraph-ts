import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGovernance, runResumer } from '@noblecloak/langgraph';
import { createMock } from '@noblecloak/spec';
import { describe, expect, it } from 'vitest';

import { buildAgent, runAgent } from './agent.js';
import { approvePending, registerRefundTool, SHOW_ARGUMENTS_FIELD } from './deployment.js';
import { env, say } from './log.js';

const BASE_URL = 'https://govern.example.test';

async function deployment() {
  const mock = await createMock({ audience: BASE_URL });
  const tokens = await mock.tokens();
  const fetchImpl: typeof globalThis.fetch = (input, init) =>
    Promise.resolve(mock.app.fetch(new Request(input, init)));
  const work = mkdtempSync(join(tmpdir(), 'nc-example-'));
  const files = {
    checkpointFile: join(work, 'checkpoints.sqlite'),
    refundLog: join(work, 'refunds.log'),
  };
  const governance = () =>
    createGovernance({ baseUrl: BASE_URL, getToken: () => tokens.creator, fetch: fetchImpl });
  return {
    mock,
    tokens,
    fetchImpl,
    files,
    governance,
    target: { baseUrl: BASE_URL, fetch: fetchImpl },
  };
}

const refunds = (file: string): number =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l !== '').length
    : 0;

const until = async (check: () => boolean): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe('the example, in one process', () => {
  it.each([
    ['a hand-built graph with governedToolNode', {}],
    ['createAgent with governanceMiddleware', { middleware: true }],
  ])(
    '%s: the agent pauses on the refund, the approver approves, the worker resumes: one refund',
    async (_name, variant) => {
      const d = await deployment();
      await registerRefundTool(d.target, d.tokens.creator);
      const paused = await runAgent({ governance: d.governance(), ...d.files, ...variant });
      expect(paused.finished).toBe(false);
      expect(refunds(d.files.refundLog)).toBe(0);

      const approved = await approvePending(d.target, d.tokens.approver);
      expect(approved).toEqual([paused.approvalId]);

      const governance = d.governance();
      const worker = await runResumer(buildAgent({ governance, ...d.files, ...variant }), {
        governance,
        reconcileIntervalMs: 0,
      });
      await until(() => refunds(d.files.refundLog) === 1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await worker.stop();
      expect(refunds(d.files.refundLog)).toBe(1);
      expect(d.mock.state.obligations.get(paused.approvalId ?? '')?.state).toBe('consumed');
      expect(d.mock.state.records.at(-1)).toMatchObject({ approval_id: paused.approvalId });
    }
  );

  it('without the tool in the catalog the refund is denied, not paused', async () => {
    const d = await deployment();
    const outcome = await runAgent({ governance: d.governance(), ...d.files });
    expect(outcome.finished).toBe(true);
    expect(refunds(d.files.refundLog)).toBe(0);
  });

  it('registers the refund tool with the setting that shows its arguments to approvers', async () => {
    const d = await deployment();
    await registerRefundTool(d.target, d.tokens.creator);
    const listed = await d.fetchImpl(`${BASE_URL}/v1/tools`, {
      headers: { authorization: `Bearer ${d.tokens.creator}` },
    });
    const tools = ((await listed.json()) as { data: Record<string, unknown>[] }).data;
    const refund = tools.find((t) => t.tool_ref === 'ext:billing:issue_refund');
    expect(refund).toMatchObject({ transport: 'external', [SHOW_ARGUMENTS_FIELD]: true });
  });

  it('registering the tool twice is fine; a refusal is not', async () => {
    const d = await deployment();
    await registerRefundTool(d.target, d.tokens.creator);
    await registerRefundTool(d.target, d.tokens.creator);
    await expect(
      registerRefundTool(
        { baseUrl: BASE_URL, fetch: () => Promise.resolve(new Response('{}', { status: 500 })) },
        d.tokens.creator
      )
    ).rejects.toThrow('500');
  });

  it('the approver reports a listing or an approval the deployment refuses', async () => {
    const d = await deployment();
    await expect(
      approvePending(
        { baseUrl: BASE_URL, fetch: () => Promise.resolve(new Response('{}', { status: 403 })) },
        d.tokens.approver
      )
    ).rejects.toThrow('403');
    await registerRefundTool(d.target, d.tokens.creator);
    await runAgent({ governance: d.governance(), ...d.files });
    // The agent's own service principal can never approve.
    await expect(approvePending(d.target, d.tokens.creator)).resolves.toEqual([]);
    expect(await approvePending(d.target, d.tokens.approver)).toHaveLength(1);
    const refused: typeof globalThis.fetch = (input, init) =>
      init?.method === 'POST'
        ? Promise.resolve(new Response('{}', { status: 409 }))
        : d.fetchImpl(input, init);
    await expect(
      approvePending({ baseUrl: BASE_URL, fetch: refused }, d.tokens.approver)
    ).resolves.toEqual([]);
  });

  it('log helpers: say writes a JSON line, env refuses a missing variable', () => {
    const lines: string[] = [];
    const real = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      lines.push(String(chunk));
      return true;
    };
    try {
      say('hello', { n: 1 });
    } finally {
      process.stdout.write = real;
    }
    expect(JSON.parse(lines.join(''))).toEqual({ event: 'hello', n: 1 });
    expect(() => env('NC_SURELY_NOT_SET')).toThrow('NC_SURELY_NOT_SET is not set');
    process.env.NC_EXAMPLE_TEST = 'x';
    expect(env('NC_EXAMPLE_TEST')).toBe('x');
  });
});
