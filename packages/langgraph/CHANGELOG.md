# @noblecloak/langgraph

## 0.4.0

### Minor Changes

- cdf56e7: Breaking: an `allow` decision that carries an approval handle is refused `not_locally_executable` for a tool not declared gateway-executed. Such a decision is the gateway admitting the call by an approval it holds, which nothing in the adapter consumes; running a local function on it let any process that re-decided the call run the action again until the approval expired. A declared tool (`gatewayTools` / `executedBy: 'gateway'`) runs as before, and a worker graph must now carry the same declaration as the agent's; the approval this call's own decision opened is withdrawn, as for a `step_up` the deployment executes.

  `gatewayCallContext` reads only a run the adapter handed off. The adapter removes `noblecloak_external_run_id` from every `configurable` it invokes a tool with (both the tool-node and the middleware paths) and sets it only for a declared gateway tool, from the run it decided under, as an object it alone can mint; a run id placed in `configurable` by whoever invoked the graph is never named to the gateway. A function reading the key directly instead of calling `gatewayCallContext` now sees that object, not a string.

## 0.3.9

### Patch Changes

- 8eb7ffe: A denial's code is set on the `ToolMessage` after it is built instead of passed to the constructor, which
  `@langchain/core` 1.2.19 deprecates. The code stays in `additional_kwargs.noblecloak`, so `denialCodeOf` and
  messages already checkpointed read it as before.

## 0.3.8

### Patch Changes

- 9c2713c: Docs only: the README names the contract revisions an agent's policies and the policy-set proposal need, and points to the setup skill that opens the proposal.

## 0.3.7

### Patch Changes

- Updated dependencies [40c58bd]
  - @noblecloak/client@0.10.0

## 0.3.6

### Patch Changes

- Updated dependencies [d427655]
  - @noblecloak/client@0.9.0

## 0.3.5

### Patch Changes

- Updated dependencies [ed41848]
  - @noblecloak/client@0.8.0

## 0.3.4

### Patch Changes

- Updated dependencies [8d2f70d]
- Updated dependencies [cadb241]
- Updated dependencies [8b78e53]
- Updated dependencies [ea5f3f7]
- Updated dependencies [52347dd]
  - @noblecloak/client@0.7.0

## 0.3.3

### Patch Changes

- Updated dependencies [5545f4b]
  - @noblecloak/client@0.6.0

## 0.3.2

### Patch Changes

- Updated dependencies [e2bee5b]
  - @noblecloak/client@0.5.0

## 0.3.1

### Patch Changes

- Updated dependencies [1e76f7e]
  - @noblecloak/client@0.4.0

## 0.3.0

### Minor Changes

- f6d71fa: Breaking: `gatewayCallContext` names the external run with NobleCloak names. The `header` key is now `X-NobleCloak-External-Run-Id` and the `meta` key is now `noblecloak/external-run-id` (the earlier names are no longer read); `EXTERNAL_RUN_ID_HEADER` and `EXTERNAL_RUN_ID_META` carry the new values. The returned object's literal-typed keys changed, so code that reads the earlier keys no longer type-checks, and a gateway that reads only the old names no longer sees the run. Spread `header` or `meta` into the request as before, or read the key through the exported constants.

## 0.2.1

### Patch Changes

- Updated dependencies [e122c89]
  - @noblecloak/client@0.3.0

## 0.2.0

### Minor Changes

