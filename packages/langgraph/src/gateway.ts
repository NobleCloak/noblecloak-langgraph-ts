/**
 * Naming the run to the gateway. A tool declared gateway-executed (`executedBy: 'gateway'`) is run by the
 * adapter only when the deployment's decision admits it, and the wrapped function is the builder's call to
 * the governed MCP gateway. The gateway matches that call to the approval by the external run it names, so
 * the function needs the run id the adapter decided under.
 */
import { GovernanceError } from './errors.js';

/**
 * The `configurable` key under which the adapter hands a gateway-executed tool's function its run. What
 * sits under it is a hand-off this module made (`handOffRun`), never the run id itself. The key is removed
 * from every `configurable` the adapter invokes a tool with, so a run id an invoker placed there is not
 * read, and `gatewayCallContext` accepts nothing but a hand-off.
 */
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

/** The hand-offs this process made, by identity: an object of the same shape from anywhere else is not one. */
const handedOff = new WeakSet();

/**
 * The value the adapter puts under `EXTERNAL_RUN_ID_KEY`: an object whose identity, not its shape, is what
 * `gatewayCallContext` accepts. LangChain copies `configurable` shallowly on the way to the tool, so the
 * function receives the very object made here.
 * @internal
 */
export function handOffRun(runId: string): object {
  const mark = Object.freeze({ run_id: runId });
  handedOff.add(mark);
  return mark;
}

/** The run a value under `EXTERNAL_RUN_ID_KEY` names, when it is a hand-off this process made. @internal */
export function handedOffRun(value: unknown): string | undefined {
  return typeof value === 'object' && value !== null && handedOff.has(value)
    ? (value as { readonly run_id: string }).run_id
    : undefined;
}

/**
 * The `configurable` a governed tool's function is invoked with: the invoker's, without whatever it placed
 * under `EXTERNAL_RUN_ID_KEY`, plus this adapter's hand-off of `runId` when there is one.
 * @internal
 */
export function configurableFor(
  configurable: Record<string, unknown> | undefined,
  runId: string | undefined
): Record<string, unknown> {
  const rest = Object.fromEntries(
    Object.entries(configurable ?? {}).filter(([key]) => key !== EXTERNAL_RUN_ID_KEY)
  );
  return runId === undefined ? rest : { ...rest, [EXTERNAL_RUN_ID_KEY]: handOffRun(runId) };
}

/**
 * The run a gateway-executed tool's function must name, from the `config` LangChain hands it. Send either
 * `header` or `meta`, never both: the gateway refuses a call that carries both with different values, and
 * the adapter sends neither itself. Throws `run_required` when `config` carries no run this adapter handed
 * off: the function was not called by a tool declared gateway-executed. A run id placed in `configurable`
 * by whoever invoked the graph is not one.
 */
export function gatewayCallContext(config: unknown): GatewayCallContext {
  const configurable =
    typeof config === 'object' && config !== null && 'configurable' in config
      ? (config as { configurable?: unknown }).configurable
      : undefined;
  const id = handedOffRun(
    typeof configurable === 'object' && configurable !== null
      ? (configurable as Record<string, unknown>)[EXTERNAL_RUN_ID_KEY]
      : undefined
  );
  if (id === undefined || id === '') {
    throw new GovernanceError(
      'run_required',
      'gatewayCallContext was called outside a tool declared gateway-executed: the config carries no run this adapter handed off.'
    );
  }
  return {
    externalRunId: id,
    header: { [EXTERNAL_RUN_ID_HEADER]: id },
    meta: { [EXTERNAL_RUN_ID_META]: id },
  };
}
