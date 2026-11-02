/**
 * `start:browser`: the mock and a paused agent, for a person in a browser to approve. The mock listens on a
 * fixed port and lets one origin call it, the refund tool is registered, the agent runs until it pauses and
 * the worker waits. It resolves when the worker has resumed the thread, and says whether the outcome is the
 * one the decision calls for: approve means exactly one refund and a consumed approval, deny means a
 * rejected approval, the thread resumed (ended) and no refund.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { registerRefundTool } from './deployment.js';
import { hasExited, sleep, start, stopAll, until } from './processes.js';
import type { Running } from './processes.js';

export type Decision = 'approve' | 'deny';

export interface BrowserDemoOptions {
  /** The directory holding the built entry points (agent.js, worker.js). */
  readonly binDir: string;
  /** What the person is expected to do in the browser. */
  readonly decision: Decision;
  /** The mock's port; 8787 for the example app, 0 in tests. */
  readonly mockPort: number;
  /** The one origin the mock lets a browser call it from, e.g. `http://localhost:3000`. */
  readonly appOrigin: string;
  /** Called with each line a process writes, tagged with its name. */
  readonly onLine?: (process: string, line: string) => void;
  /** Called once, with the mock's address and the page to open, when the approval is pending. */
  readonly onReady?: (ready: { baseUrl: string; approvalsUrl: string; approvalId: string }) => void;
  /** How long to wait for the person; the demo is interactive, so it is long by default. */
  readonly waitMs?: number;
  readonly signal?: AbortSignal;
}

export interface BrowserDemoResult {
  readonly decision: Decision;
  readonly refunds: number;
  /** True when the worker resumed the paused thread (with the refund result, or with the denial). */
  readonly resumed: boolean;
  /** The state of the approval the person decided, read with the agent's token. */
  readonly approvalState: string;
}

/** Whether the outcome is the one the decision calls for. */
export function browserDemoSucceeded(result: BrowserDemoResult): boolean {
  if (!result.resumed) return false;
  return result.decision === 'approve'
    ? result.refunds === 1 && result.approvalState === 'consumed'
    : result.refunds === 0 && result.approvalState === 'rejected';
}

/** Reads `NC_DECISION`: unset means approve; anything but `approve` or `deny` is an error. */
export function parseDecision(value: string | undefined): Decision {
  if (value === undefined || value === '' || value === 'approve') return 'approve';
  if (value === 'deny') return 'deny';
  throw new Error(`NC_DECISION is approve or deny, not ${JSON.stringify(value)}`);
}

export async function runBrowserDemo(options: BrowserDemoOptions): Promise<BrowserDemoResult> {
  const onLine = options.onLine ?? ((): void => undefined);
  const bin = (name: string): string => join(options.binDir, `${name}.js`);
  const work = mkdtempSync(join(tmpdir(), 'nc-langgraph-browser-'));
  const checkpoints = join(work, 'checkpoints.sqlite');
  const refundLog = join(work, 'refunds.log');

  const require = createRequire(import.meta.url);
  const spec = dirname(require.resolve('@noblecloak/spec/package.json'));
  const mock = start(
    'mock',
    join(spec, 'dist/cli/nc-mock.js'),
    ['--port', String(options.mockPort), '--allow-origin', options.appOrigin],
    {},
    onLine
  );
  const running: Running[] = [mock];
  try {
    await until(
      () => mock.lines().join('\n').trim().endsWith('}'),
      'the mock to print its address',
      30_000,
      options.signal,
      () =>
        hasExited(mock)
          ? `the mock exited (code ${String(mock.child.exitCode)}) before printing its address (is port ${String(options.mockPort)} in use?)`
          : undefined
    );
    const { base_url: baseUrl, tokens } = JSON.parse(mock.lines().join('\n')) as {
      base_url: string;
      tokens: { creator: string };
    };
    await registerRefundTool({ baseUrl }, tokens.creator);
    // The agent and the worker are one service principal; the person in the browser is the approver.
    const shared = {
      NC_BASE_URL: baseUrl,
      NC_TOKEN: tokens.creator,
      NC_CHECKPOINTS: checkpoints,
      NC_REFUND_LOG: refundLog,
    };

    const agent = start('agent', bin('agent'), [], shared, onLine);
    running.push(agent);
    // A SIGTERM during the agent run ends the wait: `until` throws once the signal is aborted.
    await until(() => hasExited(agent), 'the agent to pause', 60_000, options.signal);
    if ((await agent.exited) !== 0) throw new Error('the agent failed');
    const paused = agent.lines().find((l) => l.includes('agent_paused'));
    if (paused === undefined) throw new Error('the agent did not pause');
    let approvalId: unknown;
    try {
      approvalId = (JSON.parse(paused) as { approval_id?: unknown }).approval_id;
    } catch {
      approvalId = undefined;
    }
    if (typeof approvalId !== 'string' || approvalId === '')
      throw new Error(`the agent paused without an approval id: ${paused}`);

    const worker = start('worker', bin('worker'), [], shared, onLine);
    running.push(worker);
    const workerGone = (): string | undefined =>
      hasExited(worker)
        ? `the worker exited (code ${String(worker.child.exitCode)}) before resuming the thread`
        : undefined;
    await until(
      () => worker.lines().some((l) => l.includes('worker_ready')),
      'the worker to start',
      30_000,
      options.signal,
      workerGone
    );
    options.onReady?.({
      baseUrl,
      approvalsUrl: `${options.appOrigin}/approvals`,
      approvalId,
    });

    await until(
      () => worker.lines().some((l) => l.includes('worker_resumed')),
      `the ${options.decision} in the browser`,
      options.waitMs ?? 15 * 60_000,
      options.signal,
      () =>
        workerGone() ??
        (hasExited(mock)
          ? `the mock exited (code ${String(mock.child.exitCode)}) while waiting`
          : undefined)
    );
    // Give a second, wrongly started, refund time to show itself.
    await sleep(500);

    const read = await fetch(`${baseUrl}/v1/approvals/${approvalId}`, {
      headers: { authorization: `Bearer ${tokens.creator}` },
    });
    if (!read.ok)
      throw new Error(`reading approval ${approvalId} failed: HTTP ${String(read.status)}`);
    const approval = ((await read.json()) as { data: { state: string } }).data;
    return {
      decision: options.decision,
      refunds: existsSync(refundLog)
        ? readFileSync(refundLog, 'utf8')
            .split('\n')
            .filter((l) => l !== '').length
        : 0,
      resumed: true,
      approvalState: approval.state,
    };
  } finally {
    // Wait for the exits: the next run on this port must not find the mock still bound to it.
    await stopAll(running);
  }
}
