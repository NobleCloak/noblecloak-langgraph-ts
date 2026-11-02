#!/usr/bin/env node
// Wires the NobleCloak LangGraph adapter into a LangGraph JS project: copies the governance module, the resumer
// worker, a log helper and an `agent.json` stub into `src/noblecloak/`, adds the environment keys to `.env.example`
// (and `!.env.example` to a `.gitignore` whose `.env*` rule would hide it) and installs `@noblecloak/langgraph` and
// `@noblecloak/client`. It does not write the project-specific files (`governed-agent.ts`, the plan): those are
// the model's steps in SKILL.md. Plain Node (18 or later), no dependencies, so it runs in any project.
//
//   node apply.mjs [--project <dir>] [--source registry|<dir of tarballs>] [--force] [--dry-run] [--skip-install]
//
// It refuses a project that depends on neither `@langchain/langgraph` nor `langchain`. It writes nothing when any
// target file already exists with other content, unless `--force` is given; `agent.json` is the exception: it holds
// the agent's id from the first run on, so an existing one is kept even with `--force`. It never writes `NC_TOKEN`.
//
// `--source <dir>` (pre-release use) also edits package.json: it pins `@noblecloak/client` to its tarball in the
// manager's override field, because the registry does not have it before the public release. Only the bun install of
// that path has been run; npm, pnpm and yarn are dry-run tested.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');

/** Where the templates go, relative to the project. */
const TARGET_DIR = join('src', 'noblecloak');

/** Templates that are never overwritten once they exist: the file carries state the project has since written. */
const KEEP_IF_EXISTS = ['agent.json'];

/** The packages whose presence says this is a LangGraph JS project. */
const LANGGRAPH_PACKAGES = ['@langchain/langgraph', 'langchain'];

/**
 * The keys the generated `governance.ts` reads, with the values `.env.example` carries. `NC_AUDIENCE` is optional,
 * so it is written commented out. `NC_TOKEN` is never written: the agent runs as its service principal.
 */
const ENV_KEYS = [
  ['NC_BASE_URL', 'https://govern.example.test', false],
  ['NOBLECLOAK_SP_CREDENTIALS', '/path/to/service-principal-credential.json', false],
  ['NC_EXPECTED_PRINCIPAL', 'svc_replace_with_the_service_principal_id', false],
  ['NC_AUDIENCE', 'https://govern.example.test', true],
];
const ENV_HEADER =
  "# NobleCloak governance for the agent. Copy to .env, fill in. The credential is the agent's own service principal:\n" +
  '# keep its file outside the repository, and set NC_EXPECTED_PRINCIPAL to its id. NC_AUDIENCE is optional (default: the origin of NC_BASE_URL).\n';

/** @param {string[]} argv */
export function parseArgs(argv) {
  const options = {
    project: process.cwd(),
    source: 'registry',
    force: false,
    dryRun: false,
    skipInstall: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') options.force = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--skip-install') options.skipInstall = true;
    else if (arg === '--project' || arg === '--source') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      options[arg === '--project' ? 'project' : 'source'] = value;
      i += 1;
    } else throw new Error(`unknown argument ${arg}`);
  }
  options.project = resolve(options.project);
  return options;
}

/** @param {string} dir @returns {string[]} files under dir, relative, sorted */
function listFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? listFiles(join(dir, entry.name), base)
        : [relative(base, join(dir, entry.name))]
    )
    .sort();
}

const MANAGERS = ['bun', 'pnpm', 'yarn', 'npm'];
const LOCKFILES = [
  ['bun', ['bun.lock', 'bun.lockb']],
  ['pnpm', ['pnpm-lock.yaml']],
  ['yarn', ['yarn.lock']],
  ['npm', ['package-lock.json']],
];

/**
 * The package manager the project uses: the manifest's `packageManager` field (`bun@1.4.3`) when it names
 * one, else the first lockfile found in the project directory or, for a workspace member, the nearest
 * directory above it (up to the filesystem root); npm when there is neither.
 */
