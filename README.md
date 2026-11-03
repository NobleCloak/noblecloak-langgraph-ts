# noblecloak-langgraph-ts

Approvals for [LangGraph](https://langchain-ai.github.io/langgraphjs/) JS agents: decide, pause, verify,
resume. This repository builds and tests `@noblecloak/langgraph`, the adapter that puts a LangGraph agent's
tool calls under a NobleCloak deployment's policy, with the example that proves it end to end, the skill that
sets it up in an existing project, and the tooling around them.

**Status:** private, with fresh history, until the public release. `@noblecloak/langgraph` is at 0.3.9 and
nothing is published from this repository yet. Licensed under Apache-2.0 (`LICENSE`, `NOTICE`).

## What is here

| Path                            | What it is                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `packages/langgraph/`           | `@noblecloak/langgraph`, the one published package. `createGovernance`, `runResumer` and `governanceMiddleware`.    |
| `examples/langgraph-approvals/` | A private workspace: an agent, a worker and an approver as separate processes against the mock.                     |
| `skills/langgraph/`             | The setup skill: `SKILL.md`, two scripts (`apply.mjs`, `propose.mjs`) and four templates.                           |
| `docs/how-to/`                  | [Govern a LangGraph agent](docs/how-to/govern-a-langgraph-agent.md); its code is typechecked in `docs/snippets/`.   |
| `scripts/`                      | Repository tooling: the private-dependency guard, the contract check, pack and release, the skill's acceptance run. |
| `contract.json`, `.npmrc`       | The record of the two contract packages the adapter is built against, and the registry mapping they install from.   |

## Try it

You need [Bun](https://bun.sh) (the version in `package.json`), Node (`.node-version`), and read access to the
NobleCloak organisation's packages on GitHub (see [Contract packages](#contract-packages)).

```sh
export NODE_AUTH_TOKEN=<a GitHub token with read:packages>
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
bun run guard          # no path or git dependency, one registry mapping, no literal token, Apache-2.0 everywhere
bun run exercise:skill # the skill's acceptance run: pack the adapter, apply the skill to a scaffold, run it on the mock
```

[CONTRIBUTING.md](CONTRIBUTING.md) has the rules, the contract packages, packing and releasing.

## Contract packages

The adapter depends on `@noblecloak/client` and is tested against the mock in `@noblecloak/spec`. Both install
by exact version from the NobleCloak organisation's package registry on GitHub Packages, which the root `.npmrc`
maps the `@noblecloak` scope to. That file holds no token: it reads one from `NODE_AUTH_TOKEN`. Locally, set
that variable to a personal GitHub token with the `read:packages` scope (for example
`NODE_AUTH_TOKEN="$(gh auth token)"` when your `gh` login has that scope); keep the token in your environment,
never in the repository. CI hands the job token to each install. `contract.json` names the pair and
`scripts/contract.test.ts` keeps it the same everywhere it is named.

## Related

- [`noblecloak-ts`](https://github.com/NobleCloak/noblecloak-ts): the contract packages (`@noblecloak/client`,
  `@noblecloak/spec`) and the other NobleCloak packages.
- [`noblecloak-langgraph-py`](https://github.com/NobleCloak/noblecloak-langgraph-py): the Python counterpart,
  reserved and without code.
