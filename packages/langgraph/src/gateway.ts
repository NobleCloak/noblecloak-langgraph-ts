/**
 * Naming the run to the gateway. A tool declared gateway-executed (`executedBy: 'gateway'`) is run by the
 * adapter only when the deployment's decision admits it, and the wrapped function is the builder's call to
 * the governed MCP gateway. The gateway matches that call to the approval by the external run it names, so
 * the function needs the run id the adapter decided under.
 */
import { GovernanceError } from './errors.js';

/** The `configurable` key under which the adapter hands a gateway-executed tool's function its run id. */
export const EXTERNAL_RUN_ID_KEY = 'noblecloak_external_run_id';

/**
 * The selector the gateway reads: the header name is matched case-insensitively. This adapter sends only
 * the names below.
 */
export const EXTERNAL_RUN_ID_HEADER = 'X-NobleCloak-External-Run-Id';
export const EXTERNAL_RUN_ID_META = 'noblecloak/external-run-id';

export interface GatewayCallContext {
  readonly externalRunId: string;
  /** The HTTP form: send it as a header of the MCP request. */
  readonly header: { readonly 'X-NobleCloak-External-Run-Id': string };
  /** The JSON-RPC form: send it in the `_meta` of the `tools/call` params. */
  readonly meta: { readonly 'noblecloak/external-run-id': string };
}

/**
 * The run a gateway-executed tool's function must name, from the `config` LangChain hands it. Send either
 * `header` or `meta`, never both: the gateway refuses a call that carries both with different values, and
 * the adapter sends neither itself. Throws `run_required` when `config` carries no run: the function was
 * not called by a tool declared gateway-executed.
 */
export function gatewayCallContext(config: unknown): GatewayCallContext {
  const configurable =
    typeof config === 'object' && config !== null && 'configurable' in config
      ? (config as { configurable?: unknown }).configurable
      : undefined;
  const id =
    typeof configurable === 'object' && configurable !== null
      ? (configurable as Record<string, unknown>)[EXTERNAL_RUN_ID_KEY]
      : undefined;
  if (typeof id !== 'string' || id === '') {
    throw new GovernanceError(
      'run_required',
      'gatewayCallContext was called outside a tool declared gateway-executed: the config carries no external run.'
    );
  }
  return {
    externalRunId: id,
    header: { [EXTERNAL_RUN_ID_HEADER]: id },
    meta: { [EXTERNAL_RUN_ID_META]: id },
  };
}
