import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listTarEntries, missingEntries, packAll, verifyTarballs } from './pack-all.js';
import type { Runner } from './pack-all.js';
import {
  GITHUB_ALLOWLIST,
  GITHUB_REGISTRY,
  checkOnly,
  main,
  npmView,
  registryFlags,
  NPM_REGISTRY,
  decide,
  internalDependencies,
  parseNpmView,
  parseRegistry,
  publishOrder,
  readPackedManifest,
  release,
  tarballFor,
  unmetDependencies,
} from './release.js';
import type { RegistryState } from './release.js';
import { listPublicPackages, listWorkspacePackages } from './workspace.js';

let root: string;

function writePackage(dir: string, manifest: Record<string, unknown>): void {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, 'package.json'), JSON.stringify(manifest));
  if (manifest.private !== true) {
    writeFileSync(join(root, dir, 'LICENSE'), 'Apache License\n');
    writeFileSync(join(root, dir, 'NOTICE'), 'NobleCloak\n');
  }
}

/** Writes a real tarball of the package's package.json, LICENSE and NOTICE, as bun would. */
function fakePack(cwd: string, tarball: string): void {
  const staging = mkdtempSync(join(tmpdir(), 'pack-staging-'));
  mkdirSync(join(staging, 'package'));
  for (const file of ['package.json', 'LICENSE', 'NOTICE']) {
    if (existsSync(join(cwd, file))) copyFileSync(join(cwd, file), join(staging, 'package', file));
  }
  spawnSync('tar', ['czf', tarball, '-C', staging, 'package']);
  rmSync(staging, { recursive: true, force: true });
}

/** A fake `bun pm pack` / `npm publish`: records calls, writes the tarball bun would write. */
function fakeRunner(calls: string[][], failPublish = false): Runner {
  return (command, args, cwd) => {
    calls.push([command, ...args]);
    if (command === 'bun') {
      const destination = args[args.indexOf('--destination') + 1] ?? '';
      const manifest = listWorkspacePackages(root).find((p) => p.dir === cwd);
      if (manifest === undefined) return 1;
      const base = manifest.name.replace(/^@/, '').replace('/', '-');
      fakePack(cwd, join(destination, `${base}-${manifest.version}.tgz`));
      return 0;
    }
    return failPublish ? 1 : 0;
  };
}

const SEEDED_CLIENT: RegistryState = { kind: 'versions', versions: ['0.10.0'] };

/** A lookup that answers from `entries` and says `@noblecloak/client@0.10.0` exists for any other name. */
function registry(entries: Record<string, RegistryState> = {}): (name: string) => RegistryState {
  return (name) => entries[name] ?? SEEDED_CLIENT;
}

