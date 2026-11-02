/**
 * Publishes the tarballs in `artifacts/` (left there by `pack-all.ts`) as they are: it packs, installs and builds
 * nothing, and imports only Node built-ins and the sibling scripts, so it runs without `node_modules`.
 *
 *   bun --no-install scripts/release.ts [--registry <url>]
 *
 * `--registry` is one of two values; any other value, and any other argument, is refused.
 *
 * - Absent, or `https://registry.npmjs.org`: publishes to npm with
 *   `--registry https://registry.npmjs.org --@noblecloak:registry=https://registry.npmjs.org --provenance --access public`.
 *   Every `npm view` and `npm publish` carries both registry flags, because an `@noblecloak:registry` mapping in
 *   an `.npmrc` beats `--registry` for a scoped package and only the scope flag beats that mapping. npm trusted
 *   publishing is configured per existing package, so a package that has never been published (`npm view` → 404)
 *   is skipped with a warning: its first publish is a manual maintainer step. On this registry the script never
 *   reads or uses a token. There is no name allowlist on this registry.
 * - `https://npm.pkg.github.com`: refuses an empty `NODE_AUTH_TOKEN` (it only checks that the variable is set;
 *   `npm` reads it from its own configuration); publishes only the names in
 *   `GITHUB_ALLOWLIST` and skips any other tarball with a printed line; a package the registry answers 404 for
 *   is published, a version it already has is skipped, and any other answer from the registry stops the run;
 *   publishes with both registry flags and with neither `--provenance` nor `--access` (GitHub Packages gives a
 *   package the visibility of the repository it is linked to).
 *
 * Before publishing anything it checks every package it will publish against the internal (`@noblecloak/*` or
 * workspace) entries in the `dependencies` and `peerDependencies` of the package.json inside that package's
 * tarball, where `bun pm pack` has already rewritten `workspace:` ranges. Each such entry must be an exact
 * version that the registry already has, or that this run publishes. A `file:` range is not an exact version, so
 * a tarball packed while the contract packages are vendored cannot be published. Any failure publishes nothing and
 * exits 1; an unseeded dependency is one of those failures, not a warning. Packages are then published
 * dependencies first, and the run stops at the first failed publish, so a dependent never goes live ahead of its
 * dependency.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { listTarEntries, runCommand, verifyTarballs } from './pack-all.js';
import type { EntryLister, Runner } from './pack-all.js';
import { listPublicPackages } from './workspace.js';
import type { WorkspacePackage } from './workspace.js';

export const NPM_REGISTRY = 'https://registry.npmjs.org';
export const GITHUB_REGISTRY = 'https://npm.pkg.github.com';

/** The only names published to the GitHub registry; any other public package's tarball is skipped there. */
export const GITHUB_ALLOWLIST: readonly string[] = ['@noblecloak/langgraph'];

/**
 * The registry a command line names: `--registry <url>` with one of the two registries above, npm when the flag
 * is absent. Throws on any other value, a flag without a value, and any other argument.
 */
export function parseRegistry(args: readonly string[]): string {
  if (args.length === 0) return NPM_REGISTRY;
  const [flag, value, ...rest] = args;
  if (flag !== '--registry' || rest.length > 0)
    throw new Error(`unknown arguments: ${args.join(' ')}; the only option is --registry <url>`);
  if (value === NPM_REGISTRY || value === GITHUB_REGISTRY) return value;
  throw new Error(
    `--registry takes ${NPM_REGISTRY} or ${GITHUB_REGISTRY}, not ${value ?? '(nothing)'}`
  );
}

export type RegistryState =
  | { readonly kind: 'not-found' }
  | { readonly kind: 'versions'; readonly versions: readonly string[] };

export type Decision = 'publish' | 'skip-not-seeded' | 'skip-already-published';

/**
 * What to do with one package version. A package the registry has never seen is skipped on npm (its first publish
 * is manual) and published on the GitHub registry (which has no manual seed).
 */
export function decide(
  version: string,
  state: RegistryState,
  registry: string = NPM_REGISTRY
): Decision {
  if (state.kind === 'not-found')
    return registry === GITHUB_REGISTRY ? 'publish' : 'skip-not-seeded';
  return state.versions.includes(version) ? 'skip-already-published' : 'publish';
}

/** Parses `npm view <name> versions --json`. A 404 is `not-found`; any other failure throws. */
export function parseNpmView(status: number, stdout: string, stderr: string): RegistryState {
  if (status !== 0) {
    if (stdout.includes('E404') || stderr.includes('E404')) return { kind: 'not-found' };
    throw new Error(`npm view failed (exit ${String(status)}): ${stderr.trim()}`);
  }
  const parsed: unknown = JSON.parse(stdout);
  const versions = Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
  return { kind: 'versions', versions };
}

