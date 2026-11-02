/**
 * The adapter's view of `/v1`: one method per operation it calls, each returning the unwrapped `data`
 * or a {@link Problem}. A network failure, a 5xx or an unreadable body throws `unreachable`; the
 * callers decide what a 4xx means.
 */
import { createClient } from '@noblecloak/client';
import type { Jwks, ModuleApiClient, components } from '@noblecloak/client';

import { GovernanceError, isPrincipalFailure, messageOf } from './errors.js';

type Schemas = components['schemas'];

export type Capabilities = Schemas['Capabilities'];
export type DecisionRequest = Schemas['DecisionRequest'];
export type Decision = Schemas['Decision'];
export type Approval = Schemas['Approval'];
export type Resumption = Schemas['Resumption'];
export type RecordCreate = Schemas['RecordCreate'];
export type ContinuationBody = Schemas['Continuation'];

/** A 4xx answer: the status and the problem type's code (the last segment of its `type` URI). */
export interface Problem {
  readonly status: number;
  readonly code: string;
  readonly detail?: string;
}

export type Answer<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly problem: Problem };

export interface ApiOptions {
  readonly baseUrl: string;
  readonly getToken: () => string | Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
  /** A client to use instead of building one from `baseUrl`, `getToken` and `fetch`. */
  readonly client?: ModuleApiClient;
}

interface Raw {
  readonly data?: unknown;
  readonly error?: unknown;
  readonly response: Response;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function problemOf(status: number, error: unknown): Problem {
  const type = isObject(error) && typeof error.type === 'string' ? error.type : '';
  const detail = isObject(error) && typeof error.detail === 'string' ? error.detail : undefined;
  return {
    status,
    code: type.slice(type.lastIndexOf('/') + 1),
    ...(detail === undefined ? {} : { detail }),
  };
}

/** Everything the adapter asks of `/v1`. */
export class GovernanceApi {
  readonly #client: ModuleApiClient;
  readonly baseUrl: string;

  constructor(options: ApiOptions) {
    this.baseUrl = options.baseUrl;
    this.#client =
      options.client ??
      createClient({
        baseUrl: options.baseUrl,
        getToken: options.getToken,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
  }

  async #call<T>(
    operation: () => Promise<Raw>,
    unwrap: (data: unknown, envelope: Record<string, unknown>) => T
  ): Promise<Answer<T>> {
    let raw: Raw;
    try {
      raw = await operation();
    } catch (error) {
      if (isPrincipalFailure(error)) throw error;
      throw new GovernanceError('unreachable', `/v1 could not be reached: ${messageOf(error)}`, {
        cause: error,
      });
    }
    const status = raw.response.status;
    if (status >= 500) throw new GovernanceError('unreachable', `/v1 answered ${String(status)}`);
    if (!raw.response.ok) return { ok: false, problem: problemOf(status, raw.error) };
    const envelope = raw.data;
    if (!isObject(envelope) || !('data' in envelope)) {
      throw new GovernanceError(
        'unreachable',
        `/v1 answered ${String(status)} without a data member`
      );
    }
    return { ok: true, data: unwrap(envelope.data, envelope) };
  }

  capabilities(): Promise<Answer<Capabilities>> {
    return this.#call(
      () => this.#client.GET('/v1/capabilities'),
      (data) => data as Capabilities
    );
  }

  async jwks(): Promise<Jwks> {
    let response: Response;
    try {
      const raw = await this.#client.GET('/.well-known/jwks.json', { parseAs: 'json' });
      response = raw.response;
      if (response.ok && isObject(raw.data) && Array.isArray(raw.data.keys)) return raw.data;
    } catch (error) {
      if (isPrincipalFailure(error)) throw error;
      throw new GovernanceError(
        'unreachable',
        `the key set could not be read: ${messageOf(error)}`,
        {
          cause: error,
        }
      );
    }
    throw new GovernanceError('unreachable', `the key set answered ${String(response.status)}`);
  }

