# Govern a LangGraph agent

This guide puts a LangGraph JS agent under governance with `@noblecloak/langgraph`: every tool call is
decided by your deployment's policy, a call that needs a person pauses the run, and a worker resumes it
when the approval is decided. It is the adapter half of [Your first governed tool](https://github.com/NobleCloak/noblecloak-ts/blob/main/docs/how-to/first-governed-tool.md),
which follows one call through the same hops by hand in its steps 1 to 6; read those first if you want to
see each request and response.

Every code block marked as a snippet is a file in [`docs/snippets`](../snippets), which this repository
typechecks. The guide and the files are kept the same text by a test.

## 1. Set up

You need [Bun](https://bun.sh). From the repository root:

```sh
bun install
bun run build
node node_modules/@noblecloak/spec/dist/cli/nc-mock.js
```

`nc-mock` is the mock server from `@noblecloak/spec`. It prints its address and a set of development
tokens, and keeps serving; leave it running and open a second terminal. The mock serves the same tokens at
`GET /__mock/tokens`. Two of them matter here: `creator`, a service principal with the scope `module_api`
(your agent and its worker), and `approver`, a user with the scope `approvals:resolve` (a person). Everything
under `/__mock/*` exists only on the mock; section 4 says where a real deployment's tokens come from.

<!-- snippet: connect -->

```ts
import { createClient } from '@noblecloak/client';

export const baseUrl = process.env.NC_BASE_URL ?? 'http://127.0.0.1:8787';

// The mock serves its dev tokens here. A real deployment has no /__mock/* routes.
const tokens = (await (await fetch(`${baseUrl}/__mock/tokens`)).json()) as Record<string, string>;

export function token(name: 'creator' | 'approver'): string {
  const value = tokens[name];
  if (value === undefined) throw new Error(`the mock served no ${name} token`);
  return value;
}

// The agent: a service principal with the module_api scope.
export const creator = createClient({ baseUrl, getToken: () => token('creator') });

// A person: a user principal with the approvals:resolve scope.
export const approver = createClient({ baseUrl, getToken: () => token('approver') });
```

## 2. Wrap the agent

`@noblecloak/langgraph` runs the loop for a LangGraph agent. With `createAgent` from `langchain` it is one
middleware:

<!-- snippet: adapter -->

```ts
import { tool } from '@langchain/core/tools';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { createAgent } from 'langchain';
import { z } from 'zod';
import { createGovernance, runResumer } from '@noblecloak/langgraph';
import { governanceMiddleware } from '@noblecloak/langgraph/middleware';

import { baseUrl, token } from './connect.js';

// The agent and its worker authenticate as the same service principal.
const governance = createGovernance({ baseUrl, getToken: () => token('creator') });

const sendEmail = tool(
  ({ to, subject }: { to: string; subject: string }) => `sent "${subject}" to ${to}`,
  {
    name: 'send_email',
    description: 'Send an email.',
    schema: z.object({ to: z.string(), subject: z.string() }),
  }
);

export function buildAgent(model: BaseChatModel) {
  return createAgent({
    model,
    tools: [sendEmail],
    // Governance goes last, so retry and similar middleware wrap it rather than the tool.
    middleware: [
      governanceMiddleware(governance, { toolRefs: { send_email: 'ext:local:send_email' } }),
    ],
    // A persistent checkpointer: the paused run has to survive a restart.
    checkpointer: SqliteSaver.fromConnString('checkpoints.db'),
  });
}

type Agent = ReturnType<typeof buildAgent>;

/** One thread_id per conversation. A call that needs approval pauses the run here. */
export function ask(agent: Agent, threadId: string, text: string) {
  return agent.invoke(
    { messages: [{ role: 'user', content: text }] },
    { configurable: { thread_id: threadId } }
  );
}

/** The worker: its own process, built from the same agent and checkpoint file. */
export function startWorker(agent: Agent) {
  return runResumer(agent, {
    governance,
    onError: (error) => {
      console.error(error.code);
    },
  });
}
```

What the adapter does for each hop of the loop (steps 3 to 6 of [Your first governed tool](https://github.com/NobleCloak/noblecloak-ts/blob/main/docs/how-to/first-governed-tool.md)):

- Every tool call is decided first, under the `tool_ref` you map in `toolRefs`. A tool the map does not
  name fails the run before the model is called, so a tool is never run ungoverned.
- On `step_up` it sends a continuation naming the thread, then **pauses the run** in the checkpointer with
  LangGraph's `interrupt`. `thread_id` is how the run is found again.
- The worker (`runResumer`; `waitAndResume` does the same for a script) follows the approval stream, fetches
  the Resumption, **verifies it** against the checkpointed call and **consumes** the approval.
- It then runs the tool and **writes the record itself**, with the `approval_id` and with retries. It is not
  yours to write.

What stays yours:

- **The policy**: which tools ask, which are allowed, which are denied, in the deployment.
- **The approver**: the people who answer, and where they answer (the Approvals module or your own screen).
- **The checkpointer**: it must be persistent. An in-memory one loses the paused run when the process ends.
- **The worker process**: it must run as the same service principal as the agent, because only the principal
  that created an approval can read its Resumption. It can be a different process, started hours later.

To see the loop run end to end with an agent, a worker and an approver as separate processes, run the
example. `--middleware` selects the `createAgent` form:

```sh
bun run --cwd examples/langgraph-approvals start --middleware
```

Some tools are run by the deployment through its gateway instead of by a function in your process. Declare
those with `gatewayTools`, and make the tool's function the gateway call. The adapter pauses for the
approval and runs the function once; the details are in the
[adapter README](../../packages/langgraph/README.md).

## 3. Set up governance for an existing project with the skill

The code above wraps one agent by hand. For an existing LangGraph JS project, the skill in
[`skills/langgraph`](../../skills/langgraph/SKILL.md) does the wiring and asks for the policies
the agent should run under, in one go. An assistant that can run agent skills follows its `SKILL.md`; the same two
scripts work from a terminal.

What you need first:

- **A service principal for the agent, created by an administrator of the organisation.** Its credential file's
  path, and its id as the deployment's principal list shows it (the agent and the worker are given it as
  `NC_EXPECTED_PRINCIPAL`, so a worker started with another credential fails to start). The skill stops if you offer a user token instead:
  an agent's policies apply through the service principal bound to it, and a service principal never approves what
  it asks for.
- **Your own user token**, as `NC_PROPOSER_TOKEN`, and the API's origin as `NC_BASE_URL`. A person opens the
  proposal; the agent's service principal never does.
- **A deployment at contract rev 14 or later that applies `tool:noblecloak:propose-policy-set`** (its
  `GET /v1/capabilities` lists it under `deployment_applied`). Rev 13 is the least that serves the agent policies
  themselves. The mock of `@noblecloak/spec` serves both.

What it does, in order:

1. `scripts/apply.mjs` installs `@noblecloak/langgraph` and `@noblecloak/client` and writes `src/noblecloak/`: the
   governance module (the agent runs as its service principal), the resumer worker, a log helper and `agent.json`.
2. You and the assistant find the agent's tools, name each one (`mcp:` references stay, your own tools become
   `ext:<package-name>:<tool>`), and wrap the agent: `governanceMiddleware` last in `createAgent`'s `middleware`,
   or `governedToolNode` in a hand-built graph, with a checkpointer that the agent and the worker both open.
3. Each tool is assessed with the rubric in the skill (side-effect level, blast radius, reversible, external
   party, financial) and gets a mode: `always_allow` for reads of any size and reversible single-record writes in
   your own system, `ask` for everything else (an `external` or `admin` tool, anything irreversible, with an external
   party, financial, or touching many records or the whole organisation), `deny` only where you say the agent must
   never do it. A read that this agent makes in bulk is kept `always_allow` as the baseline and tightened for the
   agent. The organisation's policy for a tool is proposed as a **baseline** for the `everyone` role, only
   where none exists; a policy for this agent alone is proposed as a **tightening**, only where its use is
   riskier. Every policy carries a rationale an approver can read without seeing your code.
4. `scripts/propose.mjs --plan <plan.json>` checks the plan against the rules in
   [Propose a policy set for your agent](https://github.com/NobleCloak/noblecloak-ts/blob/main/docs/how-to/propose-a-policy-set.md), reads the policies already in force with your
   token (and refuses a baseline where an `everyone` policy exists, or a tightening where the agent already has a
   policy), then opens one approval. `--dry-run` shows what an administrator would be asked to approve without
   sending anything.

Nothing is registered, bound or published until an administrator approves. Then the deployment registers the
tools, binds the service principal to the agent and publishes the policies in one step, or refuses all of it. The
skill does not wait for that; look at the approval in the inbox.

## 4. Against a real deployment

The code does not change. The base URL and the tokens do. For the errors you can meet, with the code and
status of each, see section 9 of [Your first governed tool](https://github.com/NobleCloak/noblecloak-ts/blob/main/docs/how-to/first-governed-tool.md).

- **Audience.** A token's `aud` is the API's origin: scheme and host, no path and no trailing slash. A token
  for another API is `401 wrong_audience`.
- **Scope.** A service principal's token carries the scope `module_api`; without it a route answers
  `403 insufficient_scope`. A token with no organisation is `403 organization_context_required`.
- **A person resolving.** Where the deployment advertises `user_resolve_scope` in its capabilities, a user's
  token must carry that scope (`approvals:resolve` on the mock) to resolve an approval. Without it the answer
  is `403 insufficient_scope`, given before the approval is even looked up.
- **DPoP.** `GET /v1/capabilities` says whether the deployment verifies DPoP proofs: `dpop` is `off`,
  `optional` or `required`. Pass the `dpopProof` option of `createClient` when it is required.
- **Identity headers.** Send only the `Authorization` header. A request that carries any header an upstream
  gateway sets to say who the caller is gets `401 header_identity_rejected`, whatever the token.
- **Eligibility.** The requester cannot approve its own request, except through the approver surface where Capabilities advertises it. An org admin can approve.
- **Where the agent's token comes from.** A person signs in with OAuth 2.1 and PKCE. A headless agent needs
  an organisation-scoped service principal, which an organisation admin creates with `noblecloak sp create`
  (`@noblecloak/cli`; it writes the credential file the agent loads). A self-serve grant
  for it is coming: the contract describes it, and no deployment serves it yet.

Ask a deployment what it serves before you depend on it:

```sh
curl -s -H "Authorization: Bearer $TOKEN" https://<your-deployment>/v1/capabilities
```