export type RegistryLookup = (name: string) => RegistryState;

/** The flags that pin an npm call on a `@noblecloak/*` package to `registry`, over any `.npmrc` scope mapping. */
export function registryFlags(registry: string): string[] {
  return ['--registry', registry, `--@noblecloak:registry=${registry}`];
}

/** The result of one `npm` call, as far as `npmView` reads it. */
export type NpmSpawn = (args: readonly string[]) => {
  status: number | null;
  stdout: string;
  stderr: string;
};

const spawnNpm: NpmSpawn = (args) => spawnSync('npm', [...args], { encoding: 'utf8' });

/** Looks a package up on `registry` with the `npm` on the path (or `spawn`). */
export function npmView(registry: string, spawn: NpmSpawn = spawnNpm): RegistryLookup {
  return (name) => {
    const result = spawn(['view', name, 'versions', '--json', ...registryFlags(registry)]);
    return parseNpmView(result.status ?? 1, result.stdout, result.stderr);
  };
}

export function tarballFor(pkg: WorkspacePackage, tarballs: readonly string[]): string {
  const base = pkg.name.replace(/^@/, '').replace('/', '-');
  const match = tarballs.find((t) => t.endsWith(`/${base}-${pkg.version}.tgz`));
  if (match === undefined) throw new Error(`no packed tarball for ${pkg.name}@${pkg.version}`);
  return match;
}

/** The `dependencies` and `peerDependencies` a tarball's package.json declares. */
export interface PackedManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

/** Reads `package/package.json` out of a packed tarball. */
export type ManifestReader = (tarball: string) => PackedManifest;

