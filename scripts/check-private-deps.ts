/**
 * Private-dependency guard. Walks every package.json, .npmrc, bunfig.toml and bun.lock in the tree
 * and fails when the tree could not be installed or published by a stranger from the public npm
 * registry. It names no scope: a private package is caught by where it resolves from.
 *
 * - a dependency (any of the four dependency fields, including npm: aliases) whose specifier is not a
 *   registry version or range: a URL other than `registry.npmjs.org`, a git or `github:` shorthand, or a
 *   `file:`/`link:` path that leaves the tree (the contract pair is vendored as `file:` tarballs under
 *   `vendor/`, held by `contract.json`, and a path inside the tree installs for anyone);
 * - a bun.lock line that resolves from anywhere but `registry.npmjs.org` (a tarball or git URL);
 * - a URL other than `registry.npmjs.org` in an .npmrc or bunfig.toml (`registry=`, a scope mapping) or in
 *   `publishConfig.registry`;
 * - an npm auth token line in an .npmrc;
 * - a package.json whose `license` is not `Apache-2.0`.
 *
 * Run with `bun run guard`. Exit code 1 and one line per violation (`file: key — reason`).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

export type ViolationKind =
  | 'foreign-source-dependency'
  | 'foreign-registry'
  | 'npm-auth-token'
  | 'missing-apache-license'
  | 'unreadable-package-json';

export interface Violation {
  /** Path relative to the scanned root, with forward slashes. */
  readonly file: string;
  /** The offending key (`devDependencies.some-package`, `license`) or `line N`. */
  readonly key: string;
  readonly kind: ViolationKind;
}

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '.turbo',
  '.next',
  '.astro',
  'storybook-static',
  'artifacts',
]);

const AUTH_LINE = /_auth(Token)?\s*=/;

/** Any `scheme://host` in a line; the host decides whether it is the public registry. */
const URL_IN_LINE = /\b[a-z][a-z+.-]*:\/\/([^\s/"'\\]+)/gi;

/** The one host a dependency, a lockfile entry or a registry setting may resolve from. */
const isPublicRegistryHost = (host: string): boolean => host.toLowerCase() === 'registry.npmjs.org';

/** True when `line` holds a URL whose host is not the public npm registry. */
function hasForeignUrl(line: string): boolean {
  return [...line.matchAll(URL_IN_LINE)].some((match) => !isPublicRegistryHost(match[1] ?? ''));
}

/** A dependency specifier or lockfile source that does not come from the registry by name and version. */
const NON_REGISTRY_SOURCE = /(?:^|["@\s])(?:github|gitlab|bitbucket|git\+[a-z]+|git):/i;

/** A `file:` or `link:` specifier: allowed only when its path stays inside the scanned tree. */
const LOCAL_PATH_SOURCE = /^(?:file|link):(.*)$/i;

/** A bare `owner/repo` (optionally `#ref`) is npm's GitHub shorthand. */
const GITHUB_SHORTHAND = /^[\w.-]+\/[\w.-]+(?:#.*)?$/;

/**
 * True when a `package.json` dependency specifier does not resolve from the public registry. `manifestDir` and
 * `root` are absolute: a `file:`/`link:` path is foreign when it resolves outside `root`.
 */
function isForeignSpecifier(spec: string, manifestDir: string, root: string): boolean {
  const value = spec.startsWith('npm:') ? spec.slice('npm:'.length) : spec;
  const local = LOCAL_PATH_SOURCE.exec(value);
  if (local !== null) {
    const target = resolve(manifestDir, local[1] ?? '');
    return target !== root && !target.startsWith(root + sep);
  }
  return hasForeignUrl(value) || NON_REGISTRY_SOURCE.test(value) || GITHUB_SHORTHAND.test(value);
}

const REASONS: Record<ViolationKind, string> = {
  'foreign-source-dependency': 'resolves from outside the public npm registry (registry.npmjs.org)',
  'foreign-registry': 'names a registry other than registry.npmjs.org',
  'npm-auth-token': 'contains an npm auth token line',
  'missing-apache-license': 'license must be "Apache-2.0"',
  'unreadable-package-json': 'is not valid JSON',
};

function listFiles(root: string, directory: string, found: string[]): void {
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) listFiles(root, path, found);
    } else if (['package.json', '.npmrc', 'bunfig.toml', 'bun.lock'].includes(entry.name)) {
      found.push(path);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkPackageJson(
  file: string,
  text: string,
  manifestDir: string,
  root: string
): Violation[] {
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return [{ file, key: '(file)', kind: 'unreadable-package-json' }];
  }
  if (!isRecord(manifest)) return [{ file, key: '(file)', kind: 'unreadable-package-json' }];

  const violations: Violation[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const deps = manifest[field];
    if (!isRecord(deps)) continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec === 'string' && isForeignSpecifier(spec, manifestDir, root)) {
        violations.push({ file, key: `${field}.${name}`, kind: 'foreign-source-dependency' });
      }
    }
  }
  const publishConfig = manifest.publishConfig;
  if (isRecord(publishConfig)) {
    const registry = publishConfig.registry;
    if (typeof registry === 'string' && hasForeignUrl(registry)) {
      violations.push({ file, key: 'publishConfig.registry', kind: 'foreign-registry' });
    }
  }
  if (manifest.license !== 'Apache-2.0') {
    violations.push({ file, key: 'license', kind: 'missing-apache-license' });
  }
  return violations;
}

function checkConfigFile(file: string, text: string): Violation[] {
  const isNpmrc = file.endsWith('.npmrc');
  const isLockfile = file.endsWith('bun.lock');
  const violations: Violation[] = [];
  text.split('\n').forEach((line, index) => {
    const key = `line ${String(index + 1)}`;
    if (isLockfile) {
      if (hasForeignUrl(line) || NON_REGISTRY_SOURCE.test(line)) {
        violations.push({ file, key, kind: 'foreign-source-dependency' });
      }
    } else if (hasForeignUrl(line)) {
      violations.push({ file, key, kind: 'foreign-registry' });
    }
    if (isNpmrc && AUTH_LINE.test(line)) {
      violations.push({ file, key, kind: 'npm-auth-token' });
    }
  });
  return violations;
}

/** Every violation under `root`, in path order. */
export function findViolations(root: string): Violation[] {
  const absoluteRoot = resolve(root);
  const files: string[] = [];
  listFiles(root, root, files);
  return files.flatMap((path) => {
    const file = relative(root, path).split(sep).join('/');
    const text = readFileSync(path, 'utf8');
    if (file.endsWith('package.json'))
      return checkPackageJson(file, text, dirname(path), absoluteRoot);
    return checkConfigFile(file, text);
  });
}

/** Runs the guard over `root`, writing one line per violation. Returns the process exit code. */
export function runGuard(root: string, out: (line: string) => void): number {
  const violations = findViolations(root);
  if (violations.length === 0) {
    const files: string[] = [];
    listFiles(root, root, files);
    const manifests = files.filter((f) => f.endsWith('package.json')).length;
    out(`private-dependency guard: OK (${String(manifests)} package.json files checked)`);
    return 0;
  }
  for (const v of violations) out(`${v.file}: ${v.key} — ${REASONS[v.kind]}`);
  out(`private-dependency guard: ${String(violations.length)} violation(s)`);
  return 1;
}

if (import.meta.main) {
  process.exit(
    runGuard(process.cwd(), (line) => {
      console.log(line);
    })
  );
}