  createRun(idempotencyKey: string): Promise<Answer<Schemas['Run']>> {
    return this.#call(
      () =>
        this.#client.POST('/v1/runs', {
          body: { kind: 'external' },
          params: { header: { 'Idempotency-Key': idempotencyKey } },
        }),
      (data) => data as Schemas['Run']
    );
  }

  decide(body: DecisionRequest): Promise<Answer<Decision>> {
    return this.#call(
      () => this.#client.POST('/v1/decisions', { body }),
      (data) => data as Decision
    );
  }

  getApproval(id: string): Promise<Answer<Approval>> {
    return this.#call(
      () => this.#client.GET('/v1/approvals/{id}', { params: { path: { id } } }),
      (data) => data as Approval
    );
  }

  waitApproval(
    id: string,
    timeoutSeconds: number,
    signal?: AbortSignal
  ): Promise<Answer<Approval>> {
    return this.#call(
      () =>
        this.#client.GET('/v1/approvals/{id}/wait', {
          params: { path: { id }, query: { timeout: timeoutSeconds } },
          ...(signal === undefined ? {} : { signal }),
        }),
      (data) => data as Approval
    );
  }

  getResumption(id: string): Promise<Answer<Resumption>> {
    return this.#call(
      () => this.#client.GET('/v1/approvals/{id}/resumption', { params: { path: { id } } }),
      (data) => data as Resumption
    );
  }

  consume(
    id: string,
    resumeToken: string,
    toolRef: string,
    args: Record<string, unknown>
  ): Promise<Answer<Schemas['ConsumeResult']>> {
    return this.#call(
      () =>
        this.#client.POST('/v1/approvals/{id}/consume', {
          params: { path: { id } },
          body: { resume_token: resumeToken, action: { tool_ref: toolRef, arguments: args } },
        }),
      (data) => data as Schemas['ConsumeResult']
    );
  }

  withdraw(id: string): Promise<Answer<Approval>> {
    return this.#call(
      () => this.#client.POST('/v1/approvals/{id}/withdraw', { params: { path: { id } } }),
      (data) => data as Approval
    );
  }

  appendRecord(body: RecordCreate, idempotencyKey: string): Promise<Answer<Schemas['Record']>> {
    return this.#call(
      () =>
        this.#client.POST('/v1/records', {
          body,
          params: { header: { 'Idempotency-Key': idempotencyKey } },
        }),
      (data) => data as Schemas['Record']
    );
  }

  /**
   * One page of the approvals in `state` that this principal created, newest first (`created_by=me`: a
   * worker may run under a user token, which sees its organisation's approvals, so it always asks).
   */
  listApprovals(
    state: Schemas['ApprovalState'],
    cursor?: string
  ): Promise<Answer<{ readonly rows: Approval[]; readonly next: string | null }>> {
    return this.#call(
      () =>
        this.#client.GET('/v1/approvals', {
          params: {
            query: { state, created_by: 'me', ...(cursor === undefined ? {} : { cursor }) },
          },
        }),
      (data, envelope) => {
        // A page that is not a list, or a cursor that is neither a string nor null, is an unreadable
        // answer, not an empty one: reading it as "no approvals" would leave answered approvals alone.
        if (!Array.isArray(data)) {
          throw new GovernanceError(
            'unreachable',
            '/v1 answered an approvals page whose data is not an array'
          );
        }
        const meta = isObject(envelope.meta) ? envelope.meta : {};
        const next: unknown = meta.next ?? null;
        if (next !== null && typeof next !== 'string') {
          throw new GovernanceError(
            'unreachable',
            '/v1 answered an approvals page whose meta.next is not a string or null'
          );
        }
        return { rows: data as Approval[], next };
      }
    );
  }

  /** The `approval.updated` events of the approvals this principal created (`created_by=me`); resolves to the response body. */
  async stream(signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    let raw: { data?: unknown; response: Response };
    try {
      raw = await this.#client.GET('/v1/approvals/stream', {
        params: { query: { created_by: 'me' } },
        parseAs: 'stream',
        signal,
      });
    } catch (error) {
      if (isPrincipalFailure(error)) throw error;
      throw new GovernanceError(
        'unreachable',
        `the approval stream could not be opened: ${messageOf(error)}`,
        {
          cause: error,
        }
      );
    }
    if (!raw.response.ok || !(raw.data instanceof ReadableStream)) {
      throw new GovernanceError(
        'unreachable',
        `the approval stream answered ${String(raw.response.status)}`
      );
    }
    return raw.data as ReadableStream<Uint8Array>;
  }
}
