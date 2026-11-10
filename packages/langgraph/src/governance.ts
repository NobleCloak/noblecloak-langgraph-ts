/** The shared state of one adapter: the `/v1` client, the capabilities, the runs and the key set. */
import { ResumptionError, sha256Hex, verifyResumption } from '@noblecloak/client';
import type {
  ExpectedAction,
  Jwks,
  ModuleApiClient,
  ResumptionPayload,
  ResumptionReplayGuard,
  VerifyOptions,
} from '@noblecloak/client';

import { GovernanceApi } from './api.js';
import type { Capabilities } from './api.js';
import { Coordination } from './coordination.js';
import { GovernanceError, messageOf } from './errors.js';
import { ForgettingReplayGuard } from './replay.js';

export type WhenUnroutable = 'deny' | 'ask-locally';
export type OnRejected = 'tell-model' | 'halt';
export type OnRecordFailure = 'tell-model' | 'throw';
export type InvocationChannel = 'interactive' | 'headless' | 'workflow';

export interface GovernanceOptions {
  /** The origin of the module API, for example `https://govern.example.com`. */
  readonly baseUrl: string;
  /** Returns the service principal's access token. Called for every request. */
  readonly getToken: () => string | Promise<string>;
  /** A fetch implementation. Defaults to the global one. */
  readonly fetch?: typeof globalThis.fetch;
  /** A client to use instead of one built from `baseUrl`, `getToken` and `fetch`. */
  readonly client?: ModuleApiClient;
  /** The key set that verifies Resumptions, or a function that returns it. Default: `/.well-known/jwks.json`. */
  readonly jwks?: Jwks | (() => Jwks | Promise<Jwks>);
  /** Remembers the Resumptions already acted on. Default: an in-memory guard. */
  readonly replayGuard?: ResumptionReplayGuard;
  /** What a call that needs approval does when the deployment cannot route one. Default `'deny'`. */
  readonly whenUnroutable?: WhenUnroutable;
  /** What a rejection does: tell the model and continue, or end the run. Default `'tell-model'`. */
  readonly onRejected?: OnRejected;
  /** The invocation channel recorded on decisions and records. Default `'headless'`. */
  readonly invocationChannel?: InvocationChannel;
  /**
   * What a call does when its outcome record still cannot be written after the retries (the tool ran, the
   * approval, if any, is consumed). `'tell-model'` (default) returns a fixed tool message that says so and
   * withholds the tool's result, so the model neither reads a fix-your-mistakes error nor repeats a call that
   * already ran. `'throw'` throws the typed `record_failed`; that fails the run only when the tool node does not
   * turn tool errors into messages (`handleToolErrors: false`). Either way the failure goes to `onError`, once.
   */
  readonly onRecordFailure?: OnRecordFailure;
  /**
   * How an outcome record that cannot be written is retried before `onRecordFailure` applies.
   * Every attempt carries the same Idempotency-Key. Defaults: 4 attempts, waiting 500 ms and doubling
   * (about 3.5 s in all), never more than `maxBackoffMs` between two attempts.
   */
  readonly recordRetry?: RecordRetry;
  /** Called for a failure that is reported rather than thrown (a failed record, one approval of many). */
  readonly onError?: (error: GovernanceError) => void;
  /**
   * The id of the principal this process must run as. When set, the `sub` of the access token is compared
   * with it at start-up (`assertReady()`, or the first governed call), at the start of every governed call,
   * and on every token the adapter obtains from `getToken` before it is sent. A different `sub` fails the
   * call it was fetched for with `principal_mismatch`; a token whose `sub` cannot be read fails it with
   * `principal_unavailable`. A token the adapter's `client` option obtains for itself is not seen. Nothing
   * but the `sub` is read or reported. When unset, nothing is compared. Set the same value on the agent and on
   * the worker (`runResumer` takes it from its `governance`, where a mismatch stops the worker): a worker run
   * as another principal than the agent sees none of the agent's approvals and resumes nothing.
   */
  readonly expectedPrincipal?: string;
  /**
   * Called when a governed call opens a new approval (not when it finds one already open), with the
   * principal the approval was opened as. Compare it with the one the worker reports through `onReady`.
   * Without it, the first approval a process opens is logged once with `console.info`.
   */
  readonly onApprovalOpened?: (opened: ApprovalOpened) => void;
}

