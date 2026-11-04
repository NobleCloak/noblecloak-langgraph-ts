/**
 * What the langgraph skill's acceptance run (`skill-exercise-agent.ts`) and its test (`skill-langgraph.test.ts`)
 * share: running a command, writing the wall-time report, listing a template tree and choosing and collecting
 * the tarballs the scaffolded project installs. `run`, `settleReport` and `listTemplateFiles` are copied from the
 * spec repository's `skill-exercise.ts` at 0620a1d; the tarball helpers are new here. The two repositories are
 * not kept in step.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';

import { NPM_REGISTRY, registryFlags } from './release.js';
import { listPublicPackages } from './workspace.js';

/** The variable npm and bun read a registry token from. No command of the skill run needs one. */
export const REGISTRY_TOKEN = 'NODE_AUTH_TOKEN';

/** `env` without the registry token variable. */
export function withoutRegistryToken(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => name !== REGISTRY_TOKEN));
}

/**
 * Runs a command with our environment minus the registry token variable, plus `env`: a job token set for an
 * earlier step never reaches a child of the skill run.
 */
export function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {}
): void {
  const result = spawnSync(command, [...args], {
    cwd,
    stdio: 'inherit',
    env: { ...withoutRegistryToken(process.env), ...env },
  });
  if (result.status !== 0) {
    // A command that never started (ENOENT, EACCES) has no exit status; its error says why.
    const why = result.error === undefined ? '' : `: ${result.error.message}`;
    throw new Error(
      `${command} ${args.join(' ')} failed (exit ${String(result.status)}) in ${cwd}${why}`
    );
  }
}

/**
 * Writes the wall-time report. On a run whose step failed, a report that cannot be written is said on stderr and
 * the step's error stays the one that ends the run; on a run whose steps passed, it is the error.
 */
export function settleReport(write: () => void, failed: boolean): void {
  try {
    write();
  } catch (error) {
    if (!failed) throw error;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`The wall-time report could not be written either: ${message}`);
  }
}

export function listTemplateFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => posix.relative(dir, posix.join(entry.parentPath, entry.name)))
    .sort();
}

/** The file name `bun pm pack` gives a package: `@scope/name` at `1.2.3` is `scope-name-1.2.3.tgz`. */
export function tarballFile(name: string, version: string): string {
  return `${name.replace('@', '').replace('/', '-')}-${version}.tgz`;
}

/**
 * A tarball the project installs: the package `pack:all` packed into `artifacts/`, or a contract package this run
 * fetches from the public npm registry at the version `contract.json` records.
 */
export type TarballSource =
  | {
      readonly kind: 'packed';
      readonly name: string;
      /** The file name `apply.mjs --source` looks for (`noblecloak-<package>-<version>.tgz`). */
      readonly file: string;
      /** Absolute path of the tarball to copy. */
      readonly from: string;
    }
  | {
      readonly kind: 'registry';
      readonly name: string;
      readonly file: string;
      readonly version: string;
    };

/**
 * The tarballs the skill installs, sorted by name: `rootPackage` as `pack:all` packed it into `artifacts/`, and
 * each other `@noblecloak/*` entry in its `dependencies` from the registry, at the version `contract.json` records.
 * A dependency that `contract.json` does not record, or that the manifest names at another version, throws:
 * the tarball the project installs would not be the one the adapter declares.
 */
export function tarballSources(root: string, rootPackage: string): TarballSource[] {
  const pkg = listPublicPackages(root).find((candidate) => candidate.name === rootPackage);
  if (pkg === undefined) throw new Error(`${rootPackage} is not a public workspace package`);
  const manifest = JSON.parse(readFileSync(join(pkg.dir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const versions = contractVersions(root);
  const sources: TarballSource[] = [
    {
      kind: 'packed',
      name: pkg.name,
      file: tarballFile(pkg.name, pkg.version),
      from: join(root, 'artifacts', tarballFile(pkg.name, pkg.version)),
    },
  ];
  for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
    if (!dependency.startsWith('@noblecloak/')) continue;
    const version = versions[dependency];
    if (version === undefined)
      throw new Error(`${dependency} is not in contract.json; nothing to install it from`);
    if (range !== version)
      throw new Error(
        `${rootPackage} names ${dependency}@${range}, but contract.json records ${version}`
      );
    sources.push({
      kind: 'registry',
      name: dependency,
      file: tarballFile(dependency, version),
      version,
    });
  }
  return sources.sort((a, b) => a.name.localeCompare(b.name));
}

/** The versions `contract.json` records for the contract packages, by package name. */
export function contractVersions(root: string): Record<string, string> {
  const contract = JSON.parse(readFileSync(join(root, 'contract.json'), 'utf8')) as {
    packages: Record<string, { version: string }>;
  };
  return Object.fromEntries(
    Object.entries(contract.packages).map(([name, entry]) => [name, entry.version])
  );
}

/** Runs a command in a directory with extra environment; `run` above, or a stand-in in a test. */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv
) => void;

/**
 * Puts each source's tarball in `dir` under the name `apply.mjs --source` looks for: a packed one is copied, a
 * registry one is fetched with `npm pack <name>@<version>` from the public npm registry, which needs no token.
 * Throws when a fetch leaves no such file.
 */
export function collectTarballs(
  root: string,
  sources: readonly TarballSource[],
  dir: string,
  runner: CommandRunner = run
): void {
  for (const source of sources) {
    if (source.kind === 'packed') {
      cpSync(source.from, join(dir, source.file));
      continue;
    }
    runner(
      'npm',
      [
        'pack',
        `${source.name}@${source.version}`,
        '--pack-destination',
        dir,
        ...registryFlags(NPM_REGISTRY),
      ],
      root,
      {}
    );
    if (!existsSync(join(dir, source.file)))
      throw new Error(`npm pack ${source.name}@${source.version} left no ${source.file} in ${dir}`);
  }
}
