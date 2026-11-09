# @noblecloak/langgraph

Approvals for LangGraph JS. When policy says a human must approve a tool call, the graph pauses in its
checkpointer, a person approves in the NobleCloak inbox, and the agent resumes, hours later and from another
process. The tool runs exactly once, and only for the arguments that were approved.

Use it with `createAgent` (one middleware) or with a hand-built graph (`governed` tools, or `governedToolNode`).
The adapter does two things: it attaches a continuation on the way out, and it turns a verified Resumption
into LangGraph's own resume on the way back.

## Install

```sh
bun add @noblecloak/langgraph @langchain/langgraph @langchain/core
bun add langchain # only for `@noblecloak/langgraph/middleware` (the `createAgent` form)
```

The middleware subpath needs `@langchain/core` `^1.2.14` (what `langchain` 1.5.15 requires); the main entry works with the peer range above.

Developed against `langchain` 1.5.15, `@langchain/langgraph` 1.4.19 and `@langchain/core` 1.2.14. 1.5.15 is the `langchain` version tested; 1.5.16 and later need `@langchain/core` 1.2.17 or later. It needs a deployment that serves
the module API at contract v1 rev 4 or later (the main entry; `gatewayTools` needs rev 7 or later), and is tested against rev 18 (release `contract-v1-rev18`; the tests run against the mock of `@noblecloak/spec` 0.12.0). Three behaviours it relies on arrived in rev 4: `created_by=me` on the approvals list and stream, the continuation echoed
to the principal that created an approval, and the service-principal visibility rule. A deployment older than rev 4
offers none of the three.

From rev 17 a deployment may list the continuation kinds it accepts (`continuation_kinds` on `GET /v1/capabilities`).
When it routes approvals and the list does not include `langgraph`, the adapter refuses to start
(`continuation_kind_unsupported`), because an approval it opened could never resume. A deployment that lists no
kinds accepts those of rev 16, `langgraph` among them, and is used as before.

Setting up an agent's policies is a separate matter from running it. An agent's policies apply through the service
principal bound to it, which needs a deployment at contract rev 13 or later. Opening the one approval that registers
the agent's tools, binds its service principal and publishes its policies (`tool:noblecloak:propose-policy-set`) needs
rev 14 or later. The [`langgraph` skill](../../skills/langgraph/SKILL.md) does both for an existing project; running
the adapter itself needs neither.

**Run the adapter as a service principal.** On the module API the principal that creates an approval never
resolves it, whatever kind of principal it is, so an agent that runs as a person's own user token cannot be
the approver of what it asks for. A headless agent and its worker therefore authenticate as an
organisation-scoped service principal (`client_credentials`, the `module_api` scope).

## Govern an agent

```ts
import { createAgent } from 'langchain';
import { createGovernance } from '@noblecloak/langgraph';
import { governanceMiddleware } from '@noblecloak/langgraph/middleware';

const governance = createGovernance({
  baseUrl: 'https://govern.example.com', // the module API
  getToken: () => token, // the agent's service principal
});

const agent = createAgent({
  model,
  tools: [searchTool, refundTool],
  // Every tool call is decided first. `toolRefs` names each tool in the NobleCloak catalog.
  // Put `governanceMiddleware` LAST: retry, PII and emulation middleware then wrap governance rather
  // than the tool (see Things to know, note 19).
  middleware: [
    governanceMiddleware(governance, {
      toolRefs: { search: 'mcp:tracker:search', issue_refund: 'ext:billing:issue_refund' },
    }),
  ],
  checkpointer, // a persistent one: see Things to know
});
```

`toolRefs` is your stable name for each tool in the NobleCloak catalog, keyed by the tool's LangChain name. It
is never derived from that name. A tool the agent has that the map does not name fails the run
at the first model call, before the model is called (a configuration error; the tool is never run
ungoverned). That check sees the tools `createAgent` was given; a tool only a later middleware adds is checked
when it is called. `handleToolErrors` (default `true`, as for
`governedToolNode`) turns an error the tool throws, and arguments its (Zod) schema rejects, into an error
message for the model; the schema is checked before anything is decided, so rejected arguments open no
approval and leave no record. A `GovernanceError` is never turned into a message (note 9).