export const readPackedManifest: ManifestReader = (tarball) => {
  const result = spawnSync('tar', ['xzOf', tarball, 'package/package.json'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`tar xzOf failed for ${tarball}: ${result.stderr}`);
  return JSON.parse(result.stdout) as PackedManifest;
};

const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/** A dependency on another package this repository publishes. */
export interface InternalDependency {
  readonly name: string;
  readonly range: string;
}

/**
 * The internal entries of a packed manifest's `dependencies` and `peerDependencies`: any `@noblecloak/*` name,
 * plus any other name this repository publishes.
 */
export function internalDependencies(
  manifest: PackedManifest,
  workspaceNames: ReadonlySet<string>
): InternalDependency[] {
  return [manifest.dependencies, manifest.peerDependencies].flatMap((block) =>
    Object.entries(block ?? {})
      .filter(([name]) => name.startsWith('@noblecloak/') || workspaceNames.has(name))
      .map(([name, range]) => ({ name, range }))
  );
}

/** A package this run publishes, with the internal dependencies its tarball declares. */
export interface PublishCandidate {
  readonly name: string;
  readonly version: string;
  readonly dependencies: readonly InternalDependency[];
}

/**
 * The problems that stop the run, one line per unmet dependency. A dependency is met when its range is an exact
 * version that the registry already has, or that a candidate publishes in this run at exactly that version.
 * `label` names the registry in the messages.
 */
export function unmetDependencies(
  candidates: readonly PublishCandidate[],
  registry: (name: string) => RegistryState,
  label = 'npm'
): string[] {
  const publishing = new Map(candidates.map((c) => [c.name, c.version]));
  const problems: string[] = [];
  for (const candidate of candidates) {
    const who = `${candidate.name}@${candidate.version}`;
    for (const dep of candidate.dependencies) {
      if (!EXACT_VERSION.test(dep.range)) {
        problems.push(
          `${who} depends on ${dep.name}@${dep.range}, which is not an exact version; the packed tarball must pin it.`
        );
        continue;
      }
      if (publishing.get(dep.name) === dep.range) continue;
      const state = registry(dep.name);
      if (state.kind === 'versions' && state.versions.includes(dep.range)) continue;
      const where =
        state.kind === 'not-found'
          ? `${dep.name} is not on ${label} yet`
          : `${label} has no ${dep.name}@${dep.range}`;
      const queued = publishing.get(dep.name);
      const run =
        queued === undefined
          ? 'and this run does not publish it'
          : `and this run publishes ${dep.name}@${queued}`;
      problems.push(
        `${who} depends on ${dep.name}@${dep.range}, but ${where} ${run}. Publish ${dep.name}@${dep.range} to ${label} first, or in the same release.`
      );
    }
  }
  return problems;
}

/**
 * Orders candidates so each comes after the candidates it depends on, keeping the input order
 * otherwise. Throws on a dependency cycle.
 */
export function publishOrder<T extends PublishCandidate>(candidates: readonly T[]): T[] {
  const names = new Set(candidates.map((c) => c.name));
  const ordered: T[] = [];
  const placed = new Set<string>();
  let remaining = [...candidates];
  while (remaining.length > 0) {
    const next = remaining.find((c) =>
      c.dependencies.every((d) => !names.has(d.name) || d.name === c.name || placed.has(d.name))
    );
    if (next === undefined) {
      throw new Error(`dependency cycle among ${remaining.map((c) => c.name).join(', ')}`);
    }
    ordered.push(next);
    placed.add(next.name);
    remaining = remaining.filter((c) => c !== next);
  }
  return ordered;
}

/**
 * `lookup` has no default: the caller builds it from the same `registry` (`main` does), so a lookup can never
 * silently name a different registry from the publish.
 */
export function release(
  root: string,
  out: (line: string) => void,
  lookup: RegistryLookup,
  run: Runner = runCommand,
  list: EntryLister = listTarEntries,
  readManifest: ManifestReader = readPackedManifest,
  registry: string = NPM_REGISTRY,
  env: NodeJS.ProcessEnv = process.env
): number {
  const github = registry === GITHUB_REGISTRY;
  const label = github ? 'the GitHub registry' : 'npm';
  if (github && (env.NODE_AUTH_TOKEN ?? '') === '') {
    out(
      `::error::NODE_AUTH_TOKEN is empty; publishing to ${registry} needs it. Nothing was published.`
    );
    return 1;
  }
  const tarballs = verifyTarballs(join(root, 'artifacts'), list);
  const packages = listPublicPackages(root);
  const workspaceNames = new Set(packages.map((pkg) => pkg.name));
  const states = new Map<string, RegistryState>();
  const known = (name: string): RegistryState => {
    const cached = states.get(name);
    if (cached !== undefined) return cached;
    const state = lookup(name);
    states.set(name, state);
    return state;
  };

  const candidates: (PublishCandidate & { readonly tarball: string })[] = [];
  for (const pkg of packages) {
    if (github && !GITHUB_ALLOWLIST.includes(pkg.name)) {
      out(`${pkg.name}@${pkg.version} is not on the allowlist for ${registry}; skipped.`);
      continue;
    }
    const decision = decide(pkg.version, known(pkg.name), registry);
    if (decision === 'skip-not-seeded') {
      out(`::warning::${pkg.name} is not on npm yet; skipped. Its first publish is manual.`);
    } else if (decision === 'skip-already-published') {
      out(`${pkg.name}@${pkg.version} already published; skipped.`);
    } else {
      const tarball = tarballFor(pkg, tarballs);
      const dependencies = internalDependencies(readManifest(tarball), workspaceNames);
      candidates.push({ name: pkg.name, version: pkg.version, dependencies, tarball });
    }
  }

  const problems = unmetDependencies(candidates, known, label);
  if (problems.length > 0) {
    for (const problem of problems) out(`::error::${problem}`);
    out('::error::Nothing was published.');
    return 1;
  }

  const ordered = publishOrder(candidates);
  for (const [index, candidate] of ordered.entries()) {
    const status = run(
      'npm',
      github
        ? ['publish', candidate.tarball, ...registryFlags(registry)]
        : [
            'publish',
            candidate.tarball,
            ...registryFlags(registry),
            '--provenance',
            '--access',
            'public',
          ],
      root
    );
    if (status === 0) {
      out(`published ${candidate.name}@${candidate.version}`);
      continue;
    }
    out(`::error::npm publish failed for ${candidate.name}@${candidate.version}`);
    const rest = ordered.slice(index + 1).map((c) => `${c.name}@${c.version}`);
    if (rest.length > 0) {
      out(
        `::error::Stopped before ${rest.join(', ')}; a rerun publishes what ${label} does not have.`
      );
    }
    return 1;
  }
  return 0;
}

/** What `main` reaches outside the process; tests replace it. */
export interface MainDeps {
  readonly cwd: string;
  readonly out: (line: string) => void;
  readonly spawn?: NpmSpawn;
  readonly run?: Runner;
  readonly list?: EntryLister;
  readonly readManifest?: ManifestReader;
}

/** The command line: parses `argv`, builds the lookup from the parsed registry, and returns the exit code. */
export function main(argv: readonly string[], env: NodeJS.ProcessEnv, deps: MainDeps): number {
  let registry: string;
  try {
    registry = parseRegistry(argv);
  } catch (error) {
    deps.out(`::error::${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  return release(
    deps.cwd,
    deps.out,
    npmView(registry, deps.spawn),
    deps.run,
    deps.list,
    deps.readManifest,
    registry,
    env
  );
}

if (import.meta.main) {
  process.exit(
    main(process.argv.slice(2), process.env, {
      cwd: process.cwd(),
      out: (line) => {
        console.log(line);
      },
    })
  );
}