export function detectPackageManager(project, manifest) {
  const field = /^([a-z]+)@/.exec(String(manifest?.packageManager ?? ''))?.[1];
  if (field !== undefined && MANAGERS.includes(field)) return field;
  for (let dir = resolve(project); ; dir = dirname(dir)) {
    const found = LOCKFILES.find(([, files]) => files.some((file) => existsSync(join(dir, file))));
    if (found !== undefined) return found[0];
    if (dirname(dir) === dir) return 'npm';
  }
}

/**
 * The packages a tarball source installs: `@noblecloak/langgraph` first, then the workspace package it depends on by
 * version, which the registry does not have before the public release.
 */
const TARBALL_PACKAGES = ['langgraph', 'client'];

/** The packages to install and, for a tarball source, the files they come from (in `TARBALL_PACKAGES` order). */
export function installSpecs(source) {
  if (source === 'registry') return ['@noblecloak/langgraph', '@noblecloak/client'];
  const dir = resolve(source);
  if (!existsSync(dir)) throw new Error(`--source ${source}: no such directory`);
  const names = readdirSync(dir);
  return TARBALL_PACKAGES.map((name) => {
    const found = names.filter((file) => new RegExp(`^noblecloak-${name}-\\d.*\\.tgz$`).test(file));
    if (found.length !== 1)
      throw new Error(
        `--source ${source}: expected one noblecloak-${name}-<version>.tgz, found ${found.length}`
      );
    return join(dir, found[0]);
  });
}

const ENV_RULE = /^\/?\.env(\*|\.\*)$/;
const ENV_EXAMPLE_NEGATION = /^!\/?\.env\.example$/;

/**
 * Whether the project's `.gitignore` ignores `.env.example` through a `.env*` rule (as a fresh
 * `create-next-app` does, and other starters do) with no `!.env.example` after it, so the written file would never be committed.
 */
export function needsEnvExampleNegation(gitignoreText) {
  const lines = gitignoreText.split(/\r?\n/).map((line) => line.trim());
  const rule = lines.findLastIndex((line) => ENV_RULE.test(line));
  return rule !== -1 && !lines.slice(rule + 1).some((line) => ENV_EXAMPLE_NEGATION.test(line));
}

