/**
 * The parts of the langgraph skill's acceptance run that stand alone (`skill-exercise-agent.ts` is the run): a
 * service-principal credential, a stand-in token endpoint, child processes whose output is read line by line, and
 * the small checks the run is made of. Tested in `skill-langgraph.test.ts`.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Json = Record<string, unknown>;

/** A generated service-principal credential whose token endpoint is `tokenEndpoint` (the shape the client reads). */
export async function servicePrincipalCredential(tokenEndpoint: string, audience: string) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  return {
    client_id: `sp_${crypto.randomUUID()}`,
    token_endpoint: tokenEndpoint,
    assertion_audience: audience,
    private_jwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
  };
}

export interface TokenEndpoint {
  readonly url: string;
  /** The `client_id` of each token request it answered. */
  readonly requests: string[];
  stop(): Promise<void>;
}

/**
 * A stand-in for the sign-in service's token endpoint: it answers every `client_credentials` request that carries a
 * client assertion with `token` (the mock has no token endpoint, and its service-principal token is minted by it).
 */
export async function startTokenEndpoint(token: string): Promise<TokenEndpoint> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      const form = new URLSearchParams(body);
      const valid =
        req.method === 'POST' &&
        form.get('grant_type') === 'client_credentials' &&
        (form.get('client_assertion') ?? '') !== '';
      if (!valid) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_request' }));
        return;
      }
      requests.push(form.get('client_id') ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: 3600 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/token`,
    requests,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

export interface Running {
  readonly child: ChildProcess;
  readonly lines: string[];
  readonly exited: Promise<number | null>;
}

/** Starts `command` with its output read line by line (stdout and stderr, in one list). */
export function start(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): Running {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines: string[] = [];
  for (const stream of [child.stdout, child.stderr]) {
    let buffered = '';
    stream.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      const parts = buffered.split('\n');
      buffered = parts.pop() ?? '';
      lines.push(...parts);
    });
    stream.on('close', () => {
      if (buffered !== '') lines.push(buffered);
    });
  }
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => {
      resolve(code);
    });
  });
  return { child, lines, exited };
}

export async function until(
  check: () => boolean,
  what: string,
  timeoutMs = 60_000,
  failed?: () => string | undefined
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    const failure = failed?.();
    if (failure !== undefined) throw new Error(failure);
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The JSON events a process printed (`{ "event": ..., ... }` lines). */
export function eventsIn(lines: readonly string[]): Json[] {
  return lines.flatMap((line) => {
    try {
      const parsed: unknown = JSON.parse(line);
      return typeof parsed === 'object' && parsed !== null && 'event' in parsed ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

/** The environment of a child process: ours without any pasted token, so only the credential can authenticate. */
export function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const pasted = ['NC_TOKEN', 'NC_PROPOSER_TOKEN'];
  const inherited = Object.entries(process.env).filter(([name]) => !pasted.includes(name));
  return { ...Object.fromEntries(inherited), ...extra };
}
