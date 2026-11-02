/**
 * The whole loop, unattended: the mock, then the agent (which pauses), then the worker, then the
 * approver, each its own node process. The refund must have happened exactly once.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { registerRefundTool } from './deployment.js';
import { eventsOf, sleep, start, until } from './processes.js';
import type { Running } from './processes.js';

export interface DemoOptions {
  /** The directory holding the built entry points (agent.js, worker.js, approve.js). */
  readonly binDir: string;
  /** Run the agent built with `createAgent` and `governanceMiddleware`. */
  readonly middleware?: boolean;
  /** Called with each line a process writes, tagged with its name. */
  readonly onLine?: (process: string, line: string) => void;
}

export interface DemoResult {
  readonly refunds: number;
  readonly events: { process: string; event: string }[];
  readonly approvalState: string | undefined;
}

export async function runDemo(options: DemoOptions): Promise<DemoResult> {
  const onLine = options.onLine ?? ((): void => undefined);
  const bin = (name: string): string => join(options.binDir, `${name}.js`);
  const work = mkdtempSync(join(tmpdir(), 'nc-langgraph-demo-'));
  const checkpoints = join(work, 'checkpoints.sqlite');
  const refundLog = join(work, 'refunds.log');

  // The mock, as `nc-mock` serves it: it prints its address and the dev tokens, then serves.
  const require = createRequire(import.meta.url);
  const spec = dirname(require.resolve('@noblecloak/spec/package.json'));
  const mock = start('mock', join(spec, 'dist/cli/nc-mock.js'), ['--port', '0'], {}, onLine);
  const running: Running[] = [mock];
  try {
    await until(
      () => mock.lines().join('\n').trim().endsWith('}'),
      'the mock to print its address'
    );
    const { base_url: baseUrl, tokens } = JSON.parse(mock.lines().join('\n')) as {
      base_url: string;
      tokens: { creator: string; approver: string };
    };
    await registerRefundTool({ baseUrl }, tokens.creator);
    // The agent's service principal, and the same one for the worker.
    const shared = {
      NC_BASE_URL: baseUrl,
      NC_TOKEN: tokens.creator,
      NC_CHECKPOINTS: checkpoints,
      NC_REFUND_LOG: refundLog,
      ...(options.middleware === true ? { NC_MIDDLEWARE: '1' } : {}),
    };

    const agent = start('agent', bin('agent'), [], shared, onLine);
    running.push(agent);
    if ((await agent.exited) !== 0) throw new Error('the agent failed');
    if (!agent.lines().some((l) => l.includes('agent_paused')))
      throw new Error('the agent did not pause');

    // The agent process is gone. The paused run is in the checkpoint file.
    const worker = start('worker', bin('worker'), [], shared, onLine);
    running.push(worker);
    await until(
      () => worker.lines().some((l) => l.includes('worker_ready')),
      'the worker to start'
    );

    const approver = start(
      'approver',
      bin('approve'),
      [],
      { NC_BASE_URL: baseUrl, NC_APPROVER_TOKEN: tokens.approver },
      onLine
    );
    running.push(approver);
    if ((await approver.exited) !== 0) throw new Error('the approver failed');

    await until(
      () => worker.lines().some((l) => l.includes('worker_resumed')),
      'the worker to resume the thread'
    );
    // Give a second, wrongly started, refund time to show itself.
    await sleep(500);

    const approvals = await fetch(`${baseUrl}/v1/approvals?state=consumed`, {
      headers: { authorization: `Bearer ${tokens.creator}` },
    });
    const consumed = ((await approvals.json()) as { data: { state: string }[] }).data;
    return {
      refunds: existsSync(refundLog)
        ? readFileSync(refundLog, 'utf8')
            .split('\n')
            .filter((l) => l !== '').length
        : 0,
      events: running.flatMap((r) => eventsOf(r)),
      approvalState: consumed[0]?.state,
    };
  } finally {
    for (const { child } of running) child.kill('SIGTERM');
  }
}
