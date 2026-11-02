import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { browserDemoSucceeded, parseDecision, runBrowserDemo } from '../src/browser.js';
import type { BrowserDemoResult } from '../src/browser.js';
import { approvePending, denyPending } from '../src/deployment.js';

const binDir = join(import.meta.dirname, '../dist/bin');
const APP_ORIGIN = 'http://localhost:3000';

/** Runs the browser mode and plays the person in the browser with a script on the approver token. */
async function run(
  decision: 'approve' | 'deny'
): Promise<{ result: BrowserDemoResult; origin: string | null }> {
  let origin: string | null = null;
  const lines: string[] = [];
  const result = await runBrowserDemo({
    binDir,
    decision,
    mockPort: 0,
    appOrigin: APP_ORIGIN,
    waitMs: 40_000,
    onLine: (name, line) => lines.push(`[${name}] ${line}`),
    onReady: ({ baseUrl, approvalsUrl }) => {
      expect(approvalsUrl).toBe(`${APP_ORIGIN}/approvals`);
      void (async () => {
        const mockTokens = await fetch(`${baseUrl}/__mock/tokens`, {
          headers: { origin: APP_ORIGIN },
        });
        origin = mockTokens.headers.get('access-control-allow-origin');
        const { approver } = (await mockTokens.json()) as { approver: string };
        await (decision === 'approve' ? approvePending : denyPending)({ baseUrl }, approver);
      })();
    },
  });
  expect(lines.join('\n')).toContain('worker_resumed');
  return { result, origin };
}

describe('start:browser', () => {
  it('approve: the worker resumes, exactly one refund, the approval is consumed, and the mock lets only the app call it', async () => {
    const { result, origin } = await run('approve');
    expect(result).toMatchObject({ resumed: true, refunds: 1, approvalState: 'consumed' });
    expect(browserDemoSucceeded(result)).toBe(true);
    expect(origin).toBe(APP_ORIGIN);
  });

  it('deny: the thread ends and no refund is issued', async () => {
    const { result } = await run('deny');
    expect(result).toMatchObject({ resumed: true, refunds: 0, approvalState: 'rejected' });
    expect(browserDemoSucceeded(result)).toBe(true);
  });

  it('stops waiting when asked to, and stops what it started', async () => {
    const stop = new AbortController();
    await expect(
      runBrowserDemo({
        binDir,
        decision: 'approve',
        mockPort: 0,
        appOrigin: APP_ORIGIN,
        signal: stop.signal,
        onReady: () => {
          stop.abort();
        },
      })
    ).rejects.toThrow('stopped while waiting');
  });

  it('reports a mock that exits at once (its port is taken) as that, not as a timeout', async () => {
    const taken = createServer();
    await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve));
    const { port } = taken.address() as { port: number };
    try {
      await expect(
        runBrowserDemo({ binDir, decision: 'approve', mockPort: port, appOrigin: APP_ORIGIN })
      ).rejects.toThrow(/the mock exited .* \(is port \d+ in use\?\)/);
    } finally {
      await new Promise((resolve) => taken.close(resolve));
    }
  });

  it('reports a process that fails', async () => {
    await expect(
      runBrowserDemo({
        binDir: join(import.meta.dirname, 'no-such-directory'),
        decision: 'approve',
        mockPort: 0,
        appOrigin: APP_ORIGIN,
      })
    ).rejects.toThrow('the agent failed');
  });
});

