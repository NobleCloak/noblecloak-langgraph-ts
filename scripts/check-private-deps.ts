/**
 * Private-dependency guard. Walks every package.json, .npmrc, bunfig.toml and bun.lock in the tree
 * and fails when the tree names a source a stranger could not install from, or a credential. It names no scope:
 * the one scope that may map to the package registry is the scope of the packages `contract.json` records (when
 * they share one), read from the scanned tree.
 *
 * - a dependency (any of the four dependency fields, including npm: aliases) whose specifier is not a
 *   registry version or range: a URL other than `registry.npmjs.org`, a git or `github:` shorthand, or any
 *   `file:`/`link:` path;
 * - in the root .npmrc or the root bunfig.toml, at most one registry mapping, the contract scope to
 *   `https://npm.pkg.github.com` (`<scope>:registry=https://npm.pkg.github.com` in .npmrc,
 *   `"<scope>" = { url = "https://npm.pkg.github.com", token = "$NODE_AUTH_TOKEN" }` in bunfig.toml); any other
 *   URL than `registry.npmjs.org` in an .npmrc or bunfig.toml, a mapping of any other scope or to any other
 *   registry, a mapping in any other file and a second mapping are violations, as is a URL other than
 *   `registry.npmjs.org` in `publishConfig.registry`;
 * - a credential: in an .npmrc, any `_auth`, `_authToken` or `_password` line except
 *   `//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}` in the root .npmrc while `contract.json` names a
 *   scope; in a bunfig.toml, a `username`, a `password`, or a `token` other than `"$NODE_AUTH_TOKEN"`;
 * - a bun.lock package entry that bun resolved other than by version or as a workspace (a path, `file:`,
 *   `link:`, git), and a bun.lock line with a URL other than `registry.npmjs.org`, except the package entry of a
 *   contract-scope package whose tarball is under `https://npm.pkg.github.com/download/<that package>/`;
 * - a package.json whose `license` is not `Apache-2.0`.
 *
 * Run with `bun run guard`. Exit code 1 and one line per violation (`file: key — reason`).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export type ViolationKind =
  | 'foreign-source-dependency'
  | 'foreign-registry'
  | 'second-registry-mapping'
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

/** The registry the contract scope may map to, and its host. */
const PACKAGE_REGISTRY = 'https://npm.pkg.github.com';
const PACKAGE_REGISTRY_HOST = 'npm.pkg.github.com';

/** The one auth line an .npmrc may hold: the package registry's token, read from the environment. */
const ALLOWED_NPMRC_AUTH_LINE = `//${PACKAGE_REGISTRY_HOST}/:_authToken=\${NODE_AUTH_TOKEN}`;

const NPMRC_AUTH_LINE = /_auth(Token)?\s*=|_password\s*=/;
/** A bunfig.toml line that sets a username, a password, or a token other than `"$NODE_AUTH_TOKEN"`. */
const BUNFIG_AUTH_LINE = /\b(?:username|password)\s*=|\btoken\s*=(?!\s*"\$NODE_AUTH_TOKEN")/;

