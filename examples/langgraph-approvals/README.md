# LangGraph approvals example

A LangGraph agent whose refund tool needs a person's approval, run as three separate processes: the agent,
a worker that resumes it, and an approver. No account, no credentials and no model key: the model is
scripted and the refund only appends a line to a file.

## What this shows

The agent calls a governed tool, `issue_refund`, and NobleCloak decides `step_up`: a person must approve
this exact call, so the agent pauses and its process exits. The approval is resolved in the Approvals
module (here a script plays the person). The worker then reads the approval's Resumption, verifies it,
consumes it, runs the tool once and records the outcome. The refund happens exactly once, and only after
the approval.

The steps are in [Your first governed tool](https://github.com/NobleCloak/noblecloak-ts/blob/main/docs/how-to/first-governed-tool.md);
this example is the same loop with the adapter, [`@noblecloak/langgraph`](../../packages/langgraph/README.md), doing
the work. The guide to the adapter itself is [Govern a LangGraph agent](../../docs/how-to/govern-a-langgraph-agent.md).

## Run it against the mock in five minutes

From the repository root (the bins run from `dist/`, so build first):

```sh
bun install
bun run build
bun run --cwd examples/langgraph-approvals start
```

`start` is unattended. It starts its own `nc-mock` on a free port, registers the refund tool, then runs the
`agent`, `worker` and `approve` bins as separate node processes. Each line is tagged with the process that
wrote it:

1. `[mock] { ... }`: the mock's address (`base_url`) and its development tokens. The demo uses `creator`
   (the agent's service principal) and `approver` (a user).
2. `[agent] {"event":"agent_paused","entry":"graph","approval_id":"..."}`: the model asked for the refund,
   the decision was `step_up`, and the agent process has exited. The paused run is in a checkpoint file.
3. `[worker] {"event":"worker_ready","entry":"graph"}`: the resumer started. It resumes only the approvals
   its principal created.
4. `[approver] {"event":"approved","approval_ids":["..."]}`: the person's decision.
5. `[worker] {"event":"worker_resumed","approval_id":"...","status":"resumed"}`: the Resumption verified,
   the approval consumed, the refund issued, the record written.
6. `refunds issued: 1; approval state: consumed`.

The `[agent]` and `[worker]` lines also include a line the adapter prints about its principal. The process
exits 0 only when exactly one refund was issued and the approval is `consumed`; otherwise it exits 1.

`bun run --cwd examples/langgraph-approvals start -- --middleware` runs the same loop with an agent built by
`createAgent` and `governanceMiddleware`. The entry reads `middleware` instead of `graph` and the result is
the same.

To approve in a browser instead of by script, run `start:browser` and the [example app](https://github.com/NobleCloak/noblecloak-ts/blob/main/examples/next-app/README.md).
It starts the mock on `127.0.0.1:8787`, leaves an approval pending and waits. `NC_DECISION=deny` expects a
Deny instead of an Approve; `NC_MOCK_PORT` (default 8787) and `NC_APP_ORIGIN` (default
`http://localhost:3000`, the origin the mock lets a browser call) change its address.

## Run it against a deployment

`start` always spawns its own mock, so against a deployment you run the three bins by hand. You need:

- **A service-principal credential**: the file for an organisation-scoped service principal that has the
  `module_api` scope and the API's origin among its audiences (its `client_id`, `token_endpoint`,
  `assertion_audience` and a private key). The agent and the worker read it from `NOBLECLOAK_SP_CREDENTIALS`
  (a path, or inline JSON for a CI secret) and mint and renew their own access tokens with
  `@noblecloak/client/service-principal`, for the origin of `NC_BASE_URL` (set `NC_AUDIENCE` to ask for
  another audience). Both processes use the same service principal, because only the principal that created
  an approval can read its Resumption. The key is either inline (`private_jwk`) or in a separate JWK file
  named by `key_file`, resolved relative to the credential file. An organisation admin can create the
  principal and its credential file with `noblecloak sp create` ([`@noblecloak/cli`](https://github.com/NobleCloak/noblecloak-ts/blob/main/packages/cli/README.md)).
  **Or a creator token**: set `NC_TOKEN` to an access token of that principal (audience the API's origin,
  scope `module_api`) and the bins use it as is, never renewing it. `NC_TOKEN` wins when both are set.
- **An administrator token, where the deployment needs one**: a deployment that advertises
  `tool_registration: administrators` in `GET /v1/capabilities` lets only an organisation administrator
  register tools (step 1) and refuses any other principal, such as the creator's service principal. Use an
  organisation administrator's user token with the API's origin as its audience. It may be the same token as
  the approver token when the approver is an administrator who may approve. A deployment that does not
  advertise it (absent means `any`) accepts the creator token for step 1.
- **An approver token**: the access token of a user your deployment accepts as an approver, carrying the
  scope the deployment advertises as `user_resolve_scope` in `GET /v1/capabilities`. It is never the
  agent's token: a service principal cannot approve.

The commands below use `https://govern.example.test` as the API's origin and expect the repository built
(`bun install && bun run build`). Run them from the repository root.

**1. Register the refund tool, once per deployment.** No bin does this. Where the deployment
advertises `tool_registration: administrators`, registration needs the administrator token, not the creator
token: it answers a service principal with `403 forbidden` (one hosted deployment's detail is
registration is an organisation-administrator action). The command prints the response body, then the status. A 201 is registered. A 400 whose
`detail` is `ext:billing:issue_refund is already registered.` means it exists; any other 400 is a bad
request, so read the `detail`.

```sh
export NC_BASE_URL=https://govern.example.test
export NC_ADMIN_TOKEN=<administrator token>

curl -s -w '\n%{http_code}\n' -X POST "$NC_BASE_URL/v1/tools" \
  -H "Authorization: Bearer $NC_ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"tool_ref":"ext:billing:issue_refund","transport":"external","description":"Refund an order.","side_effect_level":"external","input_schema":{"type":"object"},"owner_kind":"org","show_arguments_to_approvers":true}'
```

`show_arguments_to_approvers` lets the approver see the order and amount they are approving.

The example's other tool, `search_tickets`, is the catalog tool `mcp:tracker:search`. The mock serves it; a
deployment decides that call by its own catalog and policy, and the run pauses at the refund only if that
decision lets the search through.

With `NOBLECLOAK_SP_CREDENTIALS` the agent and the worker renew their access token shortly before it
expires (one hosted deployment issued tokens valid for 600 seconds), so a long-running worker keeps working.
With a pasted `NC_TOKEN` they read it once, when they start, and never renew it: a worker whose token has
expired cannot read approvals or resume one, so start it, or restart it, with a freshly minted token. The
worker may be started after the approval: at start-up it catches up on approvals resolved while no worker was
running. Export the credential (or a token) in each of the terminals for steps 2 and 3.

**2. Run the agent.** It runs the thread until the refund pauses for approval, then exits. The checkpoint
file holds the paused run, and the refund log is the file the tool appends to. Use the same two paths for the
worker. **Use fresh files for every hand-run.** The agent's thread id is a constant, so a checkpoint that
already holds a finished run makes the next agent report `agent_finished`, open no approval, and leave
`approve` with nothing to find. A new directory each time is the simplest way:

```sh
export NOBLECLOAK_SP_CREDENTIALS=<path to the credential file>   # or: export NC_TOKEN=<creator token>
export NC_WORKDIR=$(mktemp -d)
export NC_CHECKPOINTS=$NC_WORKDIR/checkpoints.sqlite
export NC_REFUND_LOG=$NC_WORKDIR/refunds.log

node examples/langgraph-approvals/dist/bin/agent.js
# {"event":"agent_paused","entry":"graph","approval_id":"..."}
```

Set `NC_MIDDLEWARE=1` on the agent and the worker to use the `createAgent` build. Use the same value for
both.

**3. Start the worker**, in a second terminal with the same `NC_BASE_URL`, `NC_CHECKPOINTS` and
`NC_REFUND_LOG`, plus the same credential (the same principal as the agent's) exported as
`NOBLECLOAK_SP_CREDENTIALS` in that terminal. If you use a pasted `NC_TOKEN` instead, mint it freshly: do not
reuse the agent's if it may have expired. You may start it before or after you approve; it also resumes
approvals resolved while it was not running. It keeps running; stop it with Ctrl-C or SIGTERM.

```sh
export NOBLECLOAK_SP_CREDENTIALS=<path to the credential file>   # or: export NC_TOKEN=<fresh creator token>
node examples/langgraph-approvals/dist/bin/worker.js
# {"event":"worker_ready","entry":"graph"}
```

**4. Approve.** Either approve in the Approvals module, or run the approver bin with the approver token. It
waits up to 30 seconds for a pending approval, approves every one it can see and exits.

```sh
NC_BASE_URL=https://govern.example.test NC_APPROVER_TOKEN=<approver token> \
  node examples/langgraph-approvals/dist/bin/approve.js
# {"event":"approved","approval_ids":["..."]}
```

The worker then prints `worker_resumed`, and `NC_REFUND_LOG` holds one line:
`{"order_id":"A-7","amount_cents":2500}`.

To run it again, export new paths (run the `mktemp` lines again) and start from step 2.

Environment variables, by bin:

| Bin       | Variables                                                                                                                              |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`   | `NC_BASE_URL`, `NOBLECLOAK_SP_CREDENTIALS` or `NC_TOKEN`, `NC_CHECKPOINTS`, `NC_REFUND_LOG`; optional `NC_AUDIENCE`, `NC_MIDDLEWARE=1` |
| `worker`  | the same as `agent`                                                                                                                    |
| `approve` | `NC_BASE_URL`, `NC_APPROVER_TOKEN`                                                                                                     |
| `browser` | optional `NC_DECISION` (`approve` or `deny`), `NC_MOCK_PORT` (8787), `NC_APP_ORIGIN` (`http://localhost:3000`)                         |

The same sequence works against a mock you start yourself: run `node node_modules/@noblecloak/spec/dist/cli/nc-mock.js
--port 8788`, use `http://127.0.0.1:8788` as `NC_BASE_URL`, and take `tokens.creator`, `tokens.admin` and
`tokens.approver` from what it prints (`NC_TOKEN`, `NC_ADMIN_TOKEN`, `NC_APPROVER_TOKEN`).

## Where the governance happens

In this example's code there are two places, and neither does any of the checking itself:

- **`createGovernance({ baseUrl, getToken })`** in `src/bin/agent.ts` and `src/bin/worker.ts` builds the
  connection to the deployment. The two bins each pass a token of the same service principal.
- **`governedToolNode([...], { toolRefs, governance })`**, or **`governanceMiddleware(governance, { toolRefs })`**
  with `--middleware`, in `src/agent.ts` wraps the tools. `toolRefs` in `src/tools.ts` names each tool in
  the catalog.

The digest of the call, the pause, the Resumption check, the consume and the record all happen **inside the
adapter**, not in example code. The tool function (`issue_refund` in `src/tools.ts`) only appends a line.
For what the adapter does at each step, read [Govern a LangGraph agent](../../docs/how-to/govern-a-langgraph-agent.md)
and the [adapter README](../../packages/langgraph/README.md).

## Troubleshooting

These are the errors a first run can hit. An API error carries a code (the last segment of its problem
`type`); the full list is in section 9 of [Your first governed tool](https://github.com/NobleCloak/noblecloak-ts/blob/main/docs/how-to/first-governed-tool.md).

| You see                                                                                                          | Why                                                                                                                                                                                                                                                                                                                                                | Fix                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `X is not set`                                                                                                   | A bin reads its configuration from the environment and `X` is empty. `agent` and `worker` also need `NC_CHECKPOINTS` and `NC_REFUND_LOG`.                                                                                                                                                                                                          | Export the variable in the terminal that runs the bin; see the table above.                                                                                                                                                                                 |
| `curl` in step 1 prints `403` (the detail says registering a tool needs an organisation administrator)           | The deployment advertises `tool_registration: administrators` in `GET /v1/capabilities`, and the request carried the creator token (a service principal), not an administrator's.                                                                                                                                                                  | Send an organisation administrator's user token for the API's origin (`NC_ADMIN_TOKEN`).                                                                                                                                                                    |
| The worker prints `worker_error` events about every 30 seconds, and does not resume the approval                 | The creator token in `NC_TOKEN` has expired. The worker reads it once at start and never renews it, and its periodic check for resolved approvals then fails (for example `Listing approved approvals answered 401 ...`), whether or not anyone has approved.                                                                                      | Use `NOBLECLOAK_SP_CREDENTIALS`, which renews its own token; or mint a fresh creator token, export it as `NC_TOKEN`, restart the worker; it picks up an approval already resolved.                                                                          |
| `agent`: `GET /v1/capabilities answered 403 insufficient_scope` on stderr, then `agent_finished` on stdout       | The creator token lacks `module_api`. The code shows only on the adapter's stderr line; stdout then reports a finished run, because nothing was governed.                                                                                                                                                                                          | Ask for a service principal with `module_api`.                                                                                                                                                                                                              |
| `approve`: `Error: approving <id> answered 403` (no code)                                                        | The approver's token lacks the scope in the deployment's `user_resolve_scope`, so the resolve was refused. The bin prints the status only.                                                                                                                                                                                                         | Sign the approver in with the resolve scope.                                                                                                                                                                                                                |
| `agent`: `GET /v1/capabilities answered 401 wrong_audience` on stderr, then `agent_finished`                     | The token was issued for another API. Its `aud` must be the API's origin exactly (scheme, host and port, no path).                                                                                                                                                                                                                                 | Request a token for this API's origin. Against the mock, use the tokens it printed; a token from another mock instance is `401 invalid_token` instead.                                                                                                      |
| `409 approval_conflict`                                                                                          | The approval is not in the state the call needs: another resolution won, or it is not approved when the worker consumes it.                                                                                                                                                                                                                        | Start again from fresh `NC_CHECKPOINTS` and `NC_REFUND_LOG` and run the agent for a new approval; make sure only one approver and one worker act on it.                                                                                                     |
| `409 continuation_conflict` on the adapter's stderr: "An earlier approval of this exact call was never consumed" | An earlier approval of this exact call is still open: pending, or approved but not yet consumed by a worker.                                                                                                                                                                                                                                       | If it is pending, approve it first (`approve`). Then start the worker with a token of the same service principal (minted fresh if the agent's may have expired) and the same `NC_CHECKPOINTS` as the agent; it consumes the approval and issues the refund. |
| `unknown_kid`                                                                                                    | A `ResumptionError`; the worker prints `worker_error` with code `resumption_invalid`. The Resumption is signed with a key that is not in the key set of the `NC_BASE_URL` the worker talks to, even after the adapter fetched the set a second time.                                                                                               | Point the worker at the deployment that opened the approval. On a deployment it follows a key rotation or the wrong deployment; the mock reaches it only with `--break sign_unlisted_key`. Start from fresh files and run the agent again.                  |
| The worker never prints `worker_resumed`                                                                         | The worker runs as another principal than the agent (its token is for a different service principal), or reads another checkpoint file.                                                                                                                                                                                                            | Give the agent and the worker tokens of the same service principal (the same client), and the same `NC_CHECKPOINTS` and `NC_MIDDLEWARE`. If the worker prints `worker_error` instead, see the expired-token row.                                            |
| `agent_finished`, and no approval                                                                                | The checkpoint file already holds a finished run on the same thread (a reused `NC_CHECKPOINTS`), so nothing new was governed.                                                                                                                                                                                                                      | Export a new `NC_CHECKPOINTS` and `NC_REFUND_LOG` (step 2) and run the agent again.                                                                                                                                                                         |
| `no approval became pending`                                                                                     | Thrown by `approve` after 30 seconds. The agent has not paused yet; or the agent printed `agent_finished` (reused checkpoint, above); or you passed `NC_TOKEN` as `NC_APPROVER_TOKEN`: `approve` lists with `approver=me`, which finds nothing for the creator or any service principal; or the user may not approve for the agent's organisation. | Run the agent first from fresh files, then the approver with a user's token (`NC_APPROVER_TOKEN`), a user who may approve for the agent's organisation.                                                                                                     |