/** Everything the run would do, without doing it. */
export function plan(options) {
  const { project } = options;
  if (!existsSync(join(project, 'package.json'))) throw new Error(`${project} has no package.json`);
  const manifestText = readFileSync(join(project, 'package.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  const declared = { ...manifest.dependencies, ...manifest.devDependencies };
  if (!LANGGRAPH_PACKAGES.some((name) => declared[name] !== undefined))
    throw new Error(
      `this project depends on neither ${LANGGRAPH_PACKAGES.join(' nor ')}: the skill wires a LangGraph JS agent`
    );

  const files = listFiles(TEMPLATES).map((path) => {
    const target = join(project, TARGET_DIR, path);
    const content = readFileSync(join(TEMPLATES, path), 'utf8');
    const state = !existsSync(target)
      ? 'create'
      : KEEP_IF_EXISTS.includes(path)
        ? 'kept'
        : readFileSync(target, 'utf8') === content
          ? 'unchanged'
          : 'conflict';
    return { path: relative(project, target), target, content, state };
  });
  const conflicts = files.filter((file) => file.state === 'conflict');
  if (conflicts.length > 0 && !options.force)
    throw new Error(
      `these files exist with other content (nothing was written; --force overwrites them):\n  ${conflicts
        .map((file) => file.path)
        .join('\n  ')}`
    );

  const envPath = join(project, '.env.example');
  const envText = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const missing = ENV_KEYS.filter(([key]) => !new RegExp(`^#?\\s*${key}=`, 'm').test(envText));
  const gitignorePath = join(project, '.gitignore');
  const gitignoreText = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  const manager = detectPackageManager(project, manifest);
  const specs = installSpecs(options.source);
  // `@noblecloak/langgraph` depends on `@noblecloak/client` by version: from tarballs the registry has no such
  // package, so its tarball must answer for that dependency too.
  const overrides =
    options.source === 'registry'
      ? []
      : TARBALL_PACKAGES.slice(1).map((name, i) => ({
          name: `@noblecloak/${name}`,
          spec: `file:${specs[i + 1]}`,
          manager,
        }));
  return {
    overrides: overrides.filter((override) => !hasOverride(manifest, override)),
    manifest,
    manifestText,
    files,
    envPath,
    envText,
    missing,
    gitignorePath,
    gitignoreText,
    negateEnvExample: needsEnvExampleNegation(gitignoreText),
    manager,
    install: [manager, manager === 'npm' ? 'install' : 'add', ...specs],
  };
}

/** The package.json field the package manager reads dependency overrides from. */
export function overrideField(manager) {
  return manager === 'pnpm' ? 'pnpm.overrides' : manager === 'yarn' ? 'resolutions' : 'overrides';
}

/** Whether the manifest already carries this override. */
export function hasOverride(manifest, { name, spec, manager }) {
  const overrides =
    manager === 'pnpm' ? manifest.pnpm?.overrides : manifest[overrideField(manager)];
  return overrides?.[name] === spec;
}

/** The manifest as text, in the indent and line ending the original file used (2 spaces and LF when unknown). */
export function serializeManifest(manifest, originalText) {
  const indent = /^([ \t]+)"/m.exec(originalText)?.[1] ?? '  ';
  const eol = originalText.includes('\r\n') ? '\r\n' : '\n';
  return `${JSON.stringify(manifest, null, indent).replace(/\n/g, eol)}${eol}`;
}

/** A copy of the manifest with one override added. */
export function withOverride(manifest, { name, spec, manager }) {
  if (manager === 'pnpm')
    return {
      ...manifest,
      pnpm: { ...manifest.pnpm, overrides: { ...manifest.pnpm?.overrides, [name]: spec } },
    };
  const field = overrideField(manager);
  return { ...manifest, [field]: { ...manifest[field], [name]: spec } };
}

/** @param {string[]} argv */
export function main(argv) {
  const options = parseArgs(argv);
  const steps = plan(options);
  const say = (line) => console.log(line);
  for (const file of steps.files) {
    say(
      `${{ create: 'create', conflict: 'overwrite', kept: 'keep (it holds the agent id)' }[file.state] ?? 'unchanged'} ${file.path}`
    );
    if (options.dryRun || file.state === 'unchanged' || file.state === 'kept') continue;
    mkdirSync(dirname(file.target), { recursive: true });
    writeFileSync(file.target, file.content);
  }
  if (steps.missing.length > 0) {
    say(`add ${steps.missing.map(([key]) => key).join(', ')} to .env.example`);
    if (!options.dryRun) {
      const block =
        (steps.envText === ''
          ? ENV_HEADER
          : (steps.envText.endsWith('\n') ? '\n' : '\n\n') + ENV_HEADER) +
        steps.missing
          .map(([key, value, optional]) => `${optional ? '# ' : ''}${key}=${value}`)
          .join('\n') +
        '\n';
      writeFileSync(steps.envPath, steps.envText + block);
    }
  }
  if (steps.negateEnvExample) {
    say('add !.env.example to .gitignore (its .env* rule would leave .env.example uncommitted)');
    if (!options.dryRun) {
      const text = steps.gitignoreText;
      writeFileSync(
        steps.gitignorePath,
        `${text}${text.endsWith('\n') ? '' : '\n'}!.env.example\n`
      );
    }
  }
  for (const override of steps.overrides)
    say(
      `pin ${override.name} to ${override.spec} (${overrideField(override.manager)} in package.json)`
    );
  if (steps.overrides.length > 0 && !options.dryRun) {
    writeFileSync(
      join(options.project, 'package.json'),
      serializeManifest(steps.overrides.reduce(withOverride, steps.manifest), steps.manifestText)
    );
  }
  say(`${options.skipInstall || options.dryRun ? 'would run' : 'run'} ${steps.install.join(' ')}`);
  if (options.dryRun || options.skipInstall) return 0;
  const [command, ...args] = steps.install;
  const result = spawnSync(command, args, { cwd: options.project, stdio: 'inherit' });
  if (result.error !== undefined || result.status !== 0) {
    console.error(
      `apply: ${steps.install.join(' ')} failed: ${result.error?.message ?? `exit ${String(result.status)}`}\n` +
        'The files above were written' +
        (steps.overrides.length === 0 ? '' : ' and package.json was changed') +
        '. Install by hand, or run this script again with --skip-install after fixing the cause.'
    );
    return result.status ?? 1;
  }
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`apply: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
