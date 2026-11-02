/**
 * What the langgraph skill's acceptance run (`skill-exercise-agent.ts`) and its test (`skill-langgraph.test.ts`)
 * share: running a command, writing the wall-time report, listing a template tree and choosing the tarballs the
 * scaffolded project installs. `run`, `settleReport` and `listTemplateFiles` are copied from the spec
 * repository's `skill-exercise.ts` at 0620a1d; the tarball helpers are new here. The two repositories are not
 * kept in step.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';

import { listPublicPackages } from './workspace.js';

export function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {}
): void {
  const result = spawnSync(command, [...args], {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...env },
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

/** A tarball the project installs, and where this run copies it from. */
export interface TarballSource {
  readonly name: string;
  /** The file name `apply.mjs --source` looks for (`noblecloak-<package>-<version>.tgz`). */
  readonly file: string;
  /** Absolute path of the tarball to copy. */
  readonly from: string;
}

/**
 * The `file:` pin the root `overrides` give a contract package, as an absolute path (`file:./vendor/x.tgz`), or
 * undefined when the root pins that package otherwise.
 */
export function overriddenTarball(root: string, name: string): string | undefined {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    overrides?: Record<string, string>;
  };
  const spec = manifest.overrides?.[name];
  return spec?.startsWith('file:') === true ? resolve(root, spec.slice('file:'.length)) : undefined;
}

/**
 * The tarballs the skill installs, sorted by name: `rootPackage` as `pack:all` packed it into `artifacts/`, and
 * each other `@noblecloak/*` entry in its `dependencies` as the tarball the root `overrides` pin it to (the
 * vendored contract package). A dependency with no such pin throws, because there is nothing to install it from.
 */
export function tarballSources(root: string, rootPackage: string): TarballSource[] {
  const pkg = listPublicPackages(root).find((candidate) => candidate.name === rootPackage);
  if (pkg === undefined) throw new Error(`${rootPackage} is not a public workspace package`);
  const manifest = JSON.parse(readFileSync(join(pkg.dir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const sources: TarballSource[] = [
    {
      name: pkg.name,
      file: tarballFile(pkg.name, pkg.version),
      from: join(root, 'artifacts', tarballFile(pkg.name, pkg.version)),
    },
  ];
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    if (!dependency.startsWith('@noblecloak/')) continue;
    const from = overriddenTarball(root, dependency);
    if (from === undefined)
      throw new Error(
        `${dependency} has no file: pin in the root overrides; nothing to install it from`
      );
    sources.push({ name: dependency, file: from.slice(from.lastIndexOf('/') + 1), from });
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

/**
 * Rewrites, in place, the `file:` ranges a packed tarball declares for the contract packages to their exact
 * versions, which is what a tarball built against registry versions carries. A `file:../../vendor/...` range
 * points into this repository, and `bun add` of the tarball fails on it from a project outside. Any other
 * dependency is left as packed. Returns the names it rewrote.
 */
export function pinContractDependencies(
  tarball: string,
  versions: Readonly<Record<string, string>>
): string[] {
  const staging = mkdtempSync(join(tmpdir(), 'repin-'));
  try {
    run('tar', ['xzf', tarball, '-C', staging], staging);
    const file = join(staging, 'package', 'package.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const rewritten: string[] = [];
    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      const version = versions[name];
      if (version !== undefined && range.startsWith('file:')) {
        manifest.dependencies = { ...manifest.dependencies, [name]: version };
        rewritten.push(name);
      }
    }
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    run('tar', ['czf', tarball, '-C', staging, 'package'], staging);
    return rewritten;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