Invoke the agent with a `thread_id`. A call that is allowed runs and is recorded; a call that is denied
returns the reason to the model; a call that needs approval pauses the run. `createAgent` runs each tool call
of a model message as its own task by default (`version: 'v2'`), so each call that needs approval pauses on its
own approval and the others are not held back; with `version: 'v1'` the calls of a message share one task and
are coordinated as in note 8. The middleware ends in the same function as `governed`, so what is said below
holds for all three.

## Hand-built graphs

```ts
import { createGovernance, governed } from '@noblecloak/langgraph';

const governance = createGovernance({
  baseUrl: 'https://govern.example.com', // the module API
  getToken: () => token, // the agent's service principal
});

// Same name, schema and description; every call is decided first.
const issueRefund = governed(refundTool, { toolRef: 'ext:billing:issue_refund', governance });
```

`toolRef` is your stable name for the tool in the NobleCloak catalog. It is never derived from the LangChain
name. To govern a whole tool node, use `governedToolNode(tools, { toolRefs, governance })`.

Compile the graph with a persistent checkpointer and a `thread_id`. The calls behave as under `createAgent`.

## Resume

```ts
import { runResumer } from '@noblecloak/langgraph';

// A worker: reconciles what was answered while it was down, then follows the approval stream.
const worker = await runResumer(graph, {
  governance,
  onError: (error) => console.error(error.code),
});
// ... await worker.stop();
```

`waitAndResume(graph, config, { governance })` does the same for a script: it waits on the thread's approval
and resumes. Both end in `resumeApproval(graph, approvalId, { governance })`, which verifies the signed
Resumption against the checkpointed tool call (so a bad one never re-runs the graph) and never runs a tool
itself. It hands LangGraph **only the id of the answered approval**, `{ kind: 'answered', approval_id }`.
It returns `{ status: 'resumed', resolution: 'approved' | 'rejected', result }` for an answered approval, and
`{ status: 'resumed', state: 'expired' | 'withdrawn', result }` for one that ended without an answer (a state:
nobody resolved it). It reports `resumed` when the graph was resumed with the answer and acted on it (the tool ran, or a
rejection or a denial was written, or the graph went on to its next pause). When nothing could act on the
answer it rejects instead: `unreachable` when `/v1` could not be reached (16), `consume_conflict` or
`replayed` when another resumer holds the approval (14). The worker's `onResumed` fires only for `resumed`.

The tool is verified again where it runs. When the node re-enters, `governed` reads the approval from the
server, fetches its Resumption (only the principal that created the approval can), verifies the signature,
the `tool_ref` and the digest of the arguments it is about to hand the tool, checks that the signed
continuation names this thread, namespace and tool call, applies the replay guard (keyed on the approval,
and let go again if the attempt fails before anything is spent), and only then consumes, runs and records.
The guard is let go again after a `/consume` whose outcome is unknown too (a network error, a 5xx): that is
safe because `/consume` is atomic on the server. If the first request did spend the approval, the retry
reads its state first and finds it `consumed` (see 10), so the tool is not run twice; if it did not, the
retry consumes it.
A resume value that is not that shape, names another approval, or whose approval is not approved never runs
the tool; the call gets a typed denial.

`examples/langgraph-approvals` in the repository runs the whole loop against the mock, with the agent, the
worker and the approver as separate processes: `node dist/bin/demo.js --middleware` runs the `createAgent` form.

## Tools the gateway executes

Some tools are executed by the deployment, through the governed MCP gateway, not by a function in your
process. Wrapping one as an ordinary local function is refused (`not_locally_executable`). To use one,
declare it, and make its function the gateway call (your MCP client):