/** `<scope>:registry=<url>` in an .npmrc. */
const NPMRC_SCOPE_MAPPING = /^\s*(@[^:\s]+):registry\s*=\s*(\S+)\s*$/;
/** `"<scope>" = { url = "<url>", token = "$NODE_AUTH_TOKEN" }` in a bunfig.toml, the one allowed form. */
const BUNFIG_SCOPE_MAPPING =
  /^\s*"(@[^"]+)"\s*=\s*\{\s*url\s*=\s*"([^"]+)"\s*,\s*token\s*=\s*"\$NODE_AUTH_TOKEN"\s*\}\s*$/;

/** Any scope mapping, allowed or not: `@scope:registry=` in an .npmrc, `"@scope" =` or `@scope =` in a bunfig.toml. */
const ANY_SCOPE_MAPPING = /^\s*(?:@[^:\s]+:registry\s*=|"?@[^"\s=]+"?\s*=)/;

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

/**
 * True when a bun.lock line is the package entry of a `scope` package whose only URL is its own tarball on the
 * package registry (`https://npm.pkg.github.com/download/<name>/...`).
 */
function isScopedRegistryEntry(line: string, scope: string | undefined): boolean {
  if (scope === undefined) return false;
  const entry = LOCK_ENTRY.exec(line);
  const name = entry?.[1];
  if (!name?.startsWith(`${scope}/`)) return false;
  if (!(entry?.[3] ?? '').startsWith(`${PACKAGE_REGISTRY}/download/${name}/`)) return false;
  return [...line.matchAll(URL_IN_LINE)].length === 1;
}

/**
 * The scope the packages `contract.json` records share (`@acme` for `@acme/a` and `@acme/b`), or undefined when
 * there is no readable `contract.json` or its packages do not share one scope.
 */
export function contractScope(root: string): string | undefined {
  const file = join(root, 'contract.json');
  if (!existsSync(file)) return undefined;
  let record: unknown;
  try {
    record = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  const packages = isRecord(record) ? record.packages : undefined;
  if (!isRecord(packages)) return undefined;
  const scopes = new Set(Object.keys(packages).map((name) => /^(@[^/]+)\//.exec(name)?.[1]));
  const [scope] = [...scopes];
  return scopes.size === 1 ? scope : undefined;
}

const REASONS: Record<ViolationKind, string> = {
  'foreign-source-dependency':
    'resolves from outside the public npm registry (registry.npmjs.org) and the one allowed scope mapping',
  'foreign-registry':
    'names a registry other than registry.npmjs.org, outside the one allowed scope mapping in the root .npmrc or bunfig.toml',
  'second-registry-mapping': 'is a second registry mapping; only one scope may map to a registry',
  'npm-auth-token':
    'contains an auth line other than the package registry token read from NODE_AUTH_TOKEN',
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

/** What the config-file checks share across files: the contract scope and how many mappings were seen. */
interface ConfigState {
  readonly scope: string | undefined;
  mappings: number;
}

/**
 * True when a line maps the contract scope to the package registry in the allowed form, in the root .npmrc or
 * the root bunfig.toml.
 */
function allowedMapping(file: string, line: string, scope: string | undefined): boolean {
  if (scope === undefined) return false;
  const mapping =
    file === '.npmrc'
      ? NPMRC_SCOPE_MAPPING.exec(line)
      : file === 'bunfig.toml'
        ? BUNFIG_SCOPE_MAPPING.exec(line)
        : null;
  return mapping?.[1] === scope && mapping[2] === PACKAGE_REGISTRY;
}

function checkConfigFile(file: string, text: string, state: ConfigState): Violation[] {
  const isNpmrc = file.endsWith('.npmrc');
  const isBunfig = file.endsWith('bunfig.toml');
  const isLockfile = file.endsWith('bun.lock');
  const violations: Violation[] = [];
  text.split('\n').forEach((line, index) => {
    const key = `line ${String(index + 1)}`;
    if (isLockfile) {
      if (isNonRegistryLockEntry(line)) {
        violations.push({ file, key, kind: 'foreign-source-dependency' });
        return;
      }
      if (isScopedRegistryEntry(line, state.scope)) return;
      if (hasForeignUrl(line) || NON_REGISTRY_SOURCE.test(line)) {
        violations.push({ file, key, kind: 'foreign-source-dependency' });
      }
      return;
    }
    if (isNpmrc && NPMRC_AUTH_LINE.test(line)) {
      if (!(
        file === '.npmrc' &&
        state.scope !== undefined &&
        line.trim() === ALLOWED_NPMRC_AUTH_LINE
      ))
        violations.push({ file, key, kind: 'npm-auth-token' });
      return;
    }
    if (allowedMapping(file, line, state.scope)) {
      state.mappings += 1;
      if (state.mappings > 1) violations.push({ file, key, kind: 'second-registry-mapping' });
      return;
    }
    if (isBunfig && BUNFIG_AUTH_LINE.test(line)) {
      violations.push({ file, key, kind: 'npm-auth-token' });
    }
    if (hasForeignUrl(line) || ANY_SCOPE_MAPPING.test(line)) {
      violations.push({ file, key, kind: 'foreign-registry' });
    }
  });
  return violations;
}

/** Every violation under `root`, in path order. */
export function findViolations(root: string): Violation[] {
  const files: string[] = [];
  listFiles(root, root, files);
  const state: ConfigState = { scope: contractScope(root), mappings: 0 };
  return files.flatMap((path) => {
    const file = relative(root, path).split(sep).join('/');
    const text = readFileSync(path, 'utf8');
    if (file.endsWith('package.json')) return checkPackageJson(file, text);
    return checkConfigFile(file, text, state);
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
