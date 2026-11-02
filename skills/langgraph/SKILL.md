---
name: langgraph
description: Put a LangGraph JS agent under NobleCloak governance, so its tool calls are decided by policy, risky ones wait for a person's approval, and the agent resumes afterwards. Use when the user wants to govern, add human approval to, or set up policies for a LangGraph (or LangChain `createAgent`) agent in a TypeScript project.
---

# Govern a LangGraph agent

This skill governs an existing LangGraph JS agent with `@noblecloak/langgraph`, and asks for the policies that
should apply to it. When it finishes:

- every tool call of the agent is decided by NobleCloak before it runs;
- a worker process resumes a call once a person has approved it;
- the agent runs as **its own service principal**, not as a person;
- one approval is open, `propose-policy-set`, that an administrator reviews. Approving it registers the agent's
  tools, binds the service principal to the agent and publishes the policies, all together.

Nothing is registered or published until an administrator approves. The skill only opens the request.

Two scripts do the mechanical parts; the rest is judgement that you make, with the user, in the numbered steps.

| Part                  | Who does it                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| `scripts/apply.mjs`   | Installs the packages and copies a governance module and a worker into `src/noblecloak/`. No choices. |
| `scripts/propose.mjs` | Checks your plan against the proposal rules and opens the approval. No choices.                       |
| Steps 1 to 6 below    | You: find the tools, name them, wrap the agent, assess each tool's risk, write the plan.              |

## Before you start

- The project is a TypeScript or JavaScript project with `@langchain/langgraph` or `langchain` in its
  `package.json`, and an agent built with `createAgent` or a hand-built `StateGraph`. Stop and say so if it is
  not; the skill does not cover other runtimes.
- **The agent needs its own service principal, created by an administrator of the organisation first.** Ask the
  user for two things: the path of the service principal's credential file, and the service principal's id
  (the `id` that the deployment's principal list shows for it; do not guess it from the credential's
  `client_id`). If the user has only a user token (`NC_TOKEN` or a pasted access token), **stop**, and explain
  why: the policies for an agent apply through the service principal bound to it, so an agent that runs on a
  person's token is governed as that person, and a service principal never approves what it asks for. Ask them to
  have an administrator create the service principal, then start again. Do not offer to run the agent on a user
  token, and never write `NC_TOKEN` anywhere.
- The person who runs the proposal is a user, not the service principal. They need their own user token in
  `NC_PROPOSER_TOKEN` (step 6), and the module API's origin in `NC_BASE_URL`. `NOBLECLOAK_APPROVALS_URL`, the
  address of the deployment's approvals module, is optional: when set, the script prints it next to the approval
  id.
- The deployment must apply policy-set proposals (contract rev 14: its capabilities list
  `tool:noblecloak:propose-policy-set` under `deployment_applied`). A deployment that does not answers
  `approval_unroutable`; tell the user to ask their administrator.

## Steps