- 9f00e8d: Tools the gateway executes. `governedToolNode({ gatewayTools })`, `governanceMiddleware(governance, { toolRefs, gatewayTools })` and `governed(tool, { executedBy: 'gateway' })` declare that the deployment executes a tool through the governed MCP gateway and that the wrapped function is the gateway call. A declared tool needs an external run (`run_required` before any decision), pauses on a `step_up` with no `resume_token` to issue instead of being refused `not_locally_executable`, and runs once on the re-run when the re-decision answers `allow` with the approval handle (the gateway records its own call). `gatewayCallContext(config)` returns the run as the gateway's run header and `_meta` forms (renamed in 0.3.0). Undeclared tools behave as before.
- e03132f: `governanceMiddleware(governance, { toolRefs, handleToolErrors? })`, imported from `@noblecloak/langgraph/middleware`: approvals for a `createAgent` agent as one middleware. It is a `wrapToolCall` hook that ends in the same function as `governed` and `governedToolNode`, so a call is decided, paused, verified, consumed, run and recorded the same way through all three. `langchain` (`^1.5.15`) is an optional peer dependency, needed only by `@noblecloak/langgraph/middleware`; the main entry never loads it. 1.5.15 is the version tested; 1.5.16 and later need `@langchain/core` 1.2.17 or later. Under `createAgent`'s default tool behaviour each tool call of a message is its own task and pauses on its own approval; with `version: 'v1'` the calls of a message share one task and are coordinated as with a `ToolNode`. A tool the agent has that `toolRefs` does not name fails the run, and is never run ungoverned. The README quickstart is now the middleware form.

### Patch Changes

- Updated dependencies [5234ad3]
- Updated dependencies [a9ce285]
  - @noblecloak/client@0.2.0

## 0.1.0

### Minor Changes

- 553f1f9: Approvals for LangGraph JS. `createGovernance`, `governed` and `governedToolNode` decide each tool call, pause the graph for an approval (the continuation is `{ thread_id, checkpoint_ns, tool_call_id }`), consume before the tool runs and append the outcome record. `resumeApproval`, `waitAndResume` and `runResumer` verify the signed Resumption against the checkpointed call and resume the thread, from another process if need be, handing LangGraph only the id of the answered approval: the tool node verifies the Resumption again where the tool runs, so nothing secret is written to the checkpoint. No call of a turn runs on a pass that pauses the node, a pass that steps aside after losing a race included: an allowed call runs once, after the claimant's approval was consumed. A transient failure while acting on an answered approval pauses the node again, writes nothing and is retried by the worker; it is never a denial. The worker lists and streams with `created_by=me`, so it sees only the approvals its own principal created; the thread of an expired or withdrawn approval comes from the continuation the server echoes to its creator. An approval whose thread is not in the worker's checkpoint store is looked at again for `notPausedRetryMs` (the `no_thread` outcome of `resumeApproval`; the window restarts when the worker restarts) and then recorded once as unresumable, in terms of what was observed; run one checkpoint store per service principal, with any number of replicas sharing it. A `langgraph` approval whose continuation the server does not return is `continuation_unavailable`: reported once, not fatal to the worker. A 403 on a Resumption is `not_owner`: fatal, and `onFatal` says so. Run the adapter as a service principal: the principal that creates an approval never resolves it. Both sides report the principal they run as (`onReady` on the worker, `onApprovalOpened` on the agent side), and `expectedPrincipal` on `createGovernance` and `runResumer` compares the `sub` of the access token with the expected principal at start-up and on every token obtained from `getToken`: a different `sub` fails with `principal_mismatch`, a `sub` that cannot be read with `principal_unavailable`. At start-up that refuses to start; later it fails the governed call, and stops the worker (`onFatal`). A call for a tool the deployment executes (the approval handle says no `resume_token` will issue) is denied up front as `not_locally_executable`, before anyone is asked; its approval is withdrawn when the call opened it, and the report and the denial say what became of it. A tool that is not wrapped with `governed`, in the same tool node, is not coordinated. A record that cannot be written after the tool ran is never silent and never misleading: by default (`onRecordFailure: 'tell-model'`) the call returns a fixed tool message saying the tool ran, its outcome could not be recorded and it must not be called again for this request (the tool's own result is withheld), and reports `record_failed` to `onError` once; `onRecordFailure: 'throw'` throws it instead, which fails the run only in a tool node with `handleToolErrors: false`. Every failure exit is a typed `GovernanceError` and fails closed.

### Patch Changes

- Updated dependencies [1d6b2ba]
  - @noblecloak/client@0.1.0
