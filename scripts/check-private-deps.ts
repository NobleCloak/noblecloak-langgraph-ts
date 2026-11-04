/**
 * Private-dependency guard. Walks every package.json, .npmrc, bunfig.toml and bun.lock in the tree
 * and fails when the tree names a source a stranger could not install from, or a credential. Every package,
 * the `@noblecloak/*` contract pair included, installs from the public registry (`registry.npmjs.org`) by name
 * and version, so the tree maps no scope to any registry and holds no credential.
 *
 * - a dependency (any of the four dependency fields, including npm: aliases) whose specifier is not a
 *   registry version or range: a URL other than `registry.npmjs.org`, a git or `github:` shorthand, or any
 *   `file:`/`link:` path;
 * - in an .npmrc or bunfig.toml, any URL other than `registry.npmjs.org` and any `registry` setting whose value
 *   is not exactly `https://registry.npmjs.org` (so `registry=${VAR}` is flagged);
 * - in an .npmrc, any scope-to-registry mapping (`<scope>:registry=...`), even one that names the public
 *   registry, and any key that holds a `${` (npm expands `${K}=${V}` into a mapping);
 * - in a bunfig.toml, any `[install.scopes]` or `[install.registry]` table, any `install.scopes` or
 *   `install.registry` dotted key, and any `"@scope" = ...` line, whatever it maps to, even the public registry;
 *   a URL other than `registry.npmjs.org` in `publishConfig.registry`;
 * - a credential: in an .npmrc, any `_auth`, `_authToken` or `_password` line; in a bunfig.toml, a `username`,
 *   a `password` or a `token`;
 * - a bun.lock package entry that bun resolved other than by version or as a workspace (a path, `file:`,
 *   `link:`, git), and a bun.lock line with a URL other than `registry.npmjs.org`;
 * - a package.json whose `license` is not `Apache-2.0`.
 *
 * Run with `bun run guard`. Exit code 1 and one line per violation (`file: key — reason`).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

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

const NPMRC_AUTH_LINE = /_auth(Token)?\s*=|_password\s*=/;
/** A bunfig.toml line that sets a username, a password or a token. */
const BUNFIG_AUTH_LINE = /\b(?:username|password|token)\s*=/;

/** Any scope mapping: `@scope:registry=` in an .npmrc, `"@scope" =` or `@scope =` in a bunfig.toml. */
const ANY_SCOPE_MAPPING = /^\s*(?:@[^:\s]+:registry\s*=|"?@[^"\s=]+"?\s*=)/;

/**
 * The bunfig.toml forms that map a scope or set the registry as a table or dotted key: a `[install.scopes]` or
 * `[install.registry]` table header (optionally quoted, optionally with a sub-table), an `install.scopes` or
 * `install.registry` dotted key, and a bare `scopes` key inside `[install]`.
 */
const BUNFIG_REGISTRY_TABLE =
  /^\s*\[\s*"?install"?\s*\.\s*"?(?:scopes|registry)"?\s*(?:\.[^\]]*)?\]|^\s*"?install"?\s*\.\s*"?(?:scopes|registry)"?\s*[.=]|^\s*"?scopes"?\s*[.=]/;