```ts
import { gatewayCallContext, governedToolNode } from '@noblecloak/langgraph';

const createIssue = tool(
  async ({ title }, config) => {
    const { header } = gatewayCallContext(config); // { 'X-NobleCloak-External-Run-Id': run }
    return callGateway({ name: 'create_issue', arguments: { title }, headers: header });
  },
  { name: 'create_issue' /* ... */ }
);

governedToolNode([createIssue], {
  toolRefs: { create_issue: 'mcp:tracker:create_issue' },
  governance,
  gatewayTools: ['create_issue'], // or governed(tool, { toolRef, governance, executedBy: 'gateway' })
});
```

`governanceMiddleware(governance, { toolRefs, gatewayTools: ['create_issue'] })` takes the same declaration
(a name that is not in `toolRefs` throws at construction); the function gets its run through the config
the middleware chain invokes it with, and every behaviour below holds on that path too.

The mode is per tool. What the adapter does for a declared tool:

- **Needs a run.** The call is denied `run_required` before any decision when it has no external run (no
  `thread_id`, or a deployment that serves no runs). The adapter has by then read `/v1/capabilities`; it
  opened no run (there is no thread, or the deployment serves none) and asked for no decision. The gateway admits a call by the run it names.
- **Is never asked locally.** On a deployment that cannot route approvals (it does not advertise approval
  routing, or answers `continuation_unsupported`) the call is denied `unroutable`, whatever
  `whenUnroutable` says: the gateway admits a call by an approved obligation it holds, and a local answer
  creates none.
- **Pauses as usual.** A decision of `step_up` with no `resume_token` to issue pauses the node like any
  approval; the approval is not withdrawn.
- **Runs the function after the approver acts.** The node re-runs, the re-decision answers `allow` with the
  approval handle, and the adapter runs your function once (the replay guard applies) and writes no outcome
  record: the gateway records its own call. A policy `allow` with no handle runs and is recorded as for any
  tool. If the node is re-invoked with no resume value while the approval is still open, it pauses again on the same
  approval. A resume value naming an approval that is still pending is denied `resumption_invalid` (the worker
  never sends one: `resumeApproval` reports `waiting`); this narrows the brief's D4, which also had it pause again.
- **Declare only tools the deployment executes.** A `step_up` that does issue a `resume_token` is the
  caller-consumer approval of a local tool: the adapter consumes it and then runs your function, so the
  gateway sees an obligation already consumed and refuses the call. Declare a tool gateway-executed only
  when its decision says no token will issue.
- **Does not call the gateway, mint its token, or retry.** The gateway refusing the re-issued call
  (`obligation_already_consumed`, `no_matching_obligation`, `external_run_*`) is your function's error; it
  reaches the model as the tool's error and nothing is decided again. That refusal leaves the approval spent
  locally (the replay guard) and still `approved` upstream, so the model's retry of the same call is denied
  `continuation_conflict` until the approval expires.

The process that re-runs the node (the worker, or a builder who resumes) makes the gateway call. It owns the
MCP client and the gateway token, and its graph must declare the same `gatewayTools`: an `allow` that
carries an approval handle is the gateway admitting the call by an approval nothing in your process
consumes, so on a tool that is not declared it is refused `not_locally_executable` and nothing runs. A
worker graph that omits the declaration therefore runs nothing; the approval stays approved for the gateway.

What stays yours:

1. **Two tokens.** The gateway's token is minted for `MCP_SP_AUDIENCE` with the same client credentials, and
   separately from the token `createGovernance({ getToken })` sends to `/v1`. The adapter never sees it.
2. **The run per thread.** `gatewayCallContext(config)` returns the run the adapter decided under, as the
   `header` (`X-NobleCloak-External-Run-Id`) and as `meta` (`noblecloak/external-run-id`, for the `_meta` of a
   `tools/call`). Send one form. Both with different values is a gateway refusal; the adapter sends neither.
   It throws `run_required` when `config` carries no run, which is what a function that was not called by a
   declared tool sees. The adapter cannot tell that a function ignores it.

`examples/langgraph-approvals/src/gateway-tool.ts` runs this against a fake gateway that checks the token, the
run header and the approved arguments, and admits the call once.