/** What `onApprovalOpened` is called with. */
export interface ApprovalOpened {
  readonly approvalId: string;
  readonly toolRef: string;
  /** The principal the access token names (its `sub` claim), or undefined when it cannot be read. */
  readonly principal: string | undefined;
}

/**
 * The principal an access token names: the `sub` claim of a JWT. The module API (contract v1) has no
 * route that echoes the caller's identity, so this is read from the token the caller sends. Undefined for
 * a token that is not a JWT with a non-empty string `sub`.
 */
export function principalOfToken(token: string): string | undefined {
  const segment = token.split('.')[1];
  if (segment === undefined) return undefined;
  try {
    const payload: unknown = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(segment.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
      )
    );
    const sub =
      typeof payload === 'object' && payload !== null
        ? (payload as Record<string, unknown>).sub
        : undefined;
    return typeof sub === 'string' && sub !== '' ? sub : undefined;
  } catch {
    return undefined;
  }
}

/** Returns `actual` when it is `expected`; otherwise throws `principal_unavailable` or `principal_mismatch`. */
function comparePrincipal(actual: string | undefined, expected: string): string {
  if (actual === undefined) {
    throw new GovernanceError(
      'principal_unavailable',
      `expectedPrincipal is ${JSON.stringify(expected)}, but the access token carries no readable sub claim, so the principal this process runs as cannot be checked.`
    );
  }
  if (actual !== expected) {
    throw new GovernanceError(
      'principal_mismatch',
      `This process runs as principal ${JSON.stringify(actual)}, not ${JSON.stringify(expected)}. A worker run as another principal than the agent sees none of the agent's approvals.`
    );
  }
  return actual;
}

export interface RecordRetry {
  /** Attempts in all, the first included. At least 1. Default 4. */
  readonly attempts?: number;
  /** The wait before the second attempt, doubling after. Default 500. */
  readonly backoffMs?: number;
  /** The longest wait between two attempts. Default 5000. */
  readonly maxBackoffMs?: number;
}

/** What `GET /v1/capabilities` means to the adapter. */
export interface ServerCapabilities {
  /** The deployment routes approvals: it reports at least one resolution. */
  readonly routesApprovals: boolean;
  /** The deployment serves `POST /v1/runs`. */
  readonly servesRuns: boolean;
  readonly raw: Capabilities;
}

const coordinations = new WeakMap<Governance, Coordination>();

/**
 * The coordination state of a `Governance` (internal: used by this package's modules, not exported from the
 * entry point, so the published type surface of `Governance` is the documented API only).
 */
export const coordinationOf = (governance: Governance): Coordination => {
  const found = coordinations.get(governance);
  if (found === undefined) throw new Error('not a Governance created by createGovernance');
  return found;
};

export class Governance {
  readonly api: GovernanceApi;
  readonly whenUnroutable: WhenUnroutable;
  readonly onRejected: OnRejected;
  readonly onRecordFailure: OnRecordFailure;
  readonly invocationChannel: InvocationChannel;
  readonly replayGuard: ResumptionReplayGuard;
  readonly recordRetry: Required<RecordRetry>;
  readonly #onError: ((error: GovernanceError) => void) | undefined;
  readonly #getToken: GovernanceOptions['getToken'];
  readonly #expectedPrincipal: string | undefined;
  readonly #onApprovalOpened: GovernanceOptions['onApprovalOpened'];
  #openedLogged = false;
  readonly #jwksSource: GovernanceOptions['jwks'];
  readonly #toolRefs = new Map<string, string>();
  readonly #runs = new Map<string, Promise<string>>();
  #capabilities: ServerCapabilities | undefined;
  #capabilitiesRead: Promise<ServerCapabilities> | undefined;
  #jwks: Jwks | undefined;