/** An .npmrc line whose key (before the first `=`) holds an environment expansion, such as `${K}=${V}`. */
const NPMRC_EXPANDED_KEY = /^\s*(?![#;])[^=]*\$\{[^=]*=/;

/** An unscoped `registry` setting: `registry=<value>` in an .npmrc, `registry = <value>` in a bunfig.toml. */
const REGISTRY_SETTING = /^\s*registry\s*=\s*(.*?)\s*$/;

/** True when a line sets `registry` to anything but the public registry (an optional trailing slash is fine). */
function setsOtherRegistry(line: string): boolean {
  const value = REGISTRY_SETTING.exec(line)?.[1];
  if (value === undefined) return false;
  return !/^(["']?)https:\/\/registry\.npmjs\.org\/?\1$/i.test(value);
}

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

/** A `file:` or `link:` specifier. */
const LOCAL_PATH_SOURCE = /^(?:file|link):/i;

/** A bare `owner/repo` (optionally `#ref`) is npm's GitHub shorthand. */
const GITHUB_SHORTHAND = /^[\w.-]+\/[\w.-]+(?:#.*)?$/;

/** True when a `package.json` dependency specifier does not resolve from the public registry. */
function isForeignSpecifier(spec: string): boolean {
  const value = spec.startsWith('npm:') ? spec.slice('npm:'.length) : spec;
  return (
    LOCAL_PATH_SOURCE.test(value) ||
    hasForeignUrl(value) ||
    NON_REGISTRY_SOURCE.test(value) ||
    GITHUB_SHORTHAND.test(value)
  );
}

/**
 * A bun.lock package entry, indented four spaces under `"packages"`: `"<name>": ["<name>@<resolution>", "<source>",
 * ...`; the source may be absent.
 */
const LOCK_ENTRY = /^ {4}"([^"]+)":\s*\[\s*"([^"]*)"(?:,\s*"([^"]*)")?/;

/**
 * True when a bun.lock line is a package entry that bun resolved other than by version from a registry or as a
 * workspace: a tarball or directory path (`name@./vendor/x.tgz`), `file:`, `link:`, git or `github:`.
 */
function isNonRegistryLockEntry(line: string): boolean {
  const resolved = LOCK_ENTRY.exec(line)?.[2];
  if (resolved === undefined) return false;
  const version = resolved.slice(resolved.lastIndexOf('@') + 1);
  return resolved.lastIndexOf('@') <= 0 || !/^(\d|workspace:)/.test(version);
}

const REASONS: Record<ViolationKind, string> = {
  'foreign-source-dependency': 'resolves from outside the public npm registry (registry.npmjs.org)',
  'foreign-registry':
    'names a registry other than registry.npmjs.org, or maps a scope to a registry',
  'npm-auth-token':
    'contains a registry credential; the tree installs from the public registry without one',
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

function checkPackageJson(file: string, text: string): Violation[] {
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
      if (typeof spec === 'string' && isForeignSpecifier(spec)) {
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
  const isBunfig = file.endsWith('bunfig.toml');
  const isLockfile = file.endsWith('bun.lock');
  const violations: Violation[] = [];
  text.split('\n').forEach((line, index) => {
    const key = `line ${String(index + 1)}`;
    if (isLockfile) {
      if (isNonRegistryLockEntry(line) || hasForeignUrl(line) || NON_REGISTRY_SOURCE.test(line)) {
        violations.push({ file, key, kind: 'foreign-source-dependency' });
      }
      return;
    }
    if (isNpmrc && NPMRC_AUTH_LINE.test(line)) {
      violations.push({ file, key, kind: 'npm-auth-token' });
      return;
    }
    if (isBunfig && BUNFIG_AUTH_LINE.test(line)) {
      violations.push({ file, key, kind: 'npm-auth-token' });
    }
    if (
      hasForeignUrl(line) ||
      ANY_SCOPE_MAPPING.test(line) ||
      setsOtherRegistry(line) ||
      (isBunfig && BUNFIG_REGISTRY_TABLE.test(line)) ||
      (isNpmrc && NPMRC_EXPANDED_KEY.test(line))
    ) {
      violations.push({ file, key, kind: 'foreign-registry' });
    }
  });
  return violations;
}

/** Every violation under `root`, in path order. */
export function findViolations(root: string): Violation[] {
  const files: string[] = [];
  listFiles(root, root, files);
  return files.flatMap((path) => {
    const file = relative(root, path).split(sep).join('/');
    const text = readFileSync(path, 'utf8');
    if (file.endsWith('package.json')) return checkPackageJson(file, text);
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