## Things to know

1. **The worker runs as the same service principal as the agent.** Only the principal that created an approval
   can read its Resumption, and a service principal sees only the approvals it created. The worker lists and
   streams with `created_by=me`, so every approval it sees is its own. A worker run as another principal
   therefore sees none of them: it starts, and resumes nothing. Two settings make that visible.
   - **Both sides report the principal they run as.** The worker calls `onReady({ principal })` once start-up
     has succeeded (without it, the principal is logged once with `console.info`). The agent side calls
     `onApprovalOpened({ approvalId, toolRef, principal })` each time a governed call opens a new approval
     (without it, the first one is logged once). The two principals should be equal.
   - **`expectedPrincipal`** (on `createGovernance` and on `runResumer`) is compared with the `sub` of the
     access token at start-up and on every token the adapter obtains from `getToken`, before it is sent;
     nothing but the `sub` is read or reported. When it is not set, nothing is compared. A different
     principal fails with `principal_mismatch`; a token whose `sub` cannot be read fails with
     `principal_unavailable`. At start-up that rejects `runResumer`, and on the agent side the first governed
     call (or `assertReady()`) throws; a stock `ToolNode` writes the thrown error into the thread as an error
     message, so the builder is told through `onError` as well. Later, a token with another `sub` fails the
     governed call it was fetched for before the tool runs and before a decision is posted. On the worker it
     stops the running worker (`onFatal` is called and `failed` resolves with the error): a worker that is
     no longer the principal it was configured to be resumes nothing. A client passed as `client` obtains
     its own tokens, which the adapter does not see; the adapter's own `getToken` calls are still checked.

   **Where the principal comes from.** The module API has no route that returns the caller's own identity
   (a record's `actor` echoes it, but only on a write, and an approval carries no creator), so both sides
   read the `sub` claim of the access token they send (`principalOfToken`). Both sides use the same source,
   so the comparison is like for like; give `expectedPrincipal` the id the token carries as `sub`. A token
   that is not a JWT with a `sub` names no principal: the report says `undefined`, and `expectedPrincipal`
   refuses it. When the contract gains such a route, this reads from it.

   Approvals created by a service principal are readable only by that principal, so replacing a revoked
   principal with a new one orphans the old one's open approvals.
   **One checkpoint store per service principal.** Replicas that share one store are fine. Two deployments
   with different checkpoint stores under one service principal each see the other's approvals as their own,
   and each records the other's as `unresumable` once the retry window has passed.

2. **Use a persistent checkpointer.** The paused run lives in the checkpointer, not in the process.
3. **LangGraph re-runs the node on resume.** Anything the node does before the gated call happens twice
   and must be safe to repeat. The adapter's second decision call on an approved resume matches the open
   approval and opens no second one. A rejection, an expiry or a withdrawal is not decided again: the
   adapter finds the answered approval first (see 13) and asks the server what became of it.
4. **A tool that fails after its approval was consumed needs a new approval.** Consumption happens before the
   tool runs, by design: an approval is spent on the attempt, not on the success.
5. **`whenUnroutable: 'ask-locally'` answers are not verified.** The default is `'deny'`. It applies only when
   the deployment cannot route approvals at all (`/v1/capabilities` reports no resolutions, or `/decisions`
   answers 422 `continuation_unsupported`). On a deployment that routes them, a step-up with no approval
   handle, or a call with no `tool_call_id`, is a denial, never a local question. With `'ask-locally'` the
   driver resumes with a plain yes or no, the outcome is recorded as local, and the approver is not attested.
6. **A service principal can never approve.** The approver is a person signed in to the inbox.
7. **One run per thread.** Approvals are scoped to the thread's run, so an approval in one thread never
   satisfies a call in another. A deployment that routes approvals must also serve runs, or the adapter
   refuses to start (`runs_required`). One that lists its accepted continuation kinds without `langgraph` is
   refused the same way (`continuation_kind_unsupported`).
8. **One approval at a time per model turn, and nothing runs while one is pending.** If the model asks for
   several tools at once, every call is decided first. If any needs approval, the earliest in the message
   pauses the node, the other calls that need approval are returned to the model with a message to retry
   after it resolves (the approval they opened is withdrawn), and **no call of the turn runs on a pass that
   pauses the node**: an allowed sibling waits for the claimant's outcome. It runs once, on the pass where
   the claimant's approval was consumed (or, after a rejection, once while the rejected call does not); it
   does not run on a pass where the claimant steps aside after losing a race (14) or pauses again
   because `/v1` could not be reached (16). A turn where nothing pauses runs its calls side by side. This
   holds for `governed` tools in any `ToolNode`, and for `governanceMiddleware` under `createAgent`'s
   `version: 'v1'`; the coordination is in the adapter, not the node. Under `createAgent`'s default (`v2`) each
   call is its own task and pauses on its own approval, with nothing to coordinate. A call
   that is handed a resume value meant for another call of the turn (an earlier call that no longer pauses,
   or whose decision changed) is a fresh pause on its own approval. **A tool that is not wrapped with
   `governed`, in the same tool node as governed tools, is not coordinated:** the adapter cannot hold it
   back, so it runs on every pass, a pass that pauses the node included, and again when the node re-runs.
9. **A record that cannot be written is never silent and never misleading.** After the tool ran, the outcome
   record is retried with a bounded backoff (`recordRetry`, default 4 attempts over about 3.5 seconds, one
   Idempotency-Key for all of them: transport failures, 5xx and 429; any other refusal is not retried).
   Plainly, if it still cannot be written: **the tool ran; the approval, if any, is consumed; the record is
   missing.** What the model reads then is `onRecordFailure`:
   - `'tell-model'` (the default): the call **returns** a tool message, it does not throw, so a stock
     `ToolNode` (default `handleToolErrors: true`) cannot turn it into "Error: ... Please fix your mistakes."
     The text is fixed, with no transport error text, no tool output and no id but the tool name, and the
     same in a bare `governed` tool inside any `ToolNode` and in `governedToolNode`: _"The tool NAME ran, but
     its outcome could not be recorded, so its result is withheld. Do not call NAME again for this request:
     it already ran. Tell the user that this action was carried out and was not recorded, so that a person
     can follow up."_ **The tool's own result (or error) is not passed on:** returning it as if all were
     well would be misleading, and the message says why it is missing. That is the cost of this default.
     The message has `status: 'error'` and `denialCodeOf` reads `record_failed` from it; unlike a denial it
     says the tool ran. The typed `record_failed` error, with the cause, goes to `onError` (or
     `console.error`) once per failed execution. If the model calls the tool again anyway, the adapter does
     nothing special: an allowed call runs again, and a gated call is decided again and asks for a new
     approval, as any call does.
   - `'throw'`: the call throws `record_failed` after the tool ran. That fails the run **only when the
     tool node does not swallow tool errors**: pass `handleToolErrors: false` to `governedToolNode` (or
     configure your own `ToolNode` so). Under a stock node the thrown error is written into the thread as an
     error message (with LangGraph's "Please fix your mistakes."), which tells the model to fix something
     although the tool ran and its approval is spent; a retry of the node is a new execution. Choose it only
     with a node that does not swallow errors. `governanceMiddleware` is the exception: it rethrows a
     `GovernanceError` whatever its `handleToolErrors` says, so under it `'throw'` always fails the run.

   Other failures that are not thrown (a failed resume, a refused decision) go to `onError` too; without
   one, to `console.error`. A run that fails after an approval was spent on its call is `resume_failed` and
   is not retried.

10. **The worker retries an approval whose thread it cannot show yet** (the agent can be answered before it
    has checkpointed) on every reconcile, for `notPausedRetryMs` (default five minutes). Only then does it
    report it and give up. A thread that is not in this worker's checkpoint store at all is retried the same
    way (the window restarts when the worker restarts), and only after it is it recorded as `unresumable`
    (once: the record's key is
    `nc-langgraph-unresumable-<approval id>`) and reported. The record says the thread was not found in this
    worker's checkpoint store, which is what was observed; it does not say the thread is gone. A thread that
    has already answered the call is settled without a report. **The listing and the stream are asked for
    with `created_by=me`,** so the worker sees only the approvals its own principal created. The reconcile
    window is the age of the _resolution_ (`maxAgeMs`, default seven days), so an approval that waited a long
    time for its answer is still caught up. A listing page that is not a list, or whose `meta.next` is neither
    a string nor null, is an `unreachable` failure, not an empty page. Consumed approvals are looked at
    too, within `consumedMaxAgeMs` (default 24 hours) and after the retry window: a consumed approval whose
    thread is still paused on it (a crash between the consume and the checkpoint write) is raised as
    `unresumable`, and the tool is not re-run. Run one resumer per principal: another process that consumed
    an approval a moment ago and is still running the tool looks the same until it checkpoints.
11. **A tool the deployment executes cannot be wrapped as a local function.** When the decision for a call is
    `step_up` and its approval handle says `resume_token_will_issue: false`, the deployment executes this tool:
    no `resume_token` will issue, this process has nothing to consume, and it must not run the call itself.
    The adapter denies the call up front, before anyone is asked to approve it, with `not_locally_executable`;
    the wrapped function is never called, and the builder is told through `onError`. If its own decision call
    opened the approval (`created: true`) it is withdrawn, so nothing is left pending; an approval it only
    matched (`created: false`) was opened by another call and is left alone. Dispatch such a tool through the
    gateway instead of wrapping a function for it, or declare it gateway-executed (`gatewayTools` /
    `executedBy: 'gateway'`, see [Tools the gateway executes](#tools-the-gateway-executes)). The report and the denial say what became of the approval,
    from the withdraw's result: withdrawn, still open because the withdraw failed (the failure is reported
    too), or only matched. An `allow` that carries an approval handle is the gateway admitting the call by an
    approval it holds; on a tool that is not declared gateway-executed it is refused `not_locally_executable`
    the same way (the approval has been answered, so nothing is withdrawn unless this call opened it). Only
    for a declared tool does the adapter run the function on it, with no consume and no record. A Resumption with no
    `resume_token` for a call the gateway did not admit is refused when the node re-enters: the adapter has
    nothing to consume, so it denies the call rather than run it. That is the second line of defence.
12. **An expired or withdrawn approval is matched to its thread by its continuation.** The server echoes the
    full continuation on an approval to the principal that created it, in every state, so the thread comes from
    `continuation.correlation.thread_id` in any process, whatever the checkpointer holds. When you pass
    `threadId` to `resumeApproval`, that wins. An approval of this principal's own whose continuation names
    no thread, or whose thread is not in this process's checkpoint store (after the retry window, see 10), is
    recorded as `unresumable` and reported; it is never skipped without a word. A `langgraph` approval for
    which the server returns no continuation at all throws `continuation_unavailable` and records nothing:
    either the caller is not the principal that created it, or the deployment predates rev 4 and echoes
    none. It is not fatal to the worker, which reports it once and leaves the approval alone (the
    continuation is fixed when the approval is created, so a later look would not change the answer; a
    restart reads it afresh). An approval whose continuation kind is not `langgraph` (`mcp_held`, `push`) is
    skipped as `not_langgraph`, whatever its state, because this adapter never opened it. Pass `threadId` to
    name the thread yourself.
13. **Nothing secret is written to the checkpoint.** The resume value is an id. The Resumption, its
    signature and the `resume_token` are read from the server by the process that runs the tool and are
    never part of LangGraph's state. The adapter does read one private LangGraph value, the node's
    scratchpad (`__pregel_scratchpad`), to see which approval a re-run was resumed with before it decides
    again. It fails closed (an unknown shape reads as no resume, which costs a withdrawn stray approval,
    never a wrong answer), and a test pins the shape to the installed version, so a LangGraph upgrade that
    moves it fails loudly.
14. **Two resumers on one approval:** the one that consumes it runs the tool; the other steps aside: it
    runs no call of the turn, not an allowed sibling either (8), and writes nothing into the thread. It does
    this by pausing the node again (a thrown error would be turned into a message by a `ToolNode` that
    handles tool errors) and `resumeApproval` rejects with `consume_conflict` or `replayed`.
15. **A 403 on an approval's Resumption is a misconfiguration, and fails the worker loudly.** The listing and the
    stream carry only approvals this principal created, so a 403 `not_owner` on the Resumption of one of them
    means the server disagrees about who created it. `not_owner` is this answer only: an approval that comes
    back with no continuation is `continuation_unavailable` (12). At start-up the catch-up rejects with `not_owner`; while
    running, the first `not_owner`, before any approval was resumed, stops the worker. After one was resumed, a
    `not_owner` is reported at every look and does not stop it. `not_owner` is never settled. An approval of
    another principal never reaches the worker, so it neither stops it nor gets a record from it.
16. **A transient failure while acting on an answered approval writes nothing.** If, when the node re-enters,
    reading the approval, reading its Resumption, fetching the key set or consuming it fails with a network
    error, a 5xx, a 429 or a 408, the call is not denied (a denial written into the thread would leave the
    approval approved and unconsumed, and the model's retry would meet `continuation_conflict`). The node
    pauses again, which writes nothing; `resumeApproval` rejects with `unreachable` and releases its claim;
    `runResumer` tries again on its next reconcile or event. A `/consume` whose outcome is unknown is
    resolved by reading the approval on the retry (see 3). `onResumed` fires once, when the tool has run or a
    final answer was delivered. The cause is reported to `onError`. A failure of `/v1/decisions`, of
    `/v1/runs` or of the capabilities read on a re-run is still a denial: the approval stays approved and
    unconsumed, and the model's retry of that call is refused until the approval is withdrawn or expires.
17. **How a supervisor learns the worker stopped.** `runResumer` rejects at start-up (`runs_required`, `continuation_kind_unsupported`,
    `not_owner`, `principal_mismatch`, `principal_unavailable`, an unreachable stream). A worker that stops itself while running does so once, with
    `not_owner` (15): it calls `onFatal(error)` and resolves `handle.failed` with the same error, and looks
    at nothing afterwards; it never restarts itself, so a supervisor restarts it with the right credentials.
    Neither is called for a worker stopped by `stop()`. A stream that opens and closes at once is not a
    recovery: the reconnect backoff starts over only after the stream stayed open for `streamStableMs`
    (default 10 s) or delivered an event, so such a server is reconnected, and the approvals reconciled, at
    growing intervals up to `maxBackoffMs`.
18. **`createAgent`'s `version` decides how gated calls pause.** Under `v2` (the default)
    each tool call of a model message is its own task, so each gated call pauses on its own approval. Under
    `v1` the calls of a message share one task and the one-pending-approval-per-task rule of note 8 applies.

19. **Put `governanceMiddleware` last in `middleware`, so retry, PII and emulation middleware wrap governance
    rather than the tool.** Middleware listed after it sits between governance and the tool. Governance
    hands that chain a tool that runs at most once per governed call: a second invocation (a
    `toolRetryMiddleware` retrying a failed tool, say) throws `tool_reinvoked` without running the tool,
    because the decision, the approval and the record belong to one execution. A retry placed after
    governance therefore cannot retry. A later middleware that supplies a `tool` for a call the agent has no tool for does not
    get to run it: such a call is answered with "is not a valid tool", with no decision. The outcome record
    reflects the tool's real execution even when a misplaced retry or other middleware rewrites the result
    (a chain that returns without running the tool is recorded as failed, `tool_not_executed`).

Rejections tell the model and continue; set `onRejected: 'halt'` to end the run instead. Every failure exit
is a `GovernanceError` with a `code`, and every one fails closed, except the record that cannot be written
after the tool ran (9): there is nothing left to close, so it is told to the model and reported.
