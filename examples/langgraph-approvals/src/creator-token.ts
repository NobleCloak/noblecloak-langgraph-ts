/**
 * Where the agent and the worker get the creator's access token. `NC_TOKEN` (a pasted token) wins when
 * set, and is returned as is, never renewed. Otherwise `NOBLECLOAK_SP_CREDENTIALS` (a path or inline
 * JSON) names a service-principal credential and the token is minted from its key, then renewed shortly
 * before it expires.
 */
import {
  loadServicePrincipalCredential,
  servicePrincipalTokenSource,
} from '@noblecloak/client/service-principal';

export interface CreatorTokenOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof globalThis.fetch;
}

/** The `getToken` for the creator; throws, naming both variables, when neither is set. */
export async function creatorGetToken(
  options: CreatorTokenOptions = {}
): Promise<() => string | Promise<string>> {
  const env = options.env ?? process.env;
  const pasted = env.NC_TOKEN;
  if (pasted !== undefined && pasted !== '') return () => pasted;

  const credential = env.NOBLECLOAK_SP_CREDENTIALS;
  if (credential === undefined || credential === '') {
    throw new Error(
      'Set NOBLECLOAK_SP_CREDENTIALS (a service-principal credential) or NC_TOKEN (an access token)'
    );
  }
  const baseUrl = env.NC_BASE_URL;
  if (baseUrl === undefined || baseUrl === '') throw new Error('NC_BASE_URL is not set');
  const source = servicePrincipalTokenSource(
    await loadServicePrincipalCredential(credential, { env }),
    {
      audience: env.NC_AUDIENCE ?? new URL(baseUrl).origin,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }
  );
  return source.getToken;
}
