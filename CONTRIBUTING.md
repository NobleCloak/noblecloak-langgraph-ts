# Contributing to NobleCloak LangGraph adapter (TypeScript)

## Developer Certificate of Origin

Every commit must be signed off under the [Developer Certificate of Origin](https://developercertificate.org/):

```
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds the line. There is no CLA.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat(langgraph): …`, `fix(example): …`,
`chore: …`, `docs: …`.

## Changesets

A change to `packages/langgraph`, the one publishable package, needs a changeset. Run `bun run changeset`,
select the package and the bump, and commit the generated `.changeset/*.md` with your change. The example,
the docs snippets and the tooling workspace are private and not versioned. `.changeset/config.json` says
`access: restricted` while the repository is private; the publish scripts below do not read it.

## Local gate

Run these before you open a pull request:

```sh
bun install --frozen-lockfile   # needs no token; see "The contract packages"
bun run gate      # turbo run format:check lint typecheck test, then build
bun run guard     # no path or git dependencies, no registry mapping, no token, Apache-2.0 everywhere
bun run exercise:skill   # the setup skill's acceptance run against the mock (installs the packed adapter and the client from npm)
```

`bun install` also points git at `.githooks/` (the root `prepare` script sets `core.hooksPath`), whose
`pre-commit` hook runs `bun run guard`, so a private dependency is caught before it is committed.

Always use `bun run test`, never `bun test`: every package runs vitest with coverage, and each package fails
below 80% lines, functions, branches or statements.

## The contract packages

The adapter is built against `@noblecloak/client` and `@noblecloak/spec` (the mock and the conformance
suite). Both install by exact version from the public npm registry (registry.npmjs.org), like every other
dependency. The repository has no `.npmrc` and maps no scope to another registry, so installing needs no token,
locally or in CI, and `bun.lock` records the packages with no URL. If your own `~/.npmrc` still maps
`@noblecloak` to GitHub Packages (older instructions did), remove that mapping and its token line. A version must be on npm before a manifest can name it, and `scripts/release.ts` refuses a tarball whose
`@noblecloak/*` dependency npm does not have (see below).

`contract.json` records the pair (`"phase": "registry"`, the two versions, and the contract revision they
implement as the label `contractRevision`). The adapter, the example and the docs snippets name each package at
exactly that version; the root manifest names neither and nothing has `overrides`. `scripts/contract.test.ts`
fails when `contract.json`, those manifests and the installed versions disagree, when a manifest has an
`overrides` or `resolutions` block or a `file:`/`link:` dependency, or when a `vendor/` directory exists.

To move to a new pair: change the two versions (and the revision label) in `contract.json`, change the same
versions in the manifests that name them, and run `bun install` to rewrite `bun.lock`.

## Packing and releasing

`bun run pack:all` packs every public workspace package into `artifacts/` and checks each tarball carries
`LICENSE` and `NOTICE`. `bun run release` (`scripts/release.ts`) publishes those tarballs as they are:

- With no argument it publishes to npm with `--provenance` and no token (npm trusted publishing), and skips a
  package npm has never seen, because the first publish of a package is manual. The skipped package's tarball
  gets the dependency check below too, so the release run fails rather than going green over a seed that names
  a version npm lacks. That check does not run on a hand-run `npm publish`; see the next item.
- `bun run release:check -- [<tarball-or-directory> ...]` runs the same dependency check against npm for the
  named tarballs (default `artifacts/`) and publishes nothing; it exits 1 when a `@noblecloak/*` dependency is
  not an exact version npm has. **Run it on the packed tarball before any manual first publish (seed) and publish
  only on exit 0.** Nothing enforces that step: it is a maintainer's check, because `npm publish` run by hand
  never executes `scripts/release.ts`.
- With `--registry https://npm.pkg.github.com` it needs a non-empty `NODE_AUTH_TOKEN`, publishes only
  `@noblecloak/langgraph` (it skips any other public package with a printed line), publishes a package the
  registry answers 404 for, skips a version the registry has, and stops on any other answer.
- It reads each tarball's `package.json` first and refuses to publish anything when a `@noblecloak/*`
  dependency is not an exact version the registry has, or this run publishes. The adapter's tarball names the
  client at the exact version `contract.json` records. On npm this covers a package skipped as not yet seeded.
- Any other `--registry` value, and any other argument, is refused.

## CI and publishing

`.github/workflows/ci.yml` runs on every pull request and every push to `main`, on two runners with no matrix:
`gate` (`bun install --frozen-lockfile`, `bun run gate`, `bun run guard`, actionlint) and `skill / langgraph` (the
setup skill's acceptance run, `bun run exercise:skill`, which needs Node only). Both hold `contents: read` and
nothing else: the install and the acceptance run (which fetches the client tarball with `npm pack`) read public
npm and are handed no token.

`.github/workflows/publish.yml` runs on every `main` push and every `v*` tag. `publish pack` builds and packs the
tarballs as the `npm-packages` artifact and holds `contents: read` only. `publish version` holds write scopes, so
it installs with `--ignore-scripts` and no dependency lifecycle script runs in it.
`publish version` opens or updates the Changesets version pull request
and publishes nothing; it is opened with `github.token`, so no `pull_request` workflow runs on it until a
maintainer closes and reopens it. Every job that holds a write scope checks out with
`persist-credentials: false`, so `github.token` is not left in `.git/config` while dependencies install; the
`changesets/action` step is handed the token explicitly. Two publish jobs follow, each off until its repository variable is set:

- `publish github-packages` runs when the repository is owned by `NobleCloak` and `PRIVATE_PUBLISH_ENABLED` is
  `true`. It runs `scripts/release.ts --registry https://npm.pkg.github.com` with the run's `github.token`.
- `publish npm` runs when `PUBLIC_RELEASE_ENABLED` is `true`, through npm trusted publishing and the
  `npm-publish` environment, with no token. It stays off until the package is released publicly.

Neither publish job installs or builds anything: each downloads the packed artifact and publishes those exact
tarballs, so no package from the lockfile runs where a publish credential exists. No workflow reads the
`secrets` context. The `version` job is the only job in any workflow with `contents` or `pull-requests` write.
The `publish npm` job alone holds `id-token: write`, and the `publish github-packages` job alone holds
`packages: write`. Every workflow's top-level `permissions` is exactly `contents: read`, and no job uses a string
block such as `write-all`. `scripts/repo-policy.test.ts` asserts these properties and that every action is pinned
to a full commit SHA with a version comment.

Nothing runs on GitHub until this tree is pushed to a repository that exists.

## Rules the tree enforces

- No dependency from a URL, a git or `github:` source, or a `file:`/`link:` path, and no registry other than
  `registry.npmjs.org` in `.npmrc`, `bunfig.toml`, `bun.lock` or `publishConfig`. No scope is mapped to a
  registry, and no `.npmrc` or `bunfig.toml` holds an auth line (a token, a password or a username).
  `bun run guard` checks it.
- Every `package.json` declares `"license": "Apache-2.0"` and `"author": "NobleCloak"`.
- No `any`. Type-only imports use `import type`. Relative imports end in `.js`.
- Dependencies are pinned to exact versions, except the adapter's peer ranges. Dependabot opens grouped pull
  requests, minor and patch together and majors together, monthly and at most three at a time
  (`.github/dependabot.yml`); a security fix or a superseding pull
  request may bump by hand, regenerating `bun.lock` with `bun install`. Dependabot does not move the bun
  version (`packageManager`) or the Node version (`.node-version`); bump those by hand.

## Toolchain pins

Two majors are held back from their latest release. Each entry names what holds it back and when to lift it.

- **`typescript` 6.x**, at its latest release. `typescript-eslint` (and its
  `@typescript-eslint/typescript-estree`) declare a `typescript` peer range that stops short of 7, so the
  linter does not support TypeScript 7. The whole repository uses one TypeScript version; 6 and 7 are never
  mixed. **Lift when** a `typescript-eslint` release widens that range: move `typescript` to 7.x and delete
  the `typescript` entry from `ignore:` in `.github/dependabot.yml`. Upstream tracking issue:
  [typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940).
- **`@types/node` 24.x** tracks the Node line in `.node-version` (24), so the types describe the runtime the
  repository uses. A newer major describes APIs the pinned Node does not have. **Lift when**
  `.node-version` moves to a new LTS line: bump both in the same pull request and delete the `@types/node`
  entry from `ignore:` in `.github/dependabot.yml`.
