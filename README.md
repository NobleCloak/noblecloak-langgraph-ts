# noblecloak-langgraph-ts

Approvals for [LangGraph](https://langchain-ai.github.io/langgraphjs/) JS agents: decide, pause, verify,
resume. This repository builds and tests `@noblecloak/langgraph`, the adapter that puts a LangGraph agent's
tool calls under a NobleCloak deployment's policy, with the example that proves it end to end, the skill that
sets it up in an existing project, and the tooling around them.

**Status:** private, with fresh history, until the public release. `@noblecloak/langgraph` is published on
npm. Licensed under Apache-2.0 (`LICENSE`, `NOTICE`).

## What is here

| Path                            | What it is                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `packages/langgraph/`           | `@noblecloak/langgraph`, the one published package. `createGovernance`, `runResumer` and `governanceMiddleware`.    |
| `examples/langgraph-approvals/` | A private workspace: an agent, a worker and an approver as separate processes against the mock.                     |
| `skills/langgraph/`             | The setup skill: `SKILL.md`, two scripts (`apply.mjs`, `propose.mjs`) and four templates.                           |
| `docs/how-to/`                  | [Govern a LangGraph agent](docs/how-to/govern-a-langgraph-agent.md); its code is typechecked in `docs/snippets/`.   |
| `scripts/`                      | Repository tooling: the private-dependency guard, the contract check, pack and release, the skill's acceptance run. |
| `contract.json`                 | The record of the two contract packages the adapter is built against; both install from the public npm registry.    |

## Try it

You need [Bun](https://bun.sh) (the version in `package.json`) and Node (`.node-version`). No account or token is
needed to install (see [Contract packages](#contract-packages)).

```sh
bun install --frozen-lockfile
bun run build
bun run --cwd examples/langgraph-approvals start --middleware
```

The example starts its own mock deployment, registers a refund tool that needs approval, runs the agent until it
pauses, approves as a person, and shows the worker resuming it: the refund happens once, after the approval.
The example itself needs no account and no credentials. The guide is
[Govern a LangGraph agent](docs/how-to/govern-a-langgraph-agent.md); the adapter's own README is
[packages/langgraph/README.md](packages/langgraph/README.md).

## The gate

```sh
bun run gate           # format:check, lint, typecheck and test through turbo, then build
bun run guard          # no path or git dependency, no registry mapping, no token, Apache-2.0 everywhere
bun run exercise:skill # the skill's acceptance run: pack the adapter, apply the skill to a scaffold, run it on the mock
```

[CONTRIBUTING.md](CONTRIBUTING.md) has the rules, the contract packages, packing and releasing.

## Contract packages

The adapter depends on `@noblecloak/client` and is tested against the mock in `@noblecloak/spec`. Both install
by exact version from the public npm registry (registry.npmjs.org), like every other dependency: the repository
maps no scope to another registry and needs no token. `contract.json` names the pair and
`scripts/contract.test.ts` keeps it the same everywhere it is named.

## Related

- [`noblecloak-ts`](https://github.com/NobleCloak/noblecloak-ts): the contract packages (`@noblecloak/client`,
  `@noblecloak/spec`) and the other NobleCloak packages.
- [`noblecloak-langgraph-py`](https://github.com/NobleCloak/noblecloak-langgraph-py): the Python counterpart,
  reserved and without code.
