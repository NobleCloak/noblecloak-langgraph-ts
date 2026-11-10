import { describe, expect, it, vi } from 'vitest';

import { GovernanceError } from './errors.js';
import { createGovernance, principalOfToken } from './governance.js';
import { createHarness, status } from '../test/harness.js';
import type { Harness } from '../test/harness.js';

/** Answers `GET /v1/capabilities` (a `{data}` envelope) as the mock does, with `continuation_kinds` set to `kinds`, or removed when undefined. */
function advertiseKinds(h: Harness, kinds: readonly string[] | null | undefined): void {
  h.intercept = async (request) => {
    if (new URL(request.url).pathname !== '/v1/capabilities') return undefined;
    const real = (await h.mock.app.fetch(request)).clone();
    const envelope = (await real.json()) as { data: Record<string, unknown> };
    if (kinds === undefined) delete envelope.data.continuation_kinds;
    else envelope.data.continuation_kinds = kinds === null ? null : [...kinds];
    return new Response(JSON.stringify(envelope), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

describe('createGovernance: capabilities', () => {
  it('reads /v1/capabilities once, lazily, and keeps the answer', async () => {
    const h = await createHarness();
    expect(h.seen('GET', '/v1/capabilities')).toHaveLength(0);
    const first = await h.governance.capabilities();
    await h.governance.capabilities();
    expect(first.routesApprovals).toBe(true);
    expect(first.servesRuns).toBe(true);
    expect(h.seen('GET', '/v1/capabilities')).toHaveLength(1);
  });

  it('shares one read between concurrent callers', async () => {
    const h = await createHarness();
    await Promise.all([h.governance.capabilities(), h.governance.capabilities()]);
    expect(h.seen('GET', '/v1/capabilities')).toHaveLength(1);
  });

  it('does not keep a failed read: it throws unreachable and the next call reads again', async () => {
    const h = await createHarness();
    h.intercept = (request) =>
      new URL(request.url).pathname === '/v1/capabilities' ? status(503) : undefined;
    await expect(h.governance.capabilities()).rejects.toMatchObject({ code: 'unreachable' });
    h.intercept = undefined;
    await expect(h.governance.capabilities()).resolves.toMatchObject({ routesApprovals: true });
    expect(h.seen('GET', '/v1/capabilities')).toHaveLength(2);
  });

  it('reports a refused read as api_error', async () => {
    const h = await createHarness();
    h.intercept = (request) =>
      new URL(request.url).pathname === '/v1/capabilities' ? status(403) : undefined;
    await expect(h.governance.capabilities()).rejects.toMatchObject({ code: 'api_error' });
  });

  it('reads an empty resolutions list as "cannot route" and a missing runs family as "no runs"', async () => {
    const h = await createHarness({ advertise: ['decisions', 'records'] });
    await expect(h.governance.capabilities()).resolves.toMatchObject({
      routesApprovals: false,
      servesRuns: false,
    });
  });

  it('D-LG10: approvals advertised without runs is runs_required, on every use and at assertReady', async () => {
    const h = await createHarness({ advertise: ['approvals', 'records'] });
    await expect(h.governance.capabilities()).rejects.toMatchObject({ code: 'runs_required' });
    await expect(h.governance.capabilities()).rejects.toBeInstanceOf(GovernanceError);
    await expect(h.governance.assertReady()).rejects.toMatchObject({ code: 'runs_required' });
  });

  it('D-LG10: runs without approvals is usable', async () => {
    const h = await createHarness({ advertise: ['runs', 'records'] });
    await expect(h.governance.capabilities()).resolves.toMatchObject({
      routesApprovals: false,
      servesRuns: true,
    });
  });
});

describe('createGovernance: continuation_kinds', () => {
  it('an absent list is the kinds of rev 16, which include langgraph: usable, as before', async () => {
    const h = await createHarness();
    advertiseKinds(h, undefined);
    await expect(h.governance.capabilities()).resolves.toMatchObject({ routesApprovals: true });
  });

  it('a list with langgraph is usable', async () => {
    const h = await createHarness();
    advertiseKinds(h, ['adk', 'langgraph', 'claude_agent_sdk']);
    await expect(h.governance.capabilities()).resolves.toMatchObject({ routesApprovals: true });
  });

  it('a list without langgraph is continuation_kind_unsupported, on every use and at assertReady', async () => {
    const h = await createHarness();
    advertiseKinds(h, ['adk', 'claude_agent_sdk']);
    await expect(h.governance.capabilities()).rejects.toMatchObject({
      code: 'continuation_kind_unsupported',
    });
    await expect(h.governance.capabilities()).rejects.toThrow(
      '(adk, claude_agent_sdk) without langgraph'
    );
    await expect(h.governance.capabilities()).rejects.toBeInstanceOf(GovernanceError);
    await expect(h.governance.assertReady()).rejects.toMatchObject({
      code: 'continuation_kind_unsupported',
    });
    expect(h.seen('GET', '/v1/capabilities')).toHaveLength(1);
  });

  it('an empty list advertises no kind at all: refused, not read as "not advertised"', async () => {
    const h = await createHarness();
    advertiseKinds(h, []);
    await expect(h.governance.capabilities()).rejects.toMatchObject({
      code: 'continuation_kind_unsupported',
    });
    await expect(h.governance.capabilities()).rejects.toThrow(
      'advertises an empty list of continuation kinds'
    );
  });

  it('a continuation_kinds member that is not an array is not an advertised list: usable, and the answer is kept', async () => {
    const h = await createHarness();
    advertiseKinds(h, null);
    await expect(h.governance.capabilities()).resolves.toMatchObject({ routesApprovals: true });
    await expect(h.governance.capabilities()).resolves.toMatchObject({ routesApprovals: true });
    expect(h.seen('GET', '/v1/capabilities')).toHaveLength(1);
  });

  it('a list without langgraph on a deployment that routes no approvals is usable: no approval can be opened', async () => {
    const h = await createHarness({ advertise: ['decisions', 'records'] });
    advertiseKinds(h, ['adk']);
    await expect(h.governance.capabilities()).resolves.toMatchObject({ routesApprovals: false });
  });
});

describe('createGovernance: runs', () => {
  it('creates one run per thread, with an Idempotency-Key derived from the thread id', async () => {
    const h = await createHarness();
    const a = await h.governance.runFor('thread-a');
    const again = await h.governance.runFor('thread-a');
    const b = await h.governance.runFor('thread-b');
    expect(again).toBe(a);
    expect(b).not.toBe(a);
    expect(h.seen('POST', '/v1/runs')).toHaveLength(2);
  });

  it('a second process (its own state) gets the same run: the key is derived from the thread id', async () => {
    const h = await createHarness();
    const first = await h.governance.runFor('thread-a');
    const second = await h.anotherGovernance().runFor('thread-a');
    expect(second).toBe(first);
  });

  it('does not keep a failed attempt', async () => {
    const h = await createHarness();
    h.intercept = (request) =>
      new URL(request.url).pathname === '/v1/runs' ? status(503) : undefined;
    await expect(h.governance.runFor('t')).rejects.toMatchObject({ code: 'unreachable' });
    h.intercept = undefined;
    await expect(h.governance.runFor('t')).resolves.toMatch(/^run_/);
  });

  it('refuses a run the deployment answered with a 4xx', async () => {
    const h = await createHarness();
    h.intercept = (request) =>
      new URL(request.url).pathname === '/v1/runs' ? status(403) : undefined;
    await expect(h.governance.runFor('t')).rejects.toMatchObject({ code: 'api_error' });
  });
});

describe('createGovernance: tools and callbacks', () => {
  it('remembers the catalog name of a tool, and refuses to rename it', async () => {
    const h = await createHarness();
    h.governance.registerTool('t', 'mcp:a:b');
    h.governance.registerTool('t', 'mcp:a:b');
    expect(h.governance.toolRefFor('t')).toBe('mcp:a:b');
    expect(h.governance.toolRefFor('other')).toBeUndefined();
    expect(() => {
      h.governance.registerTool('t', 'mcp:a:c');
    }).toThrow(/already governed/);
  });

  it('report calls onError and survives a callback that throws', async () => {
    const seen: string[] = [];
    const h = await createHarness({
      governance: {
        onError: (error) => {
          seen.push(error.code);
          throw new Error('callback failed');
        },
      },
    });
    h.governance.report(new GovernanceError('record_failed', 'x'));
    expect(seen).toEqual(['record_failed']);
  });

  it('without an onError, a reported failure goes to console.error with its code, approval and cause', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const governance = createGovernance({ baseUrl: 'https://x.test', getToken: () => 't' });
      governance.report(
        new GovernanceError('record_failed', 'no record', { cause: new Error('503 upstream') }),
        'ap_1'
      );
      expect(spy).toHaveBeenCalledTimes(1);
      const line = String(spy.mock.calls[0]?.[0]);
      expect(line).toContain('record_failed');
      expect(line).toContain('ap_1');
      expect(line).toContain('503 upstream');
    } finally {
      spy.mockRestore();
    }
  });

  it('defaults: whenUnroutable deny, onRejected tell-model, channel headless', () => {
    const governance = createGovernance({ baseUrl: 'https://x.test', getToken: () => 't' });
    expect(governance.whenUnroutable).toBe('deny');
    expect(governance.onRejected).toBe('tell-model');
    expect(governance.invocationChannel).toBe('headless');
  });
});

describe('createGovernance: key set', () => {
  it('looks a kid the cached set lacks up once more in a fresh set', async () => {
    const h = await createHarness();
    const real = h.mock.jwks();
    let reads = 0;
    const governance = h.anotherGovernance({
      jwks: () => {
        reads += 1;
        return reads === 1 ? { keys: [] } : real;
      },
    });
    // Mint a Resumption through the mock and verify it: the first set has no key, the second does.
    const { verifyViaMock } = await import('../test/resumption.js');
    const verified = await verifyViaMock(h, governance);
    expect(verified.tool_ref).toBe('ext:local:send_email');
    expect(reads).toBe(2);
  });

  it('does not refresh a static key set', async () => {
    const h = await createHarness();
    const governance = h.anotherGovernance({ jwks: { keys: [] } });
    const { verifyViaMock } = await import('../test/resumption.js');
    await expect(verifyViaMock(h, governance)).rejects.toMatchObject({ code: 'unknown_kid' });
  });
});

describe('createGovernance: the principal this process runs as (D-LG15)', () => {
  it('is the sub claim of the access token; a token without one names no principal', async () => {
    const h = await createHarness();
    const sub = principalOfToken(h.tokens.creator);
    expect(sub).toEqual(expect.any(String));
    await expect(h.governance.principal()).resolves.toBe(sub);
    expect(principalOfToken('opaque-token')).toBeUndefined();
    expect(principalOfToken('a.e30.c')).toBeUndefined();
    expect(principalOfToken('a.!!!.c')).toBeUndefined();
  });

  it('expectedPrincipal that matches the token starts cleanly, at assertReady and at the first use', async () => {
    const h = await createHarness();
    const sub = principalOfToken(h.tokens.creator) ?? '';
    const governance = h.anotherGovernance({ expectedPrincipal: sub });
    await expect(governance.assertReady()).resolves.toBeUndefined();
    await expect(governance.capabilities()).resolves.toMatchObject({ routesApprovals: true });
  });

  it('expectedPrincipal that does not match refuses with principal_mismatch, on every use, before /v1 is asked anything', async () => {
    const h = await createHarness();
    const governance = h.anotherGovernance({ expectedPrincipal: 'someone-else' });
    await expect(governance.assertReady()).rejects.toMatchObject({ code: 'principal_mismatch' });
    await expect(governance.capabilities()).rejects.toMatchObject({ code: 'principal_mismatch' });
    expect(h.seen('GET', '/v1/capabilities')).toHaveLength(0);
  });

  it('expectedPrincipal with a token that names no principal refuses with principal_unavailable', async () => {
    const h = await createHarness();
    const governance = h.anotherGovernance({
      expectedPrincipal: 'svc',
      getToken: () => 'opaque-token',
    });
    await expect(governance.assertReady()).rejects.toMatchObject({
      code: 'principal_unavailable',
      message: expect.stringContaining('no readable sub claim') as unknown,
    });
  });

  it('expectedPrincipal with a getToken that throws refuses with principal_unavailable, keeping the cause', async () => {
    const h = await createHarness();
    const governance = h.anotherGovernance({
      expectedPrincipal: 'svc',
      getToken: () => Promise.reject(new Error('vault down')),
    });
    const refusal: unknown = await governance.assertReady().catch((e: unknown) => e);
    expect(refusal).toMatchObject({ code: 'principal_unavailable' });
    expect((refusal as GovernanceError).cause).toMatchObject({ message: 'vault down' });
  });

  it('expectedPrincipal is compared with every token obtained: a later token with another sub fails the request it was fetched for', async () => {
    const h = await createHarness();
    let swapped = false;
    const governance = h.anotherGovernance({
      expectedPrincipal: principalOfToken(h.tokens.creator) ?? '',
      getToken: () => (swapped ? h.tokens.approver : h.tokens.creator),
    });
    await expect(governance.runFor('thread-a')).resolves.toEqual(expect.any(String));
    swapped = true;
    const before = h.seen('POST', '/v1/runs').length;
    await expect(governance.runFor('thread-b')).rejects.toMatchObject({
      code: 'principal_mismatch',
    });
    await expect(governance.api.listApprovals('approved')).rejects.toMatchObject({
      code: 'principal_mismatch',
    });
    expect(h.seen('POST', '/v1/runs')).toHaveLength(before);
  });

  it('a later token with no readable sub fails with principal_unavailable, and the message carries no token', async () => {
    const h = await createHarness();
    let opaque = false;
    const governance = h.anotherGovernance({
      expectedPrincipal: principalOfToken(h.tokens.creator) ?? '',
      getToken: () => (opaque ? 'opaque-token' : h.tokens.creator),
    });
    await governance.capabilities();
    opaque = true;
    const refusal: unknown = await governance.api.createRun('k').catch((e: unknown) => e);
    expect(refusal).toMatchObject({ code: 'principal_unavailable' });
    expect((refusal as GovernanceError).message).not.toContain('opaque-token');
  });

  it('without expectedPrincipal a changed sub does not throw', async () => {
    const h = await createHarness();
    let swapped = false;
    const governance = h.anotherGovernance({
      getToken: () => (swapped ? h.tokens.approver : h.tokens.creator),
    });
    await governance.capabilities();
    swapped = true;
    await expect(governance.runFor('thread-x')).resolves.toEqual(expect.any(String));
  });

  it('without expectedPrincipal an unreadable token is not a failure of its own', async () => {
    const h = await createHarness();
    const governance = h.anotherGovernance({ getToken: () => h.tokens.creator });
    await expect(governance.principal()).resolves.toEqual(expect.any(String));
  });
});
