/**
 * A deployment for tests: the spec package's mock served in-process (no sockets), with a log of every
 * request and a hook to fail a route on purpose. The token is the service principal's; `approve` and
 * `reject` answer as the approving user.
 */
import { createMock } from '@noblecloak/spec';
import type { Break, Mock } from '@noblecloak/spec';

import { createGovernance } from '../src/governance.js';
import type { Governance, GovernanceOptions } from '../src/governance.js';

export const BASE_URL = 'https://govern.mock.test';

export interface LoggedRequest {
  readonly method: string;
  readonly path: string;
  /** The query string, with its leading `?` when there is one. */
  readonly query: string;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

export type Intercept = (
  request: Request,
  body: unknown
) => Response | undefined | Promise<Response | undefined>;

export interface Harness {
  readonly mock: Mock;
  readonly governance: Governance;
  readonly requests: LoggedRequest[];
  readonly tokens: Awaited<ReturnType<Mock['tokens']>>;
  intercept: Intercept | undefined;
  /** Requests whose method and path match. */
  seen(method: string, pathPattern: RegExp | string): LoggedRequest[];
  /** Calls the mock as `token`, outside the adapter. */
  as(token: string, method: string, path: string, body?: unknown): Promise<Response>;
  resolve(approvalId: string, resolution: string, reason?: string): Promise<Response>;
  approve(approvalId: string): Promise<Response>;
  reject(approvalId: string, reason?: string): Promise<Response>;
  /** The approval ids the mock holds, oldest first. */
  approvals(): string[];
  /**
   * An approval the gateway will admit: opened for `toolRef` and `args` in the run of thread `threadId`
   * (the scope the adapter decides in), with no continuation, and approved. Returns its id.
   */
  preapprove(threadId: string, toolRef: string, args: Record<string, unknown>): Promise<string>;
  /** A governance object with the same wiring and its own state, as a second process would have. */
  anotherGovernance(extra?: Partial<GovernanceOptions>): Governance;
}

export interface HarnessOptions {
  readonly advertise?: readonly string[];
  readonly breaks?: readonly Break[];
  readonly expireAfterMs?: number;
  readonly governance?: Partial<GovernanceOptions>;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const mock = await createMock({
    ...(options.advertise === undefined ? {} : { advertise: options.advertise }),
    breaks: new Set(options.breaks ?? []),
    audience: BASE_URL,
    ...(options.expireAfterMs === undefined ? {} : { expireAfterMs: options.expireAfterMs }),
  });
  const tokens = await mock.tokens();
  const requests: LoggedRequest[] = [];
  const harness: Harness = {
    mock,
    tokens,
    requests,
    intercept: undefined,
    governance: undefined as unknown as Governance,
    seen: (method, pattern) =>
      requests.filter(
        (r) =>
          r.method === method &&
          (typeof pattern === 'string' ? r.path === pattern : pattern.test(r.path))
      ),
    as: (token, method, path, body) =>
      Promise.resolve(
        mock.app.fetch(
          new Request(`${BASE_URL}${path}`, {
            method,
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          })
        )
      ),
    resolve: (approvalId, resolution, reason) => {
      const obligation = mock.state.obligations.get(approvalId);
      return harness.as(tokens.approver, 'POST', `/v1/approvals/${approvalId}/resolve`, {
        resolution,
        expected_action_digest: obligation?.argDigest ?? '',
        ...(reason === undefined ? {} : { reason }),
      });
    },
    approve: (id) => harness.resolve(id, 'approved'),
    reject: (id, reason) => harness.resolve(id, 'rejected', reason),
    approvals: () => [...mock.state.obligations.values()].map((o) => o.id),
    preapprove: async (threadId, toolRef, args) => {
      const runId = await harness.governance.runFor(threadId);
      const decided = await harness.as(tokens.creator, 'POST', '/v1/decisions', {
        actor: { run_id: runId },
        action: { tool_ref: toolRef, arguments: args },
      });
      const body = (await decided.json()) as { data: { approval: { id: string } } };
      await harness.approve(body.data.approval.id);
      return body.data.approval.id;
    },
    anotherGovernance: (extra = {}) => make(extra),
  };
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const text = request.method === 'GET' ? '' : await request.clone().text();
    const body: unknown = text === '' ? undefined : JSON.parse(text);
    requests.push({
      method: request.method,
      path: new URL(request.url).pathname,
      query: new URL(request.url).search,
      body,
      headers: Object.fromEntries(request.headers.entries()),
    });
    const forced = await harness.intercept?.(request, body);
    if (forced !== undefined) return forced;
    return mock.app.fetch(request);
  };
  function make(extra: Partial<GovernanceOptions>): Governance {
    return createGovernance({
      baseUrl: BASE_URL,
      getToken: () => tokens.creator,
      fetch: fetchImpl,
      ...options.governance,
      ...extra,
    });
  }
  (harness as { governance: Governance }).governance = make({});
  // A second tool the caller executes, for the scenarios that need two calls that each pause.
  await harness.as(tokens.creator, 'POST', '/v1/tools', {
    tool_ref: 'ext:local:send_sms',
    transport: 'external',
    input_schema: { type: 'object' },
    side_effect_level: 'external',
  });
  return harness;
}

/** A response a route can be forced to give. */
export const status = (code: number): Response =>
  new Response(
    JSON.stringify({
      type: 'https://docs.noblecloak.com/problems/unavailable',
      title: 'x',
      status: code,
    }),
    {
      status: code,
      headers: { 'content-type': 'application/problem+json' },
    }
  );
