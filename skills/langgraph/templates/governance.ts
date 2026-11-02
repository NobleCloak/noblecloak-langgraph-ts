/**
 * The agent's governance, authenticated as the agent's own service principal. The agent process and the
 * resumer worker both call `agentGovernance()`: only the principal that opened an approval can read its
 * Resumption, so the worker must be the same service principal as the agent.
 *
 * `NOBLECLOAK_SP_CREDENTIALS` (a path to the credential file, or inline JSON) names the service principal;
 * `NC_EXPECTED_PRINCIPAL` is that service principal's id (the `id` the deployment's principal list shows, not
 * the credential's `client_id`): the adapter compares it with the `sub` of every token and stops with
 * `principal_mismatch` when they differ, which is how a worker started with another credential than the agent's
 * is caught (without it, that worker would start cleanly and resume nothing). `NC_BASE_URL` is the module
 * API's origin; `NC_AUDIENCE` overrides the token's audience (default: that origin). A pasted user token is deliberately not read here: the agent's policies apply through the service
 * principal bound to it, so an agent running as a person would be governed as that person.
 */
import { createGovernance } from '@noblecloak/langgraph';
import type { Governance } from '@noblecloak/langgraph';
import {
  loadServicePrincipalCredential,
  servicePrincipalTokenSource,
} from '@noblecloak/client/service-principal';

export interface AgentGovernanceOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof globalThis.fetch;
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}

/** Governance for the agent; throws, naming the variable, when `NC_BASE_URL`, the credential or the principal id is not set. */
export async function agentGovernance(options: AgentGovernanceOptions = {}): Promise<Governance> {
  const env = options.env ?? process.env;
  const baseUrl = required(env, 'NC_BASE_URL');
  const credential = required(env, 'NOBLECLOAK_SP_CREDENTIALS');
  const expectedPrincipal = required(env, 'NC_EXPECTED_PRINCIPAL');
  const source = servicePrincipalTokenSource(
    await loadServicePrincipalCredential(credential, { env }),
    {
      audience: env.NC_AUDIENCE ?? new URL(baseUrl).origin,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }
  );
  return createGovernance({ baseUrl, getToken: source.getToken, expectedPrincipal });
}