1. **Run the script, and declare the agent.** From the project's root:

   ```sh
   node <this skill's directory>/scripts/apply.mjs
   ```

   It refuses a project that has neither `@langchain/langgraph` nor `langchain`. It writes four files under
   `src/noblecloak/` (see the table), adds `NC_BASE_URL`, `NOBLECLOAK_SP_CREDENTIALS`, `NC_EXPECTED_PRINCIPAL` and a commented
   `NC_AUDIENCE` to `.env.example` (and `!.env.example` to `.gitignore` when a `.env*` rule there would keep that
   file out of git), and installs `@noblecloak/langgraph` and `@noblecloak/client` with the project's package
   manager (the `packageManager` field, else the nearest lockfile, else npm). It refuses to overwrite a file that
   exists with other content and writes nothing then; show the user the list and ask before using `--force`.
   `--dry-run` prints what it would do, `--project <dir>` names another directory, `--skip-install` leaves the
   install to you. `--source <dir of tarballs>` is for pre-release testing by NobleCloak, not for users.

   | File                           | What it is                                                             |
   | ------------------------------ | ---------------------------------------------------------------------- |
   | `src/noblecloak/governance.ts` | `agentGovernance()`: governance authenticated as the service principal |
   | `src/noblecloak/worker.ts`     | the resumer worker: its own process, resumes approved calls            |
   | `src/noblecloak/log.ts`        | one JSON line per event on stdout                                      |
   | `src/noblecloak/agent.json`    | `{ "name", "id" }`: the agent's row in the deployment                  |

   Then open `src/noblecloak/agent.json` and set `name` to a short name for the agent (what an approver will
   see). Leave `id` null: `propose.mjs` declares the agent (`POST /v1/agents`) the first time it runs and writes the
   id back here, so a second run reuses it (until then a `declare` member holds the request's idempotency key, so a run that
   died after the agent was created finds the same agent again). There is no list route to find an agent again, so keep this file in
   version control.

   Tell the user to set `NOBLECLOAK_SP_CREDENTIALS` (the credential file's path; keep the file outside the
   repository), `NC_EXPECTED_PRINCIPAL` (the service principal's id, the one you asked for above) and
   `NC_BASE_URL` in the agent's environment, for both the agent and the worker. With the id set, a worker started
   with another credential than the agent's stops with `principal_mismatch` instead of starting cleanly and
   resuming nothing.

2. **Find the agent's tools, and confirm them.** Read the code: the `tools` array passed to `createAgent`, or the
   tools bound to the graph's tool node. Show the user the list (name and one line each) and ask whether it is
   complete and whether any tool should stay out of the proposal. Only the agent's own tools are in scope: do not
   propose anything for tools the agent does not carry.

3. **Name each tool.** Each tool needs a name in the NobleCloak catalog, its `tool_ref`:
   - a tool that comes from an MCP server through the NobleCloak gateway keeps its `mcp:<server>:<tool>` reference
     (it is already in the catalog; it is not registered again, and it is declared in `gatewayTools` of the
     middleware, as the adapter's README describes);
   - a tool the project defines itself is `ext:<package-name>:<tool>`, where `<package-name>` is the project's
     package name without its `@scope/`, and `<tool>` is the tool's LangChain name. These are the tools the
     proposal registers.

4. **Wrap the agent.** Write `src/noblecloak/governed-agent.ts`. It exports `TOOL_REFS` (LangChain tool name to
   `tool_ref`) and `buildGovernedAgent(governance)`, which returns the compiled agent. The worker imports it, so
   the agent and the worker are built the same way. Two forms:
   - `createAgent`: put `governanceMiddleware(governance, { toolRefs: TOOL_REFS })`, from
     `@noblecloak/langgraph/middleware`, **last** in `middleware`, so it sees the call after the other middleware
     has changed it. A tool the agent carries that `TOOL_REFS` does not name fails the run before the model is called.
   - a hand-built graph: use `governedToolNode(tools, { toolRefs: TOOL_REFS, governance })` as the tool node.

   Either way the agent needs a **persistent checkpointer** that the agent and the worker both open (a SQLite
   file or a database, not the in-memory saver): the paused run lives there, and the worker finds it there.
   If the project already has one, use it. Call `buildGovernedAgent(await agentGovernance())` where the project
   starts its agent. Start the worker with the project's TypeScript runner, for example
   `node --import tsx src/noblecloak/worker.ts`, and keep it running while the agent runs.

5. **Assess each tool.** Apply the rubric below to every tool in the proposal, and keep the reasons: each one
   becomes the `rationale` an approver reads, so it must make sense to someone who has never seen the code.

   | Question                             | Answers                                                                  |
   | ------------------------------------ | ------------------------------------------------------------------------ |
   | `side_effect_level`: what can it do? | `read`, `write`, `delete`, `external` (acts outside the system), `admin` |
   | `blast_radius`: how much at once?    | `one_record`, `many_records`, `org_wide`                                 |
   | `reversible`                         | can the effect be undone by the builder's own system                     |
   | `external_party`                     | does it act on, or send something to, a party outside the organisation   |
   | `financial`                          | does it move or commit money                                             |

   Then choose the mode:

   | The tool                                                                                                                                                                              | Mode           |
   | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
   | a read of any size, or a write or delete that is reversible, to one record, inside the builder's own system (no external party, no money)                                             | `always_allow` |
   | anything else: every `external` or `admin` tool, and any write or delete that is irreversible, has an external party, is financial, or touches many records or the whole organisation | `ask`          |
   | the builder says the agent must never do it                                                                                                                                           | `deny`         |

   A read is `always_allow` as the baseline whatever its blast radius; when this agent reads many records
   automatically, say so with a tightening (below), not by raising the baseline.

   Two kinds of policy, each at most one per tool:
   - the **baseline** is the organisation's policy for the tool, for everyone (the `everyone` role). Propose it
     only for a tool that no `everyone` policy governs yet, and give it the most permissive mode the rubric
     allows for the tool in general, whoever calls it. If the tool already has an `everyone` policy, the
     deployment refuses a baseline (`baseline_exists`), so propose none.
   - the **tightening** is a policy for this agent alone. Propose it only where this agent's use is riskier than
     the result the baseline and other policies give it: for example, an agent that reads many records
     automatically where a person reads one. A tightening is never looser than the baseline.

   `--dry-run` checks the plan locally only and sends nothing. A real run first reads the policies already in force
   (`GET /v1/policies`, with the user's own `NC_PROPOSER_TOKEN`: listing policies needs no administrator) and
   refuses, exit 2 and nothing sent, a baseline for a tool an `everyone` policy already governs (`baseline_exists`)
   and a tightening for a tool this agent already has a policy for (`policy_conflict`, which an approval would
   refuse later). Drop that entry and run again. It does not compare modes, so `tightening_looser` is still answered
   by the deployment when the approval is opened; and a policy list it cannot read is reported on stderr and left
   to the deployment. So choose a baseline only for a tool the user does not know to have a policy, and let the
   script catch the rest.

   Ask the user about anything the code cannot tell you (is this system the builder's own? is a refund really
   reversible?) rather than guessing. Write each rationale as one or two plain sentences that name the rubric
   answer it rests on, for example: "Issues a refund to a customer: money leaves the organisation and cannot be
   recalled, so a person approves each one."

6. **Draft the plan and open the approval.** Write the plan to a file outside the source tree (for example
   `noblecloak-plan.json` in a scratch directory):

   ```json
   {
     "agent": { "principal_id": "<the service principal's id>" },
     "tools": [
       {
         "tool_ref": "ext:billing:issue_refund",
         "description": "Refund an order.",
         "input_schema": { "type": "object" },
         "side_effect_level": "external",
         "show_arguments_to_approvers": true
       }
     ],
     "policies": [
       {
         "role": "baseline",
         "tool": "ext:billing:issue_refund",
         "mode": "ask",
         "rationale": "Issues a refund to a customer: money leaves the organisation and cannot be recalled, so a person approves each one.",
         "assessment": {
           "side_effect_level": "external",
           "blast_radius": "one_record",
           "reversible": false,
           "external_party": true,
           "financial": true
         }
       }
     ]
   }
   ```

   `tools` lists the `ext:` tools only (`transport` is `external` and `owner_kind` is `org`, filled in for you;
   `input_schema` is the tool's JSON Schema, `{ "type": "object" }` when you have none). A `policies` entry has a
   `role` (`baseline` or `tightening`), the one `tool` it governs, its `mode`, a `rationale` (1 to 500
   characters) and the `assessment`. At most 50 tools and 50 policies; for more, propose in several plans.

   Show the user the plan, then check it without sending anything:

   ```sh
   node <this skill's directory>/scripts/propose.mjs --plan <plan.json> --dry-run
   ```

   It prints what an administrator would be asked to approve, and names every rule the plan breaks. When the
   user agrees, run it for real with `NC_BASE_URL` and the user's own `NC_PROPOSER_TOKEN` in the environment:

   ```sh
   node <this skill's directory>/scripts/propose.mjs --plan <plan.json>
   ```

   It declares the agent if `agent.json` has no id, opens the approval, and prints its id and the address of
   the approvals module (`NOBLECLOAK_APPROVALS_URL`; if it is not set, the script says so). It prints no link to
   the approval itself, because the contract defines no per-approval route: the administrator finds the approval by its id. Exit codes: 0
   opened, 2 refused (the code and the member of the proposal it names are printed; fix the plan and run again),
   3 the user token is missing, expired, or belongs to a service principal or an agent (`not_a_user`), 1 anything else. A re-run with the same plan
   finds the open approval instead of opening a second.

   Refusals you may meet: `unknown_agent` (the agent row is gone: clear `id` in `agent.json`), `principal_bound`
   (that service principal is bound to another agent), `tool_ref_in_use`, `target_unknown` (a policy names a tool
   that is neither registered nor in the plan), `baseline_exists`, `tightening_looser`, and two answers
   of 409: `rejected_duplicate` (an administrator rejected this same plan recently: change the plan, or wait out the
   window) and `continuation_conflict` (an open approval for it has another continuation).

7. **Tell the user what happens next.** An administrator opens the approval, reads the preview and approves it; the
   deployment then registers the tools, binds the service principal to the agent and publishes the policies in one
   step, or refuses all of it. The skill does not wait. Until it is approved, the agent's calls are decided by
   whatever policies the deployment already has. When a governed call needs approval, the agent pauses, the approver decides in the approvals inbox, and the
   worker resumes the agent.

## What is not here yet

- The skill does not check afterwards whether the proposal was approved and applied, or refused and why. Look at
  the approval in the inbox.
- It covers LangGraph JS only: other runtimes, and Python, are separate skills.
- It does not change an agent that already has a policy for a tool: `propose.mjs` refuses a tightening for such a
  tool (`policy_conflict`) before it opens anything, as an approval would. Change or retire the existing policy
  instead. The check reads the policies at that moment: one published between the run and the approval is refused
  by the deployment when approved.

## Check that it worked

- The project builds and type-checks with the new `src/noblecloak/` files, and starting the worker prints
  `worker_ready` (a worker run as another principal than the agent fails to start with `principal_mismatch`
  and `worker_fatal`).
- Run the agent on a call that needs approval: it pauses, with an approval waiting in the inbox. After it is
  approved the worker prints `worker_resumed` and the tool runs once.
- `propose.mjs` printed `Approval opened` (or `Approval already open`) and an approval id.