const published = (calls: string[][]): string[] =>
  calls.filter((c) => c[0] === 'npm').map((c) => (c[2] ?? '').split('/').pop() ?? '');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'release-fixture-'));
  writePackage('.', {
    name: 'root',
    private: true,
    workspaces: ['packages/*', 'tools', 'missing/*'],
  });
  // The adapter depends on the contract client by exact version, as `bun pm pack` leaves a registry pin.
  writePackage('packages/langgraph', {
    name: '@noblecloak/langgraph',
    version: '1.0.0',
    dependencies: { '@noblecloak/client': '0.10.0', 'some-lib': '1.2.3' },
    peerDependencies: { langchain: '^1.5.15' },
    devDependencies: { '@noblecloak/spec': '9.9.9' },
  });
  // A second public package, which only the npm registry would publish.
  writePackage('packages/other', { name: '@noblecloak/other', version: '0.1.0' });
  writePackage('tools', { name: '@noblecloak/tools', version: '0.0.0', private: true });
  mkdirSync(join(root, 'packages/not-a-package'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('workspace listing', () => {
  it('resolves literal and trailing-star globs, only directories with a package.json', () => {
    expect(listWorkspacePackages(root).map((p) => p.name)).toEqual([
      '@noblecloak/langgraph',
      '@noblecloak/other',
      '@noblecloak/tools',
    ]);
  });

  it('treats a workspace without a workspaces field as empty', () => {
    writePackage('.', { name: 'root', private: true });
    expect(listWorkspacePackages(root)).toEqual([]);
  });

  it('lists only non-private packages as public', () => {
    expect(listPublicPackages(root).map((p) => p.name)).toEqual([
      '@noblecloak/langgraph',
      '@noblecloak/other',
    ]);
  });
});

describe('parseRegistry', () => {
  it('is npm when the flag is absent, and accepts exactly the two registries', () => {
    expect(parseRegistry([])).toBe(NPM_REGISTRY);
    expect(parseRegistry(['--registry', NPM_REGISTRY])).toBe(NPM_REGISTRY);
    expect(parseRegistry(['--registry', GITHUB_REGISTRY])).toBe(GITHUB_REGISTRY);
  });

  it.each([
    [['--registry', 'https://example.com']],
    [['--registry', `${NPM_REGISTRY}/`]],
    [['--registry', 'http://npm.pkg.github.com']],
    [['--registry']],
    [[`--registry=${GITHUB_REGISTRY}`]],
    [['--registry', GITHUB_REGISTRY, '--provenance']],
    [['--regsitry', GITHUB_REGISTRY]],
  ])('refuses %j', (args) => {
    expect(() => parseRegistry(args)).toThrow();
  });
});

describe('decide', () => {
  const seen: RegistryState = { kind: 'versions', versions: ['0.9.0', '1.0.0'] };
  it('skips a package npm has never seen, instead of publishing it with a token', () => {
    expect(decide('1.0.0', { kind: 'not-found' })).toBe('skip-not-seeded');
    expect(decide('1.0.0', { kind: 'not-found' }, NPM_REGISTRY)).toBe('skip-not-seeded');
  });
  it('publishes a package the GitHub registry has never seen', () => {
    expect(decide('1.0.0', { kind: 'not-found' }, GITHUB_REGISTRY)).toBe('publish');
  });
  it('skips a version that is already published, on either registry', () => {
    expect(decide('1.0.0', seen)).toBe('skip-already-published');
    expect(decide('1.0.0', seen, GITHUB_REGISTRY)).toBe('skip-already-published');
  });
  it('publishes a new version of a seeded package', () => {
    expect(decide('1.1.0', seen)).toBe('publish');
    expect(decide('1.1.0', seen, GITHUB_REGISTRY)).toBe('publish');
  });
});

describe('parseNpmView', () => {
  it('reads a version list', () => {
    expect(parseNpmView(0, '["0.1.0","0.2.0"]', '')).toEqual({
      kind: 'versions',
      versions: ['0.1.0', '0.2.0'],
    });
  });
  it('reads a single version', () => {
    expect(parseNpmView(0, '"0.1.0"', '')).toEqual({ kind: 'versions', versions: ['0.1.0'] });
  });
  it('maps a 404 to not-found', () => {
    expect(parseNpmView(1, '', 'npm error code E404')).toEqual({ kind: 'not-found' });
    expect(parseNpmView(1, '{"error":{"code":"E404"}}', '')).toEqual({ kind: 'not-found' });
  });
  it('throws on any other failure', () => {
    expect(() => parseNpmView(1, '', 'npm error code ETIMEDOUT')).toThrow(/ETIMEDOUT/);
  });
});

describe('packAll', () => {
  it('packs every public package into artifacts/', () => {
    const calls: string[][] = [];
    const tarballs = packAll(root, fakeRunner(calls));
    expect(tarballs.map((t) => t.split('/').pop())).toEqual([
      'noblecloak-langgraph-1.0.0.tgz',
      'noblecloak-other-0.1.0.tgz',
    ]);
    expect(calls).toHaveLength(2);
  });

  it('fails loudly when a pack fails', () => {
    expect(() => packAll(root, () => 2)).toThrow(/bun pm pack failed for @noblecloak\/langgraph/);
  });

  it('refuses a tarball that does not carry LICENSE and NOTICE', () => {
    rmSync(join(root, 'packages/other/NOTICE'));
    rmSync(join(root, 'packages/langgraph/LICENSE'));
    expect(() => packAll(root, fakeRunner([]))).toThrow(
      'noblecloak-langgraph-1.0.0.tgz is missing package/LICENSE\n' +
        'noblecloak-other-0.1.0.tgz is missing package/NOTICE'
    );
  });

  it('reads the entries of a real tarball', () => {
    const tarball = join(root, 'a.tgz');
    fakePack(join(root, 'packages/langgraph'), tarball);
    expect(listTarEntries(tarball)).toEqual(
      expect.arrayContaining(['package/package.json', 'package/LICENSE', 'package/NOTICE'])
    );
    expect(missingEntries(listTarEntries(tarball))).toEqual([]);
    expect(() => listTarEntries(join(root, 'missing.tgz'))).toThrow(/tar tzf failed/);
  });
});

describe('verifyTarballs', () => {
  it('fails when the artifact directory is missing or empty', () => {
    expect(() => verifyTarballs(join(root, 'artifacts'))).toThrow(/does not exist/);
    mkdirSync(join(root, 'artifacts'));
    expect(() => verifyTarballs(join(root, 'artifacts'))).toThrow(/holds no \.tgz files/);
  });
});

describe('release to npm (no --registry)', () => {
  beforeEach(() => {
    packAll(root, fakeRunner([]));
  });

  it('publishes the packed tarballs without packing, installing or building', () => {
    const calls: string[][] = [];
    expect(release(root, () => undefined, registry(), fakeRunner(calls))).toBe(0);
    expect(calls.map((c) => c.slice(0, 2).join(' '))).toEqual(['npm publish', 'npm publish']);
  });

  it('refuses to run when the pack artifact was not downloaded', () => {
    rmSync(join(root, 'artifacts'), { recursive: true });
    expect(() => release(root, () => undefined, registry(), fakeRunner([]))).toThrow(
      /does not exist/
    );
  });

  it('publishes seeded packages with provenance and skips unseeded ones with a warning', () => {
    const calls: string[][] = [];
    const lines: string[] = [];
    const lookup = registry({
      '@noblecloak/langgraph': { kind: 'versions', versions: ['0.9.0'] },
      '@noblecloak/other': { kind: 'not-found' },
    });
    expect(release(root, (l) => lines.push(l), lookup, fakeRunner(calls))).toBe(0);
    const publishes = calls.filter((c) => c[0] === 'npm');
    expect(publishes).toEqual([
      [
        'npm',
        'publish',
        join(root, 'artifacts', 'noblecloak-langgraph-1.0.0.tgz'),
        ...registryFlags(NPM_REGISTRY),
        '--provenance',
        '--access',
        'public',
      ],
    ]);
    expect(lines).toContain('published @noblecloak/langgraph@1.0.0');
    expect(lines).toContain(
      '::warning::@noblecloak/other is not on npm yet; skipped. Its first publish is manual.'
    );
  });

  it('has no allowlist: a name outside GITHUB_ALLOWLIST is published when npm has it seeded', () => {
    expect(GITHUB_ALLOWLIST).not.toContain('@noblecloak/other');
    const calls: string[][] = [];
    const lookup = registry({
      '@noblecloak/langgraph': { kind: 'versions', versions: ['1.0.0'] },
      '@noblecloak/other': { kind: 'versions', versions: ['0.0.9'] },
    });
    expect(release(root, () => undefined, lookup, fakeRunner(calls))).toBe(0);
    expect(published(calls)).toEqual(['noblecloak-other-0.1.0.tgz']);
  });

  it('needs no NODE_AUTH_TOKEN', () => {
    const asked: string[] = [];
    const lookup = (name: string): RegistryState => {
      asked.push(name);
      return SEEDED_CLIENT;
    };
    expect(
      release(root, () => undefined, lookup, fakeRunner([]), undefined, undefined, NPM_REGISTRY, {})
    ).toBe(0);
    expect(asked).toContain('@noblecloak/langgraph');
  });

  it('asks the registry once per package, however many tarballs depend on it', () => {
    writePackage('packages/other', {
      name: '@noblecloak/other',
      version: '0.1.0',
      dependencies: { '@noblecloak/langgraph': '1.0.0' },
    });
    rmSync(join(root, 'artifacts'), { recursive: true });
    packAll(root, fakeRunner([]));
    const asked: string[] = [];
    const lookup = (name: string): RegistryState => {
      asked.push(name);
      return name === '@noblecloak/other'
        ? { kind: 'versions', versions: [] }
        : { kind: 'versions', versions: ['1.0.0', '0.10.0'] };
    };
    expect(release(root, () => undefined, lookup, fakeRunner([]))).toBe(0);
    expect(asked.filter((name) => name === '@noblecloak/langgraph')).toHaveLength(1);
  });

  it('skips a version that is already on npm', () => {
    const lines: string[] = [];
    const lookup = (): RegistryState => ({ kind: 'versions', versions: ['1.0.0', '0.1.0'] });
    expect(release(root, (l) => lines.push(l), lookup, fakeRunner([]))).toBe(0);
    expect(lines).toContain('@noblecloak/langgraph@1.0.0 already published; skipped.');
  });

  it('exits 1 when a publish fails, naming what was not reached', () => {
    const lines: string[] = [];
    const lookup = registry({
      '@noblecloak/langgraph': { kind: 'versions', versions: [] },
      '@noblecloak/other': { kind: 'versions', versions: [] },
    });
    expect(release(root, (l) => lines.push(l), lookup, fakeRunner([], true))).toBe(1);
    expect(lines).toContain('::error::npm publish failed for @noblecloak/langgraph@1.0.0');
    expect(lines).toContain(
      '::error::Stopped before @noblecloak/other@0.1.0; a rerun publishes what npm does not have.'
    );
  });

  it('refuses to publish a package whose tarball is missing', () => {
    const pkg = { dir: root, name: '@noblecloak/langgraph', version: '1.0.0', private: false };
    expect(() => tarballFor(pkg, [])).toThrow(/no packed tarball/);
  });
});

describe('release to the GitHub registry', () => {
  const env = { NODE_AUTH_TOKEN: 'token-for-the-test' };
  const github = (
    lines: string[],
    lookup: (name: string) => RegistryState,
    calls: string[][],
    token: NodeJS.ProcessEnv = env
  ): number =>
    release(
      root,
      (l) => lines.push(l),
      lookup,
      fakeRunner(calls),
      undefined,
      undefined,
      GITHUB_REGISTRY,
      token
    );

  beforeEach(() => {
    packAll(root, fakeRunner([]));
  });

  it.each([[{}], [{ NODE_AUTH_TOKEN: '' }]])(
    'refuses an empty NODE_AUTH_TOKEN (%j) before it looks anything up',
    (token) => {
      const calls: string[][] = [];
      const lines: string[] = [];
      const asked: string[] = [];
      const lookup = (name: string): RegistryState => {
        asked.push(name);
        return { kind: 'not-found' };
      };
      expect(github(lines, lookup, calls, token)).toBe(1);
      expect(calls).toEqual([]);
      expect(asked).toEqual([]);
      expect(lines.join('\n')).toContain('NODE_AUTH_TOKEN is empty');
    }
  );

  it('publishes only the allowlisted name, skips the others with a printed line, and passes neither --provenance nor --access', () => {
    const calls: string[][] = [];
    const lines: string[] = [];
    expect(github(lines, registry({ '@noblecloak/langgraph': { kind: 'not-found' } }), calls)).toBe(
      0
    );
    expect(calls).toEqual([
      [
        'npm',
        'publish',
        join(root, 'artifacts', 'noblecloak-langgraph-1.0.0.tgz'),
        ...registryFlags(GITHUB_REGISTRY),
      ],
    ]);
    expect(lines).toContain(
      `@noblecloak/other@0.1.0 is not on the allowlist for ${GITHUB_REGISTRY}; skipped.`
    );
    expect(lines).toContain('published @noblecloak/langgraph@1.0.0');
  });

  it('publishes a package the registry answers 404 for, instead of skipping it as unseeded', () => {
    const calls: string[][] = [];
    expect(github([], registry({ '@noblecloak/langgraph': { kind: 'not-found' } }), calls)).toBe(0);
    expect(published(calls)).toEqual(['noblecloak-langgraph-1.0.0.tgz']);
  });

  it('skips a version the registry already has', () => {
    const calls: string[][] = [];
    const lines: string[] = [];
    const lookup = registry({ '@noblecloak/langgraph': { kind: 'versions', versions: ['1.0.0'] } });
    expect(github(lines, lookup, calls)).toBe(0);
    expect(calls).toEqual([]);
    expect(lines).toContain('@noblecloak/langgraph@1.0.0 already published; skipped.');
  });

  it('stops on any registry answer other than 404 or a version list, publishing nothing', () => {
    const calls: string[][] = [];
    const lookup = (name: string): RegistryState => {
      if (name === '@noblecloak/langgraph') return parseNpmView(1, '', 'npm error code E401');
      return SEEDED_CLIENT;
    };
    expect(() => github([], lookup, calls)).toThrow(/npm view failed \(exit 1\).*E401/);
    expect(calls).toEqual([]);
  });

  it('names the GitHub registry when the adapter needs a client it does not have', () => {
    const calls: string[][] = [];
    const lines: string[] = [];
    const lookup = registry({
      '@noblecloak/langgraph': { kind: 'not-found' },
      '@noblecloak/client': { kind: 'not-found' },
    });
    expect(github(lines, lookup, calls)).toBe(1);
    expect(calls).toEqual([]);
    expect(lines).toContain(
      '::error::@noblecloak/langgraph@1.0.0 depends on @noblecloak/client@0.10.0, but @noblecloak/client is not on the GitHub registry yet and this run does not publish it. Publish @noblecloak/client@0.10.0 to the GitHub registry first, or in the same release.'
    );
  });
});

describe('release dependency guard', () => {
  beforeEach(() => {
    packAll(root, fakeRunner([]));
  });

  it('publishes nothing when the adapter needs a client npm has never seen', () => {
    const calls: string[][] = [];
    const lines: string[] = [];
    const lookup = registry({
      '@noblecloak/langgraph': { kind: 'versions', versions: ['0.9.0'] },
      '@noblecloak/client': { kind: 'not-found' },
    });
    expect(release(root, (l) => lines.push(l), lookup, fakeRunner(calls))).toBe(1);
    expect(published(calls)).toEqual([]);
    expect(lines).toContain(
      '::error::@noblecloak/langgraph@1.0.0 depends on @noblecloak/client@0.10.0, but @noblecloak/client is not on npm yet and this run does not publish it. Publish @noblecloak/client@0.10.0 to npm first, or in the same release.'
    );
    expect(lines).toContain('::error::Nothing was published.');
  });

  it('publishes nothing when npm has the client at another version', () => {
    const calls: string[][] = [];
    const lines: string[] = [];
    const lookup = registry({
      '@noblecloak/langgraph': { kind: 'versions', versions: ['0.9.0'] },
      '@noblecloak/client': { kind: 'versions', versions: ['0.9.0'] },
    });
    expect(release(root, (l) => lines.push(l), lookup, fakeRunner(calls))).toBe(1);
    expect(published(calls)).toEqual([]);
    expect(lines).toContain(
      '::error::@noblecloak/langgraph@1.0.0 depends on @noblecloak/client@0.10.0, but npm has no @noblecloak/client@0.10.0 and this run does not publish it. Publish @noblecloak/client@0.10.0 to npm first, or in the same release.'
    );
  });

  it('fails a not-yet-seeded package whose client npm does not have, instead of skipping it', () => {
    const calls: string[][] = [];
    const lines: string[] = [];
    const lookup = registry({
      '@noblecloak/langgraph': { kind: 'not-found' },
      '@noblecloak/client': { kind: 'versions', versions: ['0.9.0'] },
    });
    expect(release(root, (l) => lines.push(l), lookup, fakeRunner(calls))).toBe(1);
    expect(published(calls)).toEqual([]);
    expect(lines).toContain(
      '::error::@noblecloak/langgraph@1.0.0 depends on @noblecloak/client@0.10.0, but npm has no @noblecloak/client@0.10.0 and this run does not publish it. Publish @noblecloak/client@0.10.0 to npm first, or in the same release.'
    );
    expect(lines).toContain('::error::Nothing was published.');
  });

  it('still skips a not-yet-seeded package with a warning when its dependencies are on npm', () => {
    const calls: string[][] = [];
    const lines: string[] = [];
    const lookup = registry({ '@noblecloak/langgraph': { kind: 'not-found' } });
    expect(release(root, (l) => lines.push(l), lookup, fakeRunner(calls))).toBe(0);
    expect(published(calls)).not.toContain('noblecloak-langgraph-1.0.0.tgz');
    expect(lines).toContain(
      '::warning::@noblecloak/langgraph is not on npm yet; skipped. Its first publish is manual.'
    );
  });

  it('refuses a tarball packed with the vendored file: pin, which no registry could install', () => {
    writePackage('packages/langgraph', {
      name: '@noblecloak/langgraph',
      version: '1.0.0',
      dependencies: { '@noblecloak/client': 'file:../../vendor/noblecloak-client-0.10.0.tgz' },
    });
    rmSync(join(root, 'artifacts'), { recursive: true });
    packAll(root, fakeRunner([]));
    const calls: string[][] = [];
    const lines: string[] = [];
    const lookup = registry({ '@noblecloak/langgraph': { kind: 'versions', versions: [] } });
    expect(release(root, (l) => lines.push(l), lookup, fakeRunner(calls))).toBe(1);
    expect(published(calls)).toEqual([]);
    expect(lines).toContain(
      '::error::@noblecloak/langgraph@1.0.0 depends on @noblecloak/client@file:../../vendor/noblecloak-client-0.10.0.tgz, which is not an exact version; the packed tarball must pin it.'
    );
  });

  it('leaves devDependencies and third-party dependencies out of the check', () => {
    const lookup = registry({
      '@noblecloak/langgraph': { kind: 'versions', versions: [] },
      '@noblecloak/spec': { kind: 'not-found' },
      'some-lib': { kind: 'not-found' },
    });
    const calls: string[][] = [];
    expect(release(root, () => undefined, lookup, fakeRunner(calls))).toBe(0);
    expect(published(calls)).toContain('noblecloak-langgraph-1.0.0.tgz');
  });

  it('reads the dependencies out of a real packed tarball', () => {
    const tarball = join(root, 'artifacts', 'noblecloak-langgraph-1.0.0.tgz');
    const names = new Set(['@noblecloak/langgraph']);
    expect(internalDependencies(readPackedManifest(tarball), names)).toEqual([
      { name: '@noblecloak/client', range: '0.10.0' },
    ]);
    expect(internalDependencies({ peerDependencies: { 'plain-name': '1.0.0' } }, names)).toEqual(
      []
    );
    expect(
      internalDependencies({ peerDependencies: { 'plain-name': '1.0.0' } }, new Set(['plain-name']))
    ).toEqual([{ name: 'plain-name', range: '1.0.0' }]);
    expect(() => readPackedManifest(join(root, 'missing.tgz'))).toThrow(/tar xzOf failed/);
  });
});

describe('unmetDependencies and publishOrder', () => {
  const dep = (name: string, range = '1.0.0') => ({ name, range });
  const candidate = (name: string, deps: { name: string; range: string }[], version = '1.0.0') => ({
    name,
    version,
    dependencies: deps,
  });
  const nothing = (): RegistryState => ({ kind: 'versions', versions: [] });

  it('accepts a dependency this run publishes at exactly that version', () => {
    expect(unmetDependencies([candidate('x', [dep('y')]), candidate('y', [])], nothing)).toEqual(
      []
    );
  });

  it('refuses a dependency this run publishes at another version', () => {
    expect(
      unmetDependencies([candidate('x', [dep('y')]), candidate('y', [], '2.0.0')], nothing)
    ).toEqual([
      'x@1.0.0 depends on y@1.0.0, but npm has no y@1.0.0 and this run publishes y@2.0.0. Publish y@1.0.0 to npm first, or in the same release.',
    ]);
  });

  it('orders dependencies first and refuses a cycle', () => {
    const c = (name: string, deps: string[]) =>
      candidate(
        name,
        deps.map((d) => dep(d))
      );
    expect(
      publishOrder([c('x', ['y', 'outside']), c('y', ['z']), c('z', []), c('w', [])]).map(
        (p) => p.name
      )
    ).toEqual(['z', 'y', 'x', 'w']);
    expect(() => publishOrder([c('x', ['y']), c('y', ['x'])])).toThrow(/dependency cycle/);
  });
});

describe('the command line', () => {
  const FLAGS = {
    [NPM_REGISTRY]: ['--registry', NPM_REGISTRY, `--@noblecloak:registry=${NPM_REGISTRY}`],
    [GITHUB_REGISTRY]: ['--registry', GITHUB_REGISTRY, `--@noblecloak:registry=${GITHUB_REGISTRY}`],
  };

  /** Runs `main` with a fake npm that has only @noblecloak/client@0.10.0; returns its exit code and every call. */
  function runMain(argv: string[], env: NodeJS.ProcessEnv) {
    const views: string[][] = [];
    const calls: string[][] = [];
    const lines: string[] = [];
    packAll(root, fakeRunner([]));
    const code = main(argv, env, {
      cwd: root,
      out: (l) => lines.push(l),
      spawn: (args) => {
        views.push([...args]);
        return { status: 0, stdout: '["0.10.0"]', stderr: '' };
      },
      run: fakeRunner(calls),
    });
    return { code, views, calls: calls.filter((c) => c[0] === 'npm'), lines };
  }

  it('names the registry flags for a scoped package, over any .npmrc scope mapping', () => {
    expect(registryFlags(GITHUB_REGISTRY)).toEqual(FLAGS[GITHUB_REGISTRY]);
  });

  it.each([[NPM_REGISTRY], [GITHUB_REGISTRY]])(
    'npmView passes both registry flags to npm (%s)',
    (registryUrl) => {
      const seen: string[][] = [];
      const lookup = npmView(registryUrl, (args) => {
        seen.push([...args]);
        return { status: 0, stdout: '["1.0.0"]', stderr: '' };
      });
      expect(lookup('@noblecloak/x')).toEqual({ kind: 'versions', versions: ['1.0.0'] });
      expect(seen).toEqual([
        [
          'view',
          '@noblecloak/x',
          'versions',
          '--json',
          ...FLAGS[registryUrl as keyof typeof FLAGS],
        ],
      ]);
    }
  );

  it('with --registry the GitHub registry: looks up, applies the allowlist and publishes there', () => {
    const { code, views, calls } = runMain(['--registry', GITHUB_REGISTRY], {
      NODE_AUTH_TOKEN: 't',
    });
    expect(code).toBe(0);
    expect(views.length).toBeGreaterThan(0);
    for (const view of views) expect(view.slice(-3)).toEqual(FLAGS[GITHUB_REGISTRY]);
    expect(calls).toEqual([
      [
        'npm',
        'publish',
        expect.stringContaining('noblecloak-langgraph-1.0.0.tgz'),
        ...FLAGS[GITHUB_REGISTRY],
      ],
    ]);
  });

  it('refuses an empty NODE_AUTH_TOKEN on the GitHub registry before any npm call', () => {
    const { code, views, calls } = runMain(['--registry', GITHUB_REGISTRY], {});
    expect(code).toBe(1);
    expect(views).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('with no argument: looks up and publishes to npm with provenance, and needs no token', () => {
    const { code, views, calls } = runMain([], {});
    expect(code).toBe(0);
    for (const view of views) expect(view.slice(-3)).toEqual(FLAGS[NPM_REGISTRY]);
    expect(calls.map((c) => c.slice(3))).toEqual([
      [...FLAGS[NPM_REGISTRY], '--provenance', '--access', 'public'],
      [...FLAGS[NPM_REGISTRY], '--provenance', '--access', 'public'],
    ]);
  });

  it('exits 2 for an unknown registry or argument, calling nothing', () => {
    const { code, views, calls, lines } = runMain(['--registry', 'https://example.com'], {});
    expect(code).toBe(2);
    expect(views).toEqual([]);
    expect(calls).toEqual([]);
    expect(lines.join('\n')).toContain('--registry takes');
  });
});

describe('release --check-only', () => {
  beforeEach(() => {
    packAll(root, fakeRunner([]));
  });

  const adapter = (): string => join(root, 'artifacts', 'noblecloak-langgraph-1.0.0.tgz');

  it('fails for a tarball whose dependency npm lacks, and publishes nothing', () => {
    const lines: string[] = [];
    const lookup = registry({ '@noblecloak/client': { kind: 'versions', versions: ['0.9.0'] } });
    expect(checkOnly(root, [adapter()], (l) => lines.push(l), lookup)).toBe(1);
    expect(lines).toContain(
      '::error::@noblecloak/langgraph@1.0.0 depends on @noblecloak/client@0.10.0, but npm has no @noblecloak/client@0.10.0 and this run does not publish it. Publish @noblecloak/client@0.10.0 to npm first, or in the same release.'
    );
  });

  it('fails for a dependency npm has never seen', () => {
    const lookup = registry({ '@noblecloak/client': { kind: 'not-found' } });
    expect(checkOnly(root, [adapter()], () => undefined, lookup)).toBe(1);
  });

  it('passes when npm has the exact version, and a directory stands for its tarballs', () => {
    const lines: string[] = [];
    expect(checkOnly(root, [], (l) => lines.push(l), registry())).toBe(0);
    expect(lines).toContain('@noblecloak/langgraph@1.0.0: dependencies are on npm');
    expect(lines).toContain('@noblecloak/other@0.1.0: dependencies are on npm');
    expect(checkOnly(root, [join(root, 'artifacts')], () => undefined, registry())).toBe(0);
  });

  it('refuses a missing path and a directory with no tarball', () => {
    const lines: string[] = [];
    expect(checkOnly(root, [join(root, 'nope.tgz')], (l) => lines.push(l), registry())).toBe(1);
    mkdirSync(join(root, 'empty'));
    expect(checkOnly(root, [join(root, 'empty')], (l) => lines.push(l), registry())).toBe(1);
    expect(lines.filter((l) => l.includes('Nothing was checked'))).toHaveLength(2);
  });

  it('is reached from the command line, publishes nothing and takes the npm registry flags', () => {
    const views: string[][] = [];
    const calls: string[][] = [];
    const code = main(
      ['--check-only', adapter()],
      {},
      {
        cwd: root,
        out: () => undefined,
        spawn: (args) => {
          views.push([...args]);
          return { status: 0, stdout: '["0.9.0"]', stderr: '' };
        },
        run: fakeRunner(calls),
      }
    );
    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(views[0]?.slice(-3)).toEqual([
      '--registry',
      NPM_REGISTRY,
      `--@noblecloak:registry=${NPM_REGISTRY}`,
    ]);
  });
});