describe('the outcome a decision calls for', () => {
  const base: BrowserDemoResult = {
    decision: 'approve',
    refunds: 1,
    resumed: true,
    approvalState: 'consumed',
  };

  it.each([
    ['approve with one refund', base, true],
    ['approve with no refund', { ...base, refunds: 0 }, false],
    ['approve with two refunds', { ...base, refunds: 2 }, false],
    ['approve whose approval is not consumed', { ...base, approvalState: 'approved' }, false],
    [
      'deny with no refund and a rejected approval',
      { ...base, decision: 'deny' as const, refunds: 0, approvalState: 'rejected' },
      true,
    ],
    [
      'deny with a refund',
      { ...base, decision: 'deny' as const, refunds: 1, approvalState: 'rejected' },
      false,
    ],
    [
      'deny with no refund but an expired approval',
      { ...base, decision: 'deny' as const, refunds: 0, approvalState: 'expired' },
      false,
    ],
    [
      'deny with no refund but an approval that was approved',
      { ...base, decision: 'deny' as const, refunds: 0, approvalState: 'approved' },
      false,
    ],
    ['a thread that never resumed', { ...base, resumed: false }, false],
  ])('%s', (_name, result, expected) => {
    expect(browserDemoSucceeded(result)).toBe(expected);
  });

  it('NC_DECISION: unset and empty mean approve, deny is deny, anything else is refused', () => {
    expect(parseDecision(undefined)).toBe('approve');
    expect(parseDecision('')).toBe('approve');
    expect(parseDecision('approve')).toBe('approve');
    expect(parseDecision('deny')).toBe('deny');
    expect(() => parseDecision('maybe')).toThrow('NC_DECISION is approve or deny');
  });
});

describe('the built bin (dist/bin/browser.js)', () => {
  /** Starts the bin, plays the person in the browser with `acts`, and returns the exit code and output. */
  async function bin(
    env: Record<string, string>,
    acts: 'approve' | 'deny' | 'none'
  ): Promise<{ code: number | null; out: string }> {
    const child = spawn(process.execPath, [join(binDir, 'browser.js')], {
      env: { ...process.env, NC_MOCK_PORT: '0', NC_APP_ORIGIN: APP_ORIGIN, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let acted = false;
    const act = async (baseUrl: string): Promise<void> => {
      const tokens = (await (await fetch(`${baseUrl}/__mock/tokens`)).json()) as {
        approver: string;
      };
      await (acts === 'approve' ? approvePending : denyPending)({ baseUrl }, tokens.approver);
    };
    const onData = (chunk: Buffer): void => {
      out += chunk.toString();
      const ready = /"event":"browser_ready"[^\n]*/.exec(out);
      const api = ready === null ? null : /"api":"([^"]+)"/.exec(ready[0]);
      if (!acted && acts !== 'none' && api?.[1] !== undefined) {
        acted = true;
        void act(api[1]);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => child.kill('SIGKILL'), 40_000);
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    clearTimeout(timer);
    return { code, out };
  }

  it('exits 1 when the person does the opposite of NC_DECISION (the harness approves, NC_DECISION=deny)', async () => {
    const { code, out } = await bin({ NC_DECISION: 'deny' }, 'approve');
    expect(out).toContain('browser_done');
    expect(code).toBe(1);
  });

  it('exits 0 when the outcome matches (deny, then deny)', async () => {
    const { code } = await bin({ NC_DECISION: 'deny' }, 'deny');
    expect(code).toBe(0);
  });

  it('exits non-zero on an unparseable NC_DECISION, before starting anything', async () => {
    const { code, out } = await bin({ NC_DECISION: 'maybe' }, 'none');
    expect(code).not.toBe(0);
    expect(out).toContain('NC_DECISION is approve or deny');
  });
});

describe('a SIGTERM during the agent run', () => {
  it('ends the wait for the agent instead of waiting for it to exit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-slow-agent-'));
    try {
      writeFileSync(
        join(dir, 'agent.js'),
        "console.log('agent_started'); setTimeout(() => undefined, 30000);\n"
      );
      const stop = new AbortController();
      await expect(
        runBrowserDemo({
          binDir: dir,
          decision: 'approve',
          mockPort: 0,
          appOrigin: APP_ORIGIN,
          signal: stop.signal,
          onLine: (name) => {
            if (name === 'agent') stop.abort();
          },
        })
      ).rejects.toThrow('stopped while waiting for the agent to pause');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