  constructor(options: GovernanceOptions) {
    const expected = options.expectedPrincipal;
    // Every token the adapter sends passes through here, so no call site can skip the comparison.
    const checkedGetToken =
      expected === undefined
        ? options.getToken
        : async (): Promise<string> => {
            const token = await options.getToken();
            comparePrincipal(principalOfToken(token), expected);
            return token;
          };
    this.api = new GovernanceApi({
      baseUrl: options.baseUrl,
      getToken: checkedGetToken,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.client === undefined ? {} : { client: options.client }),
    });
    this.whenUnroutable = options.whenUnroutable ?? 'deny';
    this.onRejected = options.onRejected ?? 'tell-model';
    const onRecordFailure = options.onRecordFailure ?? 'tell-model';
    // A JavaScript caller can pass anything: refuse it now, not when a record first fails.
    if (!['tell-model', 'throw'].includes(onRecordFailure)) {
      throw new Error("onRecordFailure must be 'tell-model' or 'throw'");
    }
    this.onRecordFailure = onRecordFailure;
    this.invocationChannel = options.invocationChannel ?? 'headless';
    this.replayGuard = options.replayGuard ?? new ForgettingReplayGuard();
    this.recordRetry = {
      attempts: Math.max(1, Math.trunc(options.recordRetry?.attempts ?? 4)),
      backoffMs: Math.max(0, options.recordRetry?.backoffMs ?? 500),
      maxBackoffMs: Math.max(0, options.recordRetry?.maxBackoffMs ?? 5000),
    };
    this.#onError = options.onError;
    this.#getToken = options.getToken;
    this.#expectedPrincipal = options.expectedPrincipal;
    this.#onApprovalOpened = options.onApprovalOpened;
    coordinations.set(this, new Coordination());
    this.#jwksSource = options.jwks;
  }

  /**
   * Reports a failure that is not thrown (a failed record, one approval of many). It goes to `onError`;
   * without one it goes to `console.error`, so a missing record or a failed resume is never silent. A
   * throwing callback never breaks the caller.
   */
  report(error: GovernanceError, approvalId?: string): void {
    try {
      if (this.#onError !== undefined) {
        this.#onError(error);
        return;
      }
      const cause = error.cause === undefined ? '' : ` (cause: ${messageOf(error.cause)})`;
      const about = approvalId === undefined ? '' : ` [approval ${approvalId}]`;
      // The default sink: the builder gave no onError.
      console.error(`[@noblecloak/langgraph] ${error.code}${about}: ${error.message}${cause}`);
    } catch {
      // The sink is the builder's; a failure in it is not ours to propagate.
    }
  }

  /** Names the catalog tool a LangChain tool name stands for. */
  registerTool(name: string, toolRef: string): void {
    const known = this.#toolRefs.get(name);
    if (known !== undefined && known !== toolRef) {
      throw new Error(`tool ${name} is already governed as ${known}, not ${toolRef}`);
    }
    this.#toolRefs.set(name, toolRef);
  }

  toolRefFor(name: string): string | undefined {
    return this.#toolRefs.get(name);
  }

  /**
   * Reads `GET /v1/capabilities` once and keeps the answer. A failed read is not kept: it throws
   * `unreachable`, and the next call reads again. Throws `runs_required` whenever the deployment
   * routes approvals but does not serve runs, and `continuation_kind_unsupported` whenever it routes
   * approvals and its `continuation_kinds` list, when it advertises one, lacks `langgraph`.
   */
  async capabilities(): Promise<ServerCapabilities> {
    if (this.#expectedPrincipal !== undefined) await this.assertPrincipal(this.#expectedPrincipal);
    this.#capabilities ??= await this.#readCapabilities();
    if (this.#capabilities.routesApprovals && !this.#capabilities.servesRuns) {
      throw new GovernanceError(
        'runs_required',
        'This deployment routes approvals but does not serve /v1/runs. Without a run per thread, an approval granted in one thread could satisfy an identical call in another, so the adapter will not start.'
      );
    }
    const kinds: unknown = this.#capabilities.raw.continuation_kinds;
    // A member that is not an array is not an advertised list (as for `resolutions` and `features`).
    if (
      this.#capabilities.routesApprovals &&
      Array.isArray(kinds) &&
      !kinds.includes('langgraph')
    ) {
      throw new GovernanceError(
        'continuation_kind_unsupported',
        `This deployment routes approvals but ${kinds.length === 0 ? 'advertises an empty list of continuation kinds' : `lists the continuation kinds it accepts (${kinds.join(', ')}) without langgraph`}. An approval opened here could never resume, so the adapter will not start.`
      );
    }
    return this.#capabilities;
  }

  /**
   * The principal the access token names, or undefined when the token does not carry a readable `sub`.
   * A failing `getToken` throws `principal_unavailable`.
   */
  async principal(): Promise<string | undefined> {
    try {
      return principalOfToken(await this.#getToken());
    } catch (error) {
      throw new GovernanceError(
        'principal_unavailable',
        `The access token could not be obtained to learn which principal this process runs as: ${messageOf(error)}`,
        { cause: error }
      );
    }
  }

  /**
   * Compares `expected` with the principal of the access token and returns the principal. A principal
   * that cannot be learned throws `principal_unavailable`; a different one throws `principal_mismatch`.
   */
  async assertPrincipal(expected: string): Promise<string> {
    return comparePrincipal(await this.principal(), expected);
  }

  /**
   * Reports that a governed call opened a new approval, and as which principal. Never throws: the
   * callback is the builder's, and the principal is read for the report only.
   */
  async approvalOpened(approvalId: string, toolRef: string): Promise<void> {
    let principal: string | undefined;
    try {
      principal = await this.principal();
    } catch {
      principal = undefined;
    }
    try {
      if (this.#onApprovalOpened !== undefined) {
        this.#onApprovalOpened({ approvalId, toolRef, principal });
      } else if (!this.#openedLogged) {
        this.#openedLogged = true;
        // The default sink: the builder gave no onApprovalOpened.
        console.info(
          `[@noblecloak/langgraph] opened approval ${approvalId} for ${toolRef} as principal ${principal ?? '(unknown)'}; the resumer must run as the same principal.`
        );
      }
    } catch {
      // The sink is the builder's; a failure in it is not ours to propagate.
    }
  }

  #readCapabilities(): Promise<ServerCapabilities> {
    this.#capabilitiesRead ??= (async () => {
      try {
        const answer = await this.api.capabilities();
        if (!answer.ok) {
          throw new GovernanceError(
            'api_error',
            `GET /v1/capabilities answered ${String(answer.problem.status)} ${answer.problem.code}`
          );
        }
        const raw = answer.data;
        return {
          routesApprovals: Array.isArray(raw.resolutions) && raw.resolutions.length > 0,
          servesRuns: Array.isArray(raw.features) && raw.features.includes('runs'),
          raw,
        };
      } finally {
        this.#capabilitiesRead = undefined;
      }
    })();
    return this.#capabilitiesRead;
  }

  /** Fails now, rather than on the first tool call, when the deployment cannot be used. */
  async assertReady(): Promise<void> {
    await this.capabilities();
  }

  /** The run id for a thread: one `POST /v1/runs` per thread, idempotent by a key derived from the thread id. */
  runFor(threadId: string): Promise<string> {
    let run = this.#runs.get(threadId);
    if (run === undefined) {
      run = (async () => {
        const key = `nc-langgraph-run-${await sha256Hex(threadId)}`;
        const answer = await this.api.createRun(key);
        if (!answer.ok) {
          throw new GovernanceError(
            'api_error',
            `POST /v1/runs answered ${String(answer.problem.status)} ${answer.problem.code}`
          );
        }
        return answer.data.id;
      })();
      this.#runs.set(threadId, run);
      // A failed attempt is not kept: the next call asks again.
      run.catch(() => {
        if (this.#runs.get(threadId) === run) this.#runs.delete(threadId);
      });
    }
    return run;
  }

  async #keys(refresh: boolean): Promise<Jwks> {
    const source = this.#jwksSource;
    if (source !== undefined && typeof source !== 'function') return source;
    if (this.#jwks === undefined || refresh) {
      this.#jwks = await (source === undefined ? this.api.jwks() : source());
    }
    return this.#jwks;
  }

  /**
   * Verifies a Resumption against the key set; a `kid` the cached set does not hold is looked up once
   * more in a fresh set (key rotation) before it is refused.
   */
  async verify(
    jws: string,
    expected: ExpectedAction,
    options: VerifyOptions
  ): Promise<ResumptionPayload> {
    const keys = await this.#keys(false);
    try {
      return await verifyResumption(jws, keys, expected, options);
    } catch (error) {
      const refreshable = this.#jwksSource === undefined || typeof this.#jwksSource === 'function';
      if (!(error instanceof ResumptionError && error.code === 'unknown_kid' && refreshable))
        throw error;
      return verifyResumption(jws, await this.#keys(true), expected, options);
    }
  }
}

/** Builds the adapter's shared state. Nothing is read from `/v1` until the first governed call. */
export function createGovernance(options: GovernanceOptions): Governance {
  return new Governance(options);
}
