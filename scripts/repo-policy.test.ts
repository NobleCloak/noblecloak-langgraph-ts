/**
 * Repository policy: the properties the repository's foundation requires, asserted against the tree so a
 * change that breaks one fails CI instead of surfacing at the first publish.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { findViolations } from './check-private-deps.js';
import { listWorkspacePackages } from './workspace.js';

const ROOT = resolve(import.meta.dirname, '..');

const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(read(path)) as Record<string, unknown>;

interface Step {
  uses?: string;
  run?: string;
  name?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}
/** A permissions block: a scope map, or a string (`read-all`, `write-all`). */
type Permissions = Record<string, string> | string;
interface Job {
  name?: string;
  needs?: string | string[];
  environment?: string | { name?: string; url?: string };
  if?: string;
  permissions?: Permissions;
  uses?: string;
  steps?: Step[];
}
interface Workflow {
  permissions?: Permissions;
  jobs: Record<string, Job>;
}

const WORKFLOW_DIR = join(ROOT, '.github/workflows');
const workflowFiles = readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith('.yml'));
const loadWorkflow = (file: string): Workflow =>
  parse(read(`.github/workflows/${file}`)) as Workflow;

const packages = listWorkspacePackages(ROOT);
const relDir = (dir: string): string => dir.slice(ROOT.length + 1);
const manifestPaths = ['package.json', ...packages.map((p) => `${relDir(p.dir)}/package.json`)];

const NOTICE_HEAD = ['NobleCloak LangGraph adapter (TypeScript)', 'Copyright 2026 NobleCloak'];
/** Licence and holder: the first two NOTICE lines must be the holder's, and a manifest must say who and what. */
const noticeViolations = (notice: string): string[] =>
  notice.split('\n').slice(0, 2).join('\n') === NOTICE_HEAD.join('\n')
    ? []
    : ['NOTICE does not open with the product line and the NobleCloak copyright line'];
const manifestLicenseViolations = (manifest: Record<string, unknown>): string[] => [
  ...(manifest.license === 'Apache-2.0' ? [] : ['license is not Apache-2.0']),
  ...(manifest.author === 'NobleCloak' ? [] : ['author is not NobleCloak']),
];

// An exact version or a workspace link; a file: path, even to a tarball in the tree, is not a pin.
const PINNED = /^(\d+\.\d+\.\d+(-[\w.]+)?|workspace:.+)$/;
/** Every dependency range in dependencies, devDependencies and optionalDependencies that is not an exact pin. */
const pinViolations = (manifest: Record<string, unknown>): string[] =>
  ['dependencies', 'devDependencies', 'optionalDependencies'].flatMap((field) =>
    Object.entries((manifest[field] ?? {}) as Record<string, string>)
      .filter(([, range]) => !PINNED.test(range))
      .map(([name, range]) => `${field}.${name}: ${range}`)
  );

/** A coverage exclude is allowed when it is a test glob, the vitest config, or listed (with a reason) for the package. */
const coverageExcludeViolations = (
  excludes: readonly string[],
  allowed: readonly string[]
): string[] =>
  excludes.filter(
    (glob) =>
      !(/\*\.test\.tsx?$/.test(glob) || glob === 'vitest.config.ts' || allowed.includes(glob))
  );

describe('license and holder', () => {
  it('NOTICE names NobleCloak as the copyright holder', () => {
    expect(noticeViolations(read('NOTICE'))).toEqual([]);
  });

  it('the licence checks reject a foreign holder, a wrong licence and a wrong author', () => {
    expect(
      noticeViolations(read('NOTICE').replace('Copyright 2026 NobleCloak', 'Copyright 2026 Acme'))
    ).not.toEqual([]);
    expect(noticeViolations(NOTICE_HEAD.join('\n'))).toEqual([]);
    expect(manifestLicenseViolations({ license: 'Apache-2.0', author: 'NobleCloak' })).toEqual([]);
    expect(manifestLicenseViolations({ license: 'MIT', author: 'NobleCloak' })).toEqual([
      'license is not Apache-2.0',
    ]);
    expect(manifestLicenseViolations({ license: 'Apache-2.0', author: 'Someone Else' })).toEqual([
      'author is not NobleCloak',
    ]);
  });

  it.each(manifestPaths)('%s declares Apache-2.0 and author NobleCloak', (path) => {
    expect(manifestLicenseViolations(readJson(path))).toEqual([]);
  });

  // The repository has no third-party block in NOTICE (the adapter's only runtime dependency is the
  // NobleCloak client), so a published package's NOTICE is the root NOTICE as it is.
  it.each(packages.filter((p) => !p.private).map((p) => relDir(p.dir)))(
    '%s ships the root LICENSE and NOTICE',
    (dir) => {
      expect(read(`${dir}/LICENSE`), 'LICENSE').toBe(read('LICENSE'));
      expect(read(`${dir}/NOTICE`), 'NOTICE').toBe(read('NOTICE'));
      expect(readJson(`${dir}/package.json`).files).toEqual(
        expect.arrayContaining(['LICENSE', 'NOTICE'])
      );
    }
  );

  it('the tree passes the private-dependency guard', () => {
    expect(findViolations(ROOT)).toEqual([]);
  });
});

