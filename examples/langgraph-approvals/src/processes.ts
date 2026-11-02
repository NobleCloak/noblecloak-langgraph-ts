/** Child processes of the examples: started with their output read line by line, waited on, and read for events. */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

export interface Running {
  readonly name: string;
  readonly child: ChildProcess;
  /** Resolves with the exit code. */
  readonly exited: Promise<number | null>;
  lines(): string[];
}

export function start(
  name: string,
  script: string,
  args: string[],
  env: Record<string, string>,
  onLine: (process: string, line: string) => void
): Running {
  const child = spawn(process.execPath, [script, ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines: string[] = [];
  let buffered = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffered += chunk.toString();
    const parts = buffered.split('\n');
    buffered = parts.pop() ?? '';
    for (const line of parts) {
      lines.push(line);
      onLine(name, line);
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    for (const line of chunk
      .toString()
      .split('\n')
      .filter((l) => l !== ''))
      onLine(`${name}!`, line);
  });
  // A last line without a newline is still a line once the output has closed.
  child.once('close', () => {
    if (buffered !== '') {
      lines.push(buffered);
      onLine(name, buffered);
      buffered = '';
    }
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => {
      resolve(code);
    });
  });
  return { name, child, exited, lines: () => lines };
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Whether the process has ended, by exit or by signal. */
export const hasExited = ({ child }: Running): boolean =>
  child.exitCode !== null || child.signalCode !== null;

/** Stops the processes and waits until each has exited (SIGKILL after `graceMs`), so their ports are free. */
export async function stopAll(running: readonly Running[], graceMs = 5_000): Promise<void> {
  await Promise.all(
    running.map(async (process) => {
      if (hasExited(process)) return;
      process.child.kill('SIGTERM');
      const timer = setTimeout(() => process.child.kill('SIGKILL'), graceMs);
      await process.exited;
      clearTimeout(timer);
    })
  );
}

/**
 * Waits for `check`. `failed` is asked on every poll: a message from it ends the wait with that message, so
 * a process that has died is reported as that and not as a timeout.
 */
export async function until(
  check: () => boolean,
  what: string,
  timeoutMs = 30_000,
  signal?: AbortSignal,
  failed?: () => string | undefined
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    const failure = failed?.();
    if (failure !== undefined) throw new Error(failure);
    if (signal?.aborted === true) throw new Error(`stopped while waiting for ${what}`);
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

export const eventsOf = ({
  name,
  lines,
}: {
  name: string;
  lines: () => string[];
}): { process: string; event: string }[] =>
  lines().flatMap((line) => {
    try {
      const parsed = JSON.parse(line) as { event?: unknown };
      return typeof parsed.event === 'string' ? [{ process: name, event: parsed.event }] : [];
    } catch {
      return [];
    }
  });