describe('versions are pinned exactly', () => {
  it.each(manifestPaths)('%s pins every dependency to an exact version', (path) => {
    expect(pinViolations(readJson(path))).toEqual([]);
  });

  it('the pin check rejects a range, a tag, a file: link and a bad field, and accepts the allowed forms', () => {
    expect(
      pinViolations({
        dependencies: {
          a: '1.2.3',
          b: 'workspace:*',
          c: '1.0.0-rc.1',
        },
      })
    ).toEqual([]);
    expect(
      pinViolations({ dependencies: { d: 'file:../vendor/noblecloak-client-0.1.0.tgz' } })
    ).toEqual(['dependencies.d: file:../vendor/noblecloak-client-0.1.0.tgz']);
    expect(pinViolations({ dependencies: { a: '^1.2.3' } })).toEqual(['dependencies.a: ^1.2.3']);
    expect(pinViolations({ devDependencies: { a: 'latest' } })).toEqual([
      'devDependencies.a: latest',
    ]);
    expect(pinViolations({ optionalDependencies: { a: '~1.2.3' } })).toEqual([
      'optionalDependencies.a: ~1.2.3',
    ]);
    expect(pinViolations({ dependencies: { a: 'file:../other/pkg.tgz' } })).toEqual([
      'dependencies.a: file:../other/pkg.tgz',
    ]);
  });

  it('packageManager pins an exact bun version', () => {
    expect(readJson('package.json').packageManager).toMatch(/^bun@\d+\.\d+\.\d+$/);
  });

  it('.node-version pins an exact Node version', () => {
    expect(read('.node-version').trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('@types/node tracks the .node-version line and the pin is recorded by line', () => {
    const devDependencies = readJson('package.json').devDependencies as Record<string, string>;
    const typesNode = devDependencies['@types/node'] ?? '';
    const line = read('.node-version').trim().split('.')[0] ?? '';
    expect(typesNode.split('.')[0]).toBe(line);
    const pins = read('CONTRIBUTING.md').split('## Toolchain pins')[1] ?? '';
    const entry = pins
      .split('\n- ')
      .find((item) => item.startsWith(`**\`@types/node\` ${line}.x**`));
    expect(entry, `CONTRIBUTING.md Toolchain pins entry for @types/node ${line}.x`).toMatch(
      /Lift when/
    );
  });
});

describe('coverage', () => {
  // Coverage measures every source file: `include` is a glob, never a hand-picked file, and `exclude`
  // holds only tests, the vitest config itself, and the files listed here with a reason.
  const COVERAGE_EXCLUDE_ALLOWED: Record<string, readonly string[]> = {
    // The five processes of the LangGraph example: each reads its environment, calls a covered function in
    // src/ and exits. test/demo.test.ts starts the four of the demo as separate node processes, and
    // test/browser.test.ts starts the built browser wrapper; the processes run from dist/, so the coverage
    // report does not see them.
    'examples/langgraph-approvals': [
      'src/bin/agent.ts',
      'src/bin/worker.ts',
      'src/bin/approve.ts',
      'src/bin/demo.ts',
      'src/bin/browser.ts',
    ],
    // `adapter.ts` builds an agent and starts a worker, and `connect.ts` reads the mock's tokens when it is
    // imported: the snippets workspace typechecks both and examples/langgraph-approvals runs the loop.
    'docs/snippets': ['adapter.ts', 'connect.ts'],
    // The skill's acceptance run packs, installs and starts processes, so CI's `skill / langgraph` job
    // (`bun run exercise:skill`) is its test. What it is made of is in skill-exercise-agent-support.ts and
    // skill-exercise-common.ts, which are covered.
    scripts: ['skill-exercise-agent.ts'],
  };

  it.each(packages.map((p) => relDir(p.dir)))(
    '%s runs vitest with coverage at an 80 percent threshold',
    (dir) => {
      const config = read(`${dir}/vitest.config.ts`);
      for (const metric of ['lines', 'functions', 'branches', 'statements']) {
        expect(config, metric).toMatch(new RegExp(`${metric}: 80,`));
      }
      const scripts = (readJson(`${dir}/package.json`).scripts ?? {}) as Record<string, string>;
      expect(scripts.test).toBe('vitest run --coverage');
    }
  );

  it.each(packages.map((p) => relDir(p.dir)))(
    '%s measures coverage over all of its source',
    async (dir) => {
      const module = (await import(join(ROOT, dir, 'vitest.config.ts'))) as {
        default: { test?: { coverage?: { include?: string[]; exclude?: string[] } } };
      };
      const coverage = module.default.test?.coverage ?? {};
      expect(coverage.include?.length, 'coverage.include').toBeGreaterThan(0);
      for (const glob of coverage.include ?? []) expect(glob).toMatch(/(^|\/)\*(\*\/\*)?\.tsx?$/);
      expect(
        coverageExcludeViolations(coverage.exclude ?? [], COVERAGE_EXCLUDE_ALLOWED[dir] ?? [])
      ).toEqual([]);
    }
  );

  it("the coverage exclude check rejects an unlisted source file and another package's listing", () => {
    expect(
      coverageExcludeViolations(['**/*.test.ts', 'vitest.config.ts', 'src/a.ts'], ['src/a.ts'])
    ).toEqual([]);
    expect(coverageExcludeViolations(['src/secret.ts'], ['src/a.ts'])).toEqual(['src/secret.ts']);
    expect(coverageExcludeViolations(['src/a.ts'], [])).toEqual(['src/a.ts']);
    expect(coverageExcludeViolations(['src/**/*.ts'], [])).toEqual(['src/**/*.ts']);
  });

  it('every allowed coverage exclude carries a reason and names a file that exists', () => {
    for (const [dir, files] of Object.entries(COVERAGE_EXCLUDE_ALLOWED)) {
      expect(files.length, dir).toBeGreaterThan(0);
      for (const file of files)
        expect(existsSync(join(ROOT, dir, file)), `${dir}/${file}`).toBe(true);
    }
  });

  it('the root gate runs the four checked tasks through turbo, then the build', () => {
    const scripts = readJson('package.json').scripts as Record<string, string>;
    expect(scripts.gate).toBe('turbo run format:check lint typecheck test && bun run build');
  });
});

// A step that publishes a package or deploys a site, by command or by action. `scripts/release.ts` is the
// repository's own publish script, so a job that calls it by path is a release job too.
const RELEASE_RUN =
  /\b(npm|bun|pnpm|yarn)\s+(npm\s+)?publish\b|\bchangeset\s+publish\b|\brun\s+release\b|\bscripts\/release\.ts\b|\bwrangler\b|\baws\s+s3\b|\bgh-pages\b|\bnetlify\s+deploy\b|\bvercel\b|\bfirebase\s+deploy\b|\bgh\s+release\b|\bsurge\b/;
const RELEASE_ACTION =
  /^(actions\/deploy-pages|peaceiris\/actions-gh-pages|JamesIves\/github-pages-deploy-action|cloudflare\/[\w-]+|aws-actions\/[\w-]+|nwtgck\/actions-netlify|amondnet\/vercel-action|softprops\/action-gh-release)@/;
const isReleaseStep = (step: Step): boolean =>
  RELEASE_RUN.test(step.run ?? '') ||
  RELEASE_ACTION.test(step.uses ?? '') ||
  (step.uses?.startsWith('changesets/action@') === true && step.with?.publish !== undefined);
const isPlainMap = (value: unknown): value is Record<string, string> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
// `write-all` (or any string other than `read-all`) grants every write scope, id-token and packages included.
const grantsEverything = (permissions: Permissions | undefined): boolean =>
  typeof permissions === 'string' && permissions !== 'read-all';
const isReleaseJob = (name: string, job: Job): boolean =>
  name === 'publish' ||
  name === 'deploy' ||
  grantsEverything(job.permissions) ||
  (isPlainMap(job.permissions) &&
    (job.permissions['id-token'] === 'write' || job.permissions.packages === 'write')) ||
  (job.steps ?? []).some(isReleaseStep);

const NPM_GATE = "vars.PUBLIC_RELEASE_ENABLED == 'true'";
const PRIVATE_GATE = [
  "github.repository_owner == 'NobleCloak'",
  "vars.PRIVATE_PUBLISH_ENABLED == 'true'",
] as const;
const GITHUB_REGISTRY = 'https://npm.pkg.github.com';
// The one command the private gate admits: the release script pointed at the GitHub registry, and nothing
// chained after it.
const GITHUB_RELEASE_COMMAND = new RegExp(
  `^bun --no-install scripts/release\\.ts --registry ${GITHUB_REGISTRY.replace(/\./g, '\\.')}$`
);

/**
 * The `&&` terms of a condition, or undefined when it holds an `||`, a negation or a grouping, any of which
 * could weaken the gate.
 */
const gateTerms = (condition: string | undefined): string[] | undefined => {
  const expression = (condition ?? '')
    .trim()
    .replace(/^\$\{\{([\s\S]*)\}\}$/, '$1')
    .trim();
  if (/\|\||!(?!=)|[()]/.test(expression)) return undefined;
  return expression.split('&&').map((term) => term.trim());
};

/**
 * True when the job is gated. The npm gate (the gate alone, or ANDed with other terms) admits any release
 * job. The private gate (both of its terms) admits a job only when every release step in it is exactly
 * `bun --no-install scripts/release.ts --registry https://npm.pkg.github.com` (so no other command can be
 * chained to it), which publishes to the GitHub registry only.
 */
const isGated = (job: Job): boolean => {
  const terms = gateTerms(job.if);
  if (terms === undefined) return false;
  if (terms.includes(NPM_GATE)) return true;
  const releaseSteps = (job.steps ?? []).filter(isReleaseStep);
  return (
    PRIVATE_GATE.every((term) => terms.includes(term)) &&
    releaseSteps.length > 0 &&
    releaseSteps.every((step) => GITHUB_RELEASE_COMMAND.test((step.run ?? '').trim()))
  );
};

/** The release jobs of a workflow that are not gated. */
const ungatedReleaseJobs = (workflow: Workflow): string[] =>
  Object.entries(workflow.jobs)
    .filter(([name, job]) => isReleaseJob(name, job) && !isGated(job))
    .map(([name]) => name);

/**
 * Every `scope: write` grant as `<file>:<job or (workflow)>:<scope>`; a string block that grants everything
 * (`write-all`) is `<file>:<job or (workflow)>:*`.
 */
const writers = (files: Record<string, Workflow>): string[] => {
  const found: string[] = [];
  for (const [file, workflow] of Object.entries(files)) {
    const scopes = [
      ['(workflow)', workflow.permissions],
      ...Object.entries(workflow.jobs).map(([name, job]) => [name, job.permissions] as const),
    ] as const;
    for (const [name, permissions] of scopes) {
      if (typeof permissions === 'string') {
        if (grantsEverything(permissions)) found.push(`${file}:${name}:*`);
        continue;
      }
      for (const [scope, level] of Object.entries(permissions ?? {})) {
        if (level === 'write') found.push(`${file}:${name}:${scope}`);
      }
    }
  }
  return found.sort();
};

const holdsWrite = (permissions: Permissions | undefined): boolean =>
  grantsEverything(permissions) ||
  (isPlainMap(permissions) && Object.values(permissions).includes('write'));

/**
 * `<file>:<job>` for every job that holds any write scope (its own block, or the workflow's when the job has
 * none; `write-all` counts) and has a checkout step that does not set `persist-credentials: false`, which
 * would leave the job's token in `.git/config` for every later step, dependency code included.
 */
const persistingCheckouts = (files: Record<string, Workflow>): string[] => {
  const found: string[] = [];
  for (const [file, workflow] of Object.entries(files)) {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      const permissions = job.permissions ?? workflow.permissions;
      if (!holdsWrite(permissions)) continue;
      const bad = (job.steps ?? []).some(
        (step) =>
          step.uses?.startsWith('actions/checkout@') === true &&
          step.with?.['persist-credentials'] !== false
      );
      if (bad) found.push(`${file}:${name}`);
    }
  }
  return found.sort();
};

/**
 * Where a workflow's permissions leave the narrow shape: the top level must be exactly `contents: read`
 * (without it every job inherits the repository default token), and a job's block must be absent or a scope
 * map (a string such as `write-all` is not).
 */
const permissionShapeViolations = (workflow: Workflow): string[] => {
  const found: string[] = [];
  if (JSON.stringify(workflow.permissions) !== JSON.stringify({ contents: 'read' }))
    found.push('(workflow)');
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if ('permissions' in job && !isPlainMap(job.permissions)) found.push(name);
  }
  return found;
};

/**
 * What ci.yml must run: `gate` installs from the lockfile and runs the gate, the guard and actionlint, `skill`
 * runs the setup skill's acceptance run, and there is no matrix (two runners, GitHub Actions minutes are
 * metered). Returns the missing or extra pieces.
 */
const ciViolations = (workflow: Workflow): string[] => {
  const found: string[] = [];
  const runs = (key: string): string[] =>
    (workflow.jobs[key]?.steps ?? []).map((step) => (step.run ?? '').trim());
  for (const command of ['bun install --frozen-lockfile', 'bun run gate', 'bun run guard']) {
    if (!runs('gate').includes(command)) found.push(`gate runs ${command}`);
  }
  if (
    !(workflow.jobs.gate?.steps ?? []).some((step) =>
      (step.uses ?? '').startsWith('docker://rhysd/actionlint@')
    )
  )
    found.push('gate runs actionlint');
  if (!runs('skill').includes('bun run exercise:skill')) found.push('skill runs exercise:skill');
  for (const [key, job] of Object.entries(workflow.jobs)) {
    if ('strategy' in (job as object)) found.push(`${key} has a strategy`);
  }
  return found;
};

/** Job keys without an explicit `name`, and check names (job `name`) used more than once across workflows. */
const jobNameViolations = (files: Record<string, Workflow>): string[] => {
  const missing: string[] = [];
  const names: string[] = [];
  for (const [file, workflow] of Object.entries(files)) {
    for (const [key, job] of Object.entries(workflow.jobs)) {
      if (job.name === undefined) missing.push(`${file}:${key} has no name`);
      names.push(job.name ?? key);
    }
  }
  return [...missing, ...new Set(names.filter((name, index) => names.indexOf(name) !== index))];
};

/**
 * Lines that use the secrets context outside a comment: secrets.X, secrets['X'], toJSON(secrets), a bare
 * `if: secrets.X` condition, or `secrets: inherit` on a reusable-workflow call.
 */
const secretLines = (raw: string): string[] =>
  raw.split('\n').filter((line) => /\bsecrets\b/.test(line.replace(/(^|\s)#.*$/, '')));

const SHA_PIN = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;
const DIGEST_PIN = /^docker:\/\/[\w./-]+@sha256:[0-9a-f]{64}$/;

/**
 * Every `uses` that is not a full commit SHA or an image digest (step and job level), and every `uses:` line
 * (quoted or not) whose pin has no version comment: ` # vX.Y.Z` after a SHA, ` # X.Y.Z` after a digest.
 */
const unpinnedUses = (workflow: Workflow, raw: string): string[] => {
  const found: string[] = [];
  const values = Object.values(workflow.jobs).flatMap((job) => [
    ...(job.uses === undefined ? [] : [job.uses]),
    ...(job.steps ?? []).flatMap((step) => (step.uses === undefined ? [] : [step.uses])),
  ]);
  for (const value of values) {
    if (!SHA_PIN.test(value) && !DIGEST_PIN.test(value))
      found.push(`${value}: not a SHA or digest pin`);
  }
  for (const line of raw.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const value = /\buses:\s*['"]?([^'"\s#]+)['"]?/.exec(line)?.[1];
    if (value === undefined) continue;
    if (SHA_PIN.test(value) && !/ # v\d+\.\d+\.\d+$/.test(line))
      found.push(`${value}: no # vX.Y.Z comment`);
    if (DIGEST_PIN.test(value) && !/ # \d+\.\d+\.\d+$/.test(line))
      found.push(`${value}: no # X.Y.Z comment`);
  }
  return found;
};

/** The jobs that install the contract packages from the package registry, by workflow file. */
const REGISTRY_READERS: Record<string, readonly string[]> = {
  'ci.yml': ['gate', 'skill'],
  'publish.yml': ['pack', 'version'],
};
const JOB_TOKEN = '${{ github.token }}';

/**
 * Where the registry readers would install without the job token: each must hold `packages: read` with
 * `contents: read` beside it (a job-level block replaces the inherited one), and every `bun install` step and
 * the `bun run exercise:skill` step must carry `NODE_AUTH_TOKEN: ${{ github.token }}`, which the root .npmrc
 * reads. Returns `<file>:<job>` or `<file>:<job>:<run>` per gap.
 */
const registryReadViolations = (files: Record<string, Workflow>): string[] => {
  const found: string[] = [];
  for (const [file, jobs] of Object.entries(REGISTRY_READERS)) {
    for (const name of jobs) {
      const job = files[file]?.jobs[name];
      if (job === undefined) {
        found.push(`${file}:${name} is missing`);
        continue;
      }
      const permissions = isPlainMap(job.permissions) ? job.permissions : {};
      if (permissions.packages !== 'read' || permissions.contents === undefined)
        found.push(`${file}:${name}`);
    }
  }
  for (const [file, workflow] of Object.entries(files)) {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      for (const step of job.steps ?? []) {
        const run = (step.run ?? '').trim();
        if (!/^bun install\b/.test(run) && run !== 'bun run exercise:skill') continue;
        if (step.env?.NODE_AUTH_TOKEN !== JOB_TOKEN) found.push(`${file}:${name}:${run}`);
      }
    }
  }
  return found;
};

const INSTALL_OR_BUILD =
  /\b(bun|npm|pnpm|yarn)\s+(install|i|ci|add)\b|\bbun\s+x\b|\bbunx\b|\bnpx\b|\bturbo\b|\brun\s+(build|pack:all)\b/;

describe('workflows', () => {
  const allWorkflows = Object.fromEntries(workflowFiles.map((f) => [f, loadWorkflow(f)]));
  const publish = (): Workflow => structuredClone(allWorkflows['publish.yml'] ?? { jobs: {} });

  it('the repository has exactly the ci and publish workflows', () => {
    expect(workflowFiles.sort()).toEqual(['ci.yml', 'publish.yml']);
  });

  it.each(workflowFiles)('%s pins every action to a full commit SHA or image digest', (file) => {
    expect(unpinnedUses(loadWorkflow(file), read(`.github/workflows/${file}`))).toEqual([]);
  });

  it('the pin check rejects a tag, a short SHA, a missing comment and a reusable workflow on a branch', () => {
    const sha = '3d3c42e5aac5ba805825da76410c181273ba90b1';
    const digest = `sha256:${'b'.repeat(64)}`;
    const workflow = (uses: string, job: Partial<Job> = {}): Workflow => ({
      jobs: { x: { name: 'x', steps: [{ uses }], ...job } },
    });
    const check = (uses: string, line: string, job: Partial<Job> = {}): string[] =>
      unpinnedUses(workflow(uses, job), line);

    expect(check(`actions/checkout@${sha}`, `- uses: actions/checkout@${sha} # v7.0.1`)).toEqual(
      []
    );
    expect(check(`actions/checkout@${sha}`, `- uses: "actions/checkout@${sha}" # v7.0.1`)).toEqual(
      []
    );
    expect(
      check(
        `docker://rhysd/actionlint@${digest}`,
        `uses: docker://rhysd/actionlint@${digest} # 1.7.12`
      )
    ).toEqual([]);

    // The ref is not a full SHA.
    expect(check('actions/checkout@v7', 'uses: actions/checkout@v7')).not.toEqual([]);
    expect(
      check('actions/checkout@3d3c42e', 'uses: actions/checkout@3d3c42e # v7.0.1')
    ).not.toEqual([]);
    expect(
      check('docker://rhysd/actionlint:1.7.12', 'uses: docker://rhysd/actionlint:1.7.12')
    ).not.toEqual([]);
    // A SHA with no version comment, a major-only comment, quoted or not.
    expect(check(`actions/checkout@${sha}`, `uses: actions/checkout@${sha}`)).not.toEqual([]);
    expect(check(`actions/checkout@${sha}`, `uses: "actions/checkout@${sha}"`)).not.toEqual([]);
    expect(check(`actions/checkout@${sha}`, `uses: actions/checkout@${sha} # v7`)).not.toEqual([]);
    // A digest with no version comment.
    expect(
      check(`docker://rhysd/actionlint@${digest}`, `uses: docker://rhysd/actionlint@${digest}`)
    ).not.toEqual([]);
    // A job-level reusable-workflow call is an action too.
    const reusable = unpinnedUses(
      { jobs: { reuse: { name: 'reuse', uses: 'someorg/repo/.github/workflows/x.yml@main' } } },
      'uses: someorg/repo/.github/workflows/x.yml@main'
    );
    expect(reusable).not.toEqual([]);
  });

  // A required status check is matched by job name alone, across every workflow, so each check name must
  // be unique or branch protection cannot tell two jobs apart.
  it('every job has an explicit name, unique across workflows', () => {
    expect(jobNameViolations(allWorkflows)).toEqual([]);
  });

  it('the job name check rejects a missing name and a name shared across workflows', () => {
    const job = (name?: string): Job => ({ ...(name === undefined ? {} : { name }), steps: [] });
    expect(jobNameViolations({ 'a.yml': { jobs: { x: job('one') } } })).toEqual([]);
    expect(jobNameViolations({ 'a.yml': { jobs: { x: job() } } })).toEqual(['a.yml:x has no name']);
    expect(jobNameViolations({ 'a.yml': { jobs: { x: job('same'), y: job('same') } } })).toEqual([
      'same',
    ]);
    expect(
      jobNameViolations({
        'a.yml': { jobs: { x: job('same') } },
        'b.yml': { jobs: { y: job('same') } },
      })
    ).toEqual(['same']);
  });

  it.each(workflowFiles)('%s reads no secrets', (file) => {
    expect(secretLines(read(`.github/workflows/${file}`))).toEqual([]);
  });

  it('the secrets check finds every form of the secrets context and skips comments', () => {
    for (const line of [
      'NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}',
      "token: ${{ secrets['NPM_TOKEN'] }}",
      'x: ${{ toJSON(secrets) }}',
      'if: secrets.NPM_TOKEN',
      'secrets: inherit',
    ])
      expect(secretLines(line), line).toEqual([line]);
    expect(secretLines('# secrets.NPM_TOKEN is never read\nrun: echo hi # secrets.X')).toEqual([]);
  });

  it('isGated accepts the npm gate or the private gate and nothing weaker', () => {
    const npmStep: Step = { run: 'bun run release' };
    const githubStep: Step = {
      run: `bun --no-install scripts/release.ts --registry ${GITHUB_REGISTRY}`,
    };
    const privateIf = PRIVATE_GATE.join(' && ');
    const gated = (condition: string | undefined, step: Step): boolean =>
      isGated({ ...(condition === undefined ? {} : { if: condition }), steps: [step] });
    expect(gated(NPM_GATE, npmStep)).toBe(true);
    expect(gated(`\${{ ${NPM_GATE} }}`, npmStep)).toBe(true);
    expect(gated(`github.event_name == 'push' && ${NPM_GATE}`, npmStep)).toBe(true);
    expect(gated(`github.event_name == 'push' || ${NPM_GATE}`, npmStep)).toBe(false);
    expect(gated(`!(${NPM_GATE})`, npmStep)).toBe(false);
    expect(gated(`always() && ${NPM_GATE}`, npmStep)).toBe(false);
    expect(gated(`${NPM_GATE}x`, npmStep)).toBe(false);
    expect(gated(undefined, npmStep)).toBe(false);
    expect(gated(privateIf, githubStep)).toBe(true);
    // The private gate never admits a step that does not name the GitHub registry.
    expect(gated(privateIf, npmStep)).toBe(false);
    expect(
      gated(privateIf, {
        run: `bun --no-install scripts/release.ts --registry ${GITHUB_REGISTRY}.evil.test`,
      })
    ).toBe(false);
    expect(gated(privateIf, { run: 'bun --no-install scripts/release.ts' })).toBe(false);
    // Another publish chained after the release script, or a second release step, is not admitted.
    expect(
      gated(privateIf, {
        run: `bun --no-install scripts/release.ts --registry ${GITHUB_REGISTRY} && npm publish artifacts/x.tgz --registry https://registry.npmjs.org`,
      })
    ).toBe(false);
    expect(
      gated(privateIf, {
        run: `bun --no-install scripts/release.ts --registry ${GITHUB_REGISTRY}\nnpm publish artifacts/x.tgz`,
      })
    ).toBe(false);
    expect(isGated({ if: privateIf, steps: [githubStep, npmStep] })).toBe(false);
    // Both of its terms are needed.
    expect(gated(PRIVATE_GATE[0], githubStep)).toBe(false);
    expect(gated(PRIVATE_GATE[1], githubStep)).toBe(false);
    expect(gated(`${privateIf} || true`, githubStep)).toBe(false);
  });

  it('the release step pattern covers the release script called by path', () => {
    expect(RELEASE_RUN.test('bun --no-install scripts/release.ts --registry x')).toBe(true);
    expect(RELEASE_RUN.test('bun run release')).toBe(true);
    expect(RELEASE_RUN.test('bun run gate')).toBe(false);
  });

  it('publish.yml has exactly the two publish jobs, and every release job in every workflow is gated', () => {
    const releaseJobs = Object.entries(publish().jobs)
      .filter(([name, job]) => isReleaseJob(name, job))
      .map(([name]) => name);
    expect(releaseJobs.sort()).toEqual(['publish', 'publish-github-packages']);
    for (const [file, workflow] of Object.entries(allWorkflows)) {
      expect(ungatedReleaseJobs(workflow), `${file} ungated release jobs`).toEqual([]);
    }
  });

  it('the guard rejects a release job that loses its gate or takes the wrong one', () => {
    const dropped = publish();
    delete dropped.jobs.publish?.if;
    expect(ungatedReleaseJobs(dropped)).toEqual(['publish']);

    const privateOnNpm = publish();
    const npmJob = privateOnNpm.jobs.publish;
    if (npmJob === undefined) throw new Error('publish job missing');
    npmJob.if = PRIVATE_GATE.join(' && ');
    expect(ungatedReleaseJobs(privateOnNpm)).toEqual(['publish']);

    const noFlag = publish();
    const githubJob = noFlag.jobs['publish-github-packages'];
    if (githubJob === undefined) throw new Error('publish-github-packages job missing');
    githubJob.steps = (githubJob.steps ?? []).map((step) =>
      step.run?.includes('scripts/release.ts') === true
        ? { ...step, run: 'bun --no-install scripts/release.ts' }
        : step
    );
    expect(ungatedReleaseJobs(noFlag)).toEqual(['publish-github-packages']);

    // A job under another name that calls the release script by path is a release job all the same.
    const hidden = publish();
    hidden.jobs.other = {
      name: 'other',
      steps: [{ run: 'bun --no-install scripts/release.ts' }],
    };
    expect(ungatedReleaseJobs(hidden)).toEqual(['other']);
  });

  it('grants write permissions only to the version job, id-token only to publish npm, packages only to publish github-packages', () => {
    expect(writers(allWorkflows)).toEqual([
      'publish.yml:publish-github-packages:packages',
      'publish.yml:publish:id-token',
      'publish.yml:version:contents',
      'publish.yml:version:pull-requests',
    ]);
    const prose = (
      read('CONTRIBUTING.md').split('## CI and publishing')[1]?.split('\n## ')[0] ?? ''
    ).replace(/\s+/g, ' ');
    expect(prose).toContain('only job in any workflow with `contents` or `pull-requests` write');
    expect(prose).toContain('The `publish npm` job alone holds `id-token: write`');
    expect(prose).toContain('the `publish github-packages` job alone holds `packages: write`');
  });

  // Kills: dropping `persist-credentials: false` from the checkout of the version job (or of any job that
  // holds a write scope), which would leave github.token in .git/config while bun install and
  // changesets/action run dependency code.
  it('checks out without persisting credentials in every job that holds a write permission', () => {
    expect(persistingCheckouts(allWorkflows)).toEqual([]);
    const version = allWorkflows['publish.yml']?.jobs.version;
    expect(version?.steps?.some((s) => s.uses?.startsWith('actions/checkout@'))).toBe(true);

    const dropped = publish();
    const job = dropped.jobs.version;
    if (job === undefined) throw new Error('version job missing');
    job.steps = (job.steps ?? []).map((step) =>
      step.uses?.startsWith('actions/checkout@') === true ? { uses: step.uses } : step
    );
    expect(persistingCheckouts({ 'publish.yml': dropped })).toEqual(['publish.yml:version']);

    // The write-all form and a workflow-level write reach jobs that carry no block of their own.
    const writeAll = publish();
    const pack = writeAll.jobs.pack;
    if (pack === undefined) throw new Error('pack job missing');
    pack.permissions = 'write-all';
    pack.steps = (pack.steps ?? []).map((step) =>
      step.uses?.startsWith('actions/checkout@') === true ? { uses: step.uses } : step
    );
    expect(persistingCheckouts({ 'publish.yml': writeAll })).toEqual(['publish.yml:pack']);

    const inherited = publish();
    inherited.permissions = { contents: 'write' };
    const inheritedPack = inherited.jobs.pack;
    if (inheritedPack === undefined) throw new Error('pack job missing');
    // Without a block of its own the job inherits the workflow's.
    delete inheritedPack.permissions;
    inheritedPack.steps = (inheritedPack.steps ?? []).map((step) =>
      step.uses?.startsWith('actions/checkout@') === true ? { uses: step.uses } : step
    );
    expect(persistingCheckouts({ 'publish.yml': inherited })).toContain('publish.yml:pack');
  });

  it.each(workflowFiles)(
    '%s has top-level contents: read and only map-shaped job permissions',
    (file) => {
      expect(permissionShapeViolations(allWorkflows[file] ?? { jobs: {} })).toEqual([]);
    }
  );

  it('ci runs the install, the gate, the guard, actionlint and the skill exercise, with no matrix', () => {
    expect(ciViolations(allWorkflows['ci.yml'] ?? { jobs: {} })).toEqual([]);
    const ci = (): Workflow => structuredClone(allWorkflows['ci.yml'] ?? { jobs: {} });
    expect(ciViolations(ci())).toEqual([]);

    const dropStep = (job: string, drop: (step: Step) => boolean): Workflow => {
      const workflow = ci();
      const target = workflow.jobs[job];
      if (target === undefined) throw new Error(`${job} job missing`);
      target.steps = (target.steps ?? []).filter((step) => !drop(step));
      return workflow;
    };
    expect(ciViolations(dropStep('gate', (s) => s.run === 'bun run gate'))).toEqual([
      'gate runs bun run gate',
    ]);
    expect(ciViolations(dropStep('gate', (s) => s.run === 'bun run guard'))).toEqual([
      'gate runs bun run guard',
    ]);
    expect(
      ciViolations(dropStep('gate', (s) => s.run === 'bun install --frozen-lockfile'))
    ).toEqual(['gate runs bun install --frozen-lockfile']);
    expect(
      ciViolations(
        dropStep('gate', (s) => s.uses?.startsWith('docker://rhysd/actionlint@') === true)
      )
    ).toEqual(['gate runs actionlint']);
    expect(ciViolations(dropStep('skill', (s) => s.run === 'bun run exercise:skill'))).toEqual([
      'skill runs exercise:skill',
    ]);

    const noSkill = ci();
    delete noSkill.jobs.skill;
    expect(ciViolations(noSkill)).toEqual(['skill runs exercise:skill']);

    const matrix = ci();
    const gate = matrix.jobs.gate;
    if (gate === undefined) throw new Error('gate job missing');
    (gate as { strategy?: unknown }).strategy = { matrix: { os: ['ubuntu-latest'] } };
    expect(ciViolations(matrix)).toEqual(['gate has a strategy']);
  });

  it('the permission checks reject write-all and a missing top-level block', () => {
    const ci = (): Workflow => structuredClone(allWorkflows['ci.yml'] ?? { jobs: {} });

    const noTop = ci();
    delete noTop.permissions;
    expect(permissionShapeViolations(noTop)).toEqual(['(workflow)']);

    const topWriteAll = ci();
    topWriteAll.permissions = 'write-all';
    expect(permissionShapeViolations(topWriteAll)).toEqual(['(workflow)']);
    expect(writers({ 'ci.yml': topWriteAll })).toEqual(['ci.yml:(workflow):*']);

    const jobWriteAll = ci();
    const gate = jobWriteAll.jobs.gate;
    if (gate === undefined) throw new Error('gate job missing');
    gate.permissions = 'write-all';
    expect(permissionShapeViolations(jobWriteAll)).toEqual(['gate']);
    expect(writers({ 'ci.yml': jobWriteAll })).toEqual(['ci.yml:gate:*']);
    // A write-all job is a release job, so it must carry a gate it does not have.
    expect(ungatedReleaseJobs(jobWriteAll)).toEqual(['gate']);

    const emptyBlock = ci();
    const skill = emptyBlock.jobs.skill;
    if (skill === undefined) throw new Error('skill job missing');
    (skill as { permissions?: unknown }).permissions = null;
    expect(permissionShapeViolations(emptyBlock)).toEqual(['skill']);

    // `read-all` grants no write.
    const readAll = ci();
    readAll.permissions = 'read-all';
    expect(writers({ 'ci.yml': readAll })).toEqual([]);
  });

  it('the writers check names a workflow-level write and an extra job-level write', () => {
    const widened = publish();
    widened.permissions = { contents: 'write' };
    const pack = widened.jobs.pack;
    if (pack === undefined) throw new Error('pack job missing');
    pack.permissions = { 'id-token': 'write' };
    expect(writers({ 'publish.yml': widened })).toEqual(
      expect.arrayContaining(['publish.yml:(workflow):contents', 'publish.yml:pack:id-token'])
    );
  });

  // A job that holds a publish credential installs and builds nothing: no package from the lockfile runs
  // there. It publishes the artifact the pack job built, and the pack job holds no extra permission.
  it('the publish jobs install and build nothing and publish the pack artifact', () => {
    const jobs = publish().jobs;
    for (const key of ['publish', 'publish-github-packages']) {
      const job = jobs[key];
      expect(job, key).toBeDefined();
      for (const step of job?.steps ?? [])
        expect(step.run ?? '', key).not.toMatch(INSTALL_OR_BUILD);
      expect(job?.needs, key).toEqual('pack');
      const download = job?.steps?.find((s) => s.uses?.startsWith('actions/download-artifact@'));
      expect(download?.with, key).toEqual({ name: 'npm-packages', path: 'artifacts' });
    }
    const scripts = readJson('package.json').scripts as Record<string, string>;
    expect(scripts.release).toBe('bun --no-install scripts/release.ts');
    const pack = jobs.pack;
    const upload = pack?.steps?.find((s) => s.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.with?.name).toBe('npm-packages');
    // The pack job reads the contract packages from the registry and holds no write.
    expect(pack?.permissions).toEqual({ contents: 'read', packages: 'read' });
  });

  it('every job that installs reads the package registry with the job token, and the top level stays contents: read', () => {
    expect(registryReadViolations(allWorkflows)).toEqual([]);
    for (const file of ['ci.yml', 'publish.yml'])
      expect(allWorkflows[file]?.permissions, file).toEqual({ contents: 'read' });
    expect(allWorkflows['publish.yml']?.jobs.version?.permissions).toEqual({
      contents: 'write',
      'pull-requests': 'write',
      packages: 'read',
    });
    const workflows = (): Record<string, Workflow> => structuredClone(allWorkflows);
    const job = (files: Record<string, Workflow>, file: string, name: string): Job => {
      const found = files[file]?.jobs[name];
      if (found === undefined) throw new Error(`${file}:${name} missing`);
      return found;
    };

    const noBlock = workflows();
    delete job(noBlock, 'ci.yml', 'gate').permissions;
    expect(registryReadViolations(noBlock)).toEqual(['ci.yml:gate']);

    const noPackages = workflows();
    job(noPackages, 'publish.yml', 'version').permissions = {
      contents: 'write',
      'pull-requests': 'write',
    };
    expect(registryReadViolations(noPackages)).toEqual(['publish.yml:version']);

    const noContents = workflows();
    job(noContents, 'ci.yml', 'skill').permissions = { packages: 'read' };
    expect(registryReadViolations(noContents)).toEqual(['ci.yml:skill']);

    const missing = workflows();
    delete missing['publish.yml']?.jobs.pack;
    expect(registryReadViolations(missing)).toEqual(['publish.yml:pack is missing']);

    const noToken = workflows();
    for (const [file, name, run] of [
      ['ci.yml', 'gate', 'bun install --frozen-lockfile'],
      ['ci.yml', 'skill', 'bun run exercise:skill'],
      ['publish.yml', 'pack', 'bun install --frozen-lockfile'],
    ] as const) {
      const step = (job(noToken, file, name).steps ?? []).find((s) => s.run?.trim() === run);
      if (step === undefined) throw new Error(`${file}:${name} has no ${run}`);
      delete step.env;
    }
    const wrongToken = job(noToken, 'publish.yml', 'version').steps?.find(
      (s) => s.run?.trim() === 'bun install --frozen-lockfile'
    );
    if (wrongToken === undefined) throw new Error('version has no install');
    wrongToken.env = { NODE_AUTH_TOKEN: '${{ secrets.NPM_TOKEN }}' };
    expect(registryReadViolations(noToken)).toEqual([
      'ci.yml:gate:bun install --frozen-lockfile',
      'ci.yml:skill:bun run exercise:skill',
      'publish.yml:pack:bun install --frozen-lockfile',
      'publish.yml:version:bun install --frozen-lockfile',
    ]);
  });

  it('the install-or-build pattern matches what it forbids', () => {
    for (const run of [
      'bun install',
      'bun run build',
      'bun run pack:all',
      'bunx tsc',
      'npx x',
      'turbo run build',
    ])
      expect(INSTALL_OR_BUILD.test(run), run).toBe(true);
    expect(INSTALL_OR_BUILD.test('bun --no-install scripts/release.ts')).toBe(false);
  });

  it('publish github-packages publishes only to the GitHub registry with the run token', () => {
    const job = publish().jobs['publish-github-packages'];
    expect(job?.permissions).toEqual({ contents: 'read', packages: 'write' });
    expect(job?.if).toBe(PRIVATE_GATE.join(' && '));
    const setupNode = job?.steps?.find((s) => s.uses?.startsWith('actions/setup-node@'));
    expect(setupNode?.with?.['registry-url']).toBe(GITHUB_REGISTRY);
    expect(setupNode?.with?.scope).toBe('@noblecloak');
    const release = (job?.steps ?? []).filter(isReleaseStep);
    expect(release).toHaveLength(1);
    expect(release[0]?.run).toBe(
      `bun --no-install scripts/release.ts --registry ${GITHUB_REGISTRY}`
    );
    expect(release[0]?.env).toEqual({ NODE_AUTH_TOKEN: '${{ github.token }}' });
  });

  // A v* tag push runs publish.yml as it exists at the tagged commit, so the workflow file cannot guard
  // itself. npm's trusted publisher is bound to the npm-publish environment.
  it('publish npm runs in the npm-publish environment, behind the public gate, with the plain release script', () => {
    const job = publish().jobs.publish;
    expect(job?.environment).toBe('npm-publish');
    expect(job?.if).toBe(NPM_GATE);
    expect(job?.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect((job?.steps ?? []).filter(isReleaseStep).map((s) => s.run)).toEqual(['bun run release']);
  });
});
