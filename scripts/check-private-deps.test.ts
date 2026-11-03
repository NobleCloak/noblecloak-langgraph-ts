import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { contractScope, findViolations, runGuard } from './check-private-deps.js';

const CLEAN_PACKAGE = { name: '@noblecloak/fixture', license: 'Apache-2.0' };

let root: string;

function write(relativePath: string, content: unknown): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'guard-fixture-'));
  write('package.json', { name: 'fixture-root', private: true, license: 'Apache-2.0' });
  write('packages/a/package.json', CLEAN_PACKAGE);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('findViolations', () => {
  it('passes a clean workspace', () => {
    expect(findViolations(root)).toEqual([]);
  });

  it.each(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])(
    'flags a dependency in %s that resolves from a foreign registry URL, and names the file and key',
    (field) => {
      write('packages/a/package.json', {
        ...CLEAN_PACKAGE,
        [field]: { '@acme-private/shared-auth': 'https://npm.pkg.github.com/download/x.tgz' },
      });
      expect(findViolations(root)).toEqual([
        {
          file: 'packages/a/package.json',
          key: `${field}.@acme-private/shared-auth`,
          kind: 'foreign-source-dependency',
        },
      ]);
    }
  );

  it.each([
    ['a git URL', 'git+https://example.com/acme/shared-auth.git'],
    ['a github: shorthand', 'github:acme/shared-auth'],
    ['a bare owner/repo shorthand', 'acme/shared-auth#v1'],
    ['an npm: alias to a tarball URL', 'npm:https://example.com/shared-auth-1.0.0.tgz'],
    ['a file: path that leaves the tree', 'file:../../../outside/shared-auth-1.0.0.tgz'],
    ['a link: path that leaves the tree', 'link:/somewhere/else'],
    ['a file: tarball inside the tree', 'file:../../vendor/shared-auth-1.0.0.tgz'],
    ['a file: path to the tree root', 'file:../..'],
    ['a link: path inside the tree', 'link:../b'],
    ['an npm: alias to a file: path', 'npm:file:../b'],
  ])('flags %s', (_label, spec) => {
    write('packages/a/package.json', { ...CLEAN_PACKAGE, dependencies: { 'shared-auth': spec } });
    expect(findViolations(root)).toEqual([
      {
        file: 'packages/a/package.json',
        key: 'dependencies.shared-auth',
        kind: 'foreign-source-dependency',
      },
    ]);
  });

  it.each([
    ['a registry version', '1.0.0'],
    ['a registry range', '^1.0.0'],
    ['an npm: alias to a registry package', 'npm:@acme/shared-auth@1.0.0'],
    ['a workspace link', 'workspace:*'],
  ])('passes %s', (_label, spec) => {
    write('packages/a/package.json', { ...CLEAN_PACKAGE, dependencies: { 'shared-auth': spec } });
    expect(findViolations(root)).toEqual([]);
  });

  it('flags a scope mapped to a foreign registry in an .npmrc', () => {
    write('packages/a/.npmrc', '@acme-private:registry=https://npm.pkg.github.com\n');
    expect(findViolations(root)).toEqual([
      { file: 'packages/a/.npmrc', key: 'line 1', kind: 'foreign-registry' },
    ]);
  });

  it('flags a tarball URL, a git source and a file: tarball in bun.lock', () => {
    write(
      'bun.lock',
      [
        '{',
        '  "packages": {',
        '    "@acme-private/shared-auth": ["@acme-private/shared-auth@1.0.0", "https://npm.pkg.github.com/download/x.tgz", {}],',
        '    "zod": ["zod@4.0.0", "", {}, "sha512-x"],',
        '    "left-pad": ["left-pad@github:acme/left-pad#abc", {}],',
        '    "shared-types": ["shared-types@file:../../vendor/shared-types-0.10.0.tgz", {}],',
        '  },',
        '}',
      ].join('\n')
    );
    expect(findViolations(root)).toEqual([
      { file: 'bun.lock', key: 'line 3', kind: 'foreign-source-dependency' },
      { file: 'bun.lock', key: 'line 5', kind: 'foreign-source-dependency' },
      { file: 'bun.lock', key: 'line 6', kind: 'foreign-source-dependency' },
    ]);
  });

  it('passes a bun.lock that only names public packages', () => {
    write(
      'bun.lock',
      '{\n  "packages": {\n    "zod": ["zod@4.0.0", "", {}, "sha512-x"],\n  },\n}\n'
    );
    expect(findViolations(root)).toEqual([]);
  });

  it('flags a scope mapped to a foreign registry in bunfig.toml, and passes the public registry', () => {
    write('bunfig.toml', '[install.scopes]\nacme-private = "https://npm.pkg.github.com"\n');
    expect(findViolations(root)).toEqual([
      { file: 'bunfig.toml', key: 'line 2', kind: 'foreign-registry' },
    ]);
    write('bunfig.toml', '[install]\nregistry = "https://registry.npmjs.org"\n');
    expect(findViolations(root)).toEqual([]);
  });

  it('flags a foreign registry in publishConfig.registry', () => {
    write('packages/a/package.json', {
      ...CLEAN_PACKAGE,
      publishConfig: { registry: 'https://npm.pkg.github.com' },
    });
    expect(findViolations(root)).toEqual([
      {
        file: 'packages/a/package.json',
        key: 'publishConfig.registry',
        kind: 'foreign-registry',
      },
    ]);
  });

  it('flags an auth token line in an .npmrc', () => {
    write('.npmrc', 'registry=https://registry.npmjs.org\n//registry.npmjs.org/:_authToken=abc\n');
    expect(findViolations(root)).toEqual([
      { file: '.npmrc', key: 'line 2', kind: 'npm-auth-token' },
    ]);
  });

  it.each([
    ['missing', undefined],
    ['a different license', 'MIT'],
  ])('flags a package.json whose license is %s', (_label, license) => {
    write('packages/a/package.json', { name: '@noblecloak/fixture', license });
    expect(findViolations(root)).toEqual([
      { file: 'packages/a/package.json', key: 'license', kind: 'missing-apache-license' },
    ]);
  });

  it('reports a package.json that is not valid JSON', () => {
    write('packages/a/package.json', '{ not json');
    expect(findViolations(root)).toEqual([
      { file: 'packages/a/package.json', key: '(file)', kind: 'unreadable-package-json' },
    ]);
  });

  it('does not descend into node_modules or build output', () => {
    write('node_modules/x/package.json', { name: 'x', license: 'MIT' });
    write('packages/a/dist/package.json', { name: 'y' });
    expect(findViolations(root)).toEqual([]);
  });
});

describe('the one registry mapping, for the contract scope', () => {
  const MAPPING = '@acme-private:registry=https://npm.pkg.github.com';
  const AUTH = '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}';
  const BUNFIG_MAPPING =
    '"@acme-private" = { url = "https://npm.pkg.github.com", token = "$NODE_AUTH_TOKEN" }';
  const lockEntry = (name: string, url: string): string =>
    `    "${name}": ["${name}@1.0.0", "${url}", {}, "sha512-x"],`;

  beforeEach(() => {
    write('contract.json', {
      packages: { '@acme-private/client': { version: '1.0.0' }, '@acme-private/spec': {} },
    });
  });

  it('reads the scope from contract.json, and none when the packages do not share one', () => {
    expect(contractScope(root)).toBe('@acme-private');
    write('contract.json', { packages: { '@acme-private/client': {}, '@other/spec': {} } });
    expect(contractScope(root)).toBeUndefined();
    write('contract.json', { packages: { client: {} } });
    expect(contractScope(root)).toBeUndefined();
    write('contract.json', '{ not json');
    expect(contractScope(root)).toBeUndefined();
    write('contract.json', { phase: 'registry' });
    expect(contractScope(root)).toBeUndefined();
    rmSync(join(root, 'contract.json'));
    expect(contractScope(root)).toBeUndefined();
  });

  it('passes the mapping and the environment token line in the root .npmrc', () => {
    write('.npmrc', `${MAPPING}\n${AUTH}\n`);
    expect(findViolations(root)).toEqual([]);
  });

  it('passes the mapping in the root bunfig.toml', () => {
    write('bunfig.toml', `[install]\nlinker = "hoisted"\n\n[install.scopes]\n${BUNFIG_MAPPING}\n`);
    expect(findViolations(root)).toEqual([]);
  });

  it('flags the mapping and the token line when no contract.json names the scope', () => {
    rmSync(join(root, 'contract.json'));
    write('.npmrc', `${MAPPING}\n${AUTH}\n`);
    expect(findViolations(root)).toEqual([
      { file: '.npmrc', key: 'line 1', kind: 'foreign-registry' },
      { file: '.npmrc', key: 'line 2', kind: 'npm-auth-token' },
    ]);
  });

  it.each([
    ['another scope', '@acme-other:registry=https://npm.pkg.github.com'],
    ['another scope on the public registry', '@acme-other:registry=https://registry.npmjs.org'],
    ['another host', '@acme-private:registry=https://registry.example.com'],
    ['a path on the host', '@acme-private:registry=https://npm.pkg.github.com/acme'],
    ['plain http', '@acme-private:registry=http://npm.pkg.github.com'],
    ['the default registry', 'registry=https://npm.pkg.github.com'],
  ])('flags a mapping to %s in the root .npmrc', (_label, line) => {
    write('.npmrc', `${line}\n`);
    expect(findViolations(root)).toEqual([
      { file: '.npmrc', key: 'line 1', kind: 'foreign-registry' },
    ]);
  });

  it.each([
    ['another scope', BUNFIG_MAPPING.replace('@acme-private', '@acme-other')],
    ['another host', BUNFIG_MAPPING.replace('npm.pkg.github.com', 'registry.example.com')],
    ['the string form', '"@acme-private" = "https://npm.pkg.github.com"'],
    ['a scope on the public registry', '"@acme-other" = "https://registry.npmjs.org"'],
  ])('flags a mapping to %s in the root bunfig.toml', (_label, line) => {
    write('bunfig.toml', `[install.scopes]\n${line}\n`);
    expect(findViolations(root)).toEqual([
      { file: 'bunfig.toml', key: 'line 2', kind: 'foreign-registry' },
    ]);
  });

  it('flags the mapping and the token line anywhere but the root', () => {
    write('packages/a/.npmrc', `${MAPPING}\n${AUTH}\n`);
    write('packages/a/bunfig.toml', `[install.scopes]\n${BUNFIG_MAPPING}\n`);
    expect(findViolations(root)).toEqual([
      { file: 'packages/a/.npmrc', key: 'line 1', kind: 'foreign-registry' },
      { file: 'packages/a/.npmrc', key: 'line 2', kind: 'npm-auth-token' },
      { file: 'packages/a/bunfig.toml', key: 'line 2', kind: 'foreign-registry' },
    ]);
  });

  it('flags a second mapping, in the same file or the other one', () => {
    write('.npmrc', `${MAPPING}\n${MAPPING}\n`);
    expect(findViolations(root)).toEqual([
      { file: '.npmrc', key: 'line 2', kind: 'second-registry-mapping' },
    ]);
    write('.npmrc', `${MAPPING}\n`);
    write('bunfig.toml', `[install.scopes]\n${BUNFIG_MAPPING}\n`);
    expect(findViolations(root)).toEqual([
      { file: 'bunfig.toml', key: 'line 2', kind: 'second-registry-mapping' },
    ]);
  });

  it.each([
    ['a literal token', '//npm.pkg.github.com/:_authToken=ghp_literal'],
    ['another variable', '//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}'],
    ['another host', '//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}'],
    ['a basic-auth line', '//npm.pkg.github.com/:_auth=dXNlcjpwYXNz'],
    ['a password line', '//npm.pkg.github.com/:_password=cGFzcw=='],
  ])('flags %s in the root .npmrc', (_label, line) => {
    write('.npmrc', `${MAPPING}\n${line}\n`);
    expect(findViolations(root)).toEqual([
      { file: '.npmrc', key: 'line 2', kind: 'npm-auth-token' },
    ]);
  });

  it('flags a literal token in the bunfig.toml mapping', () => {
    write(
      'bunfig.toml',
      `[install.scopes]\n${BUNFIG_MAPPING.replace('$NODE_AUTH_TOKEN', 'ghp_literal')}\n`
    );
    expect(findViolations(root)).toEqual([
      { file: 'bunfig.toml', key: 'line 2', kind: 'npm-auth-token' },
      { file: 'bunfig.toml', key: 'line 2', kind: 'foreign-registry' },
    ]);
  });

  it('passes a lock entry of a contract-scope package from its own tarball on the package registry', () => {
    write(
      'bun.lock',
      [
        '{',
        '  "packages": {',
        lockEntry(
          '@acme-private/client',
          'https://npm.pkg.github.com/download/@acme-private/client/1.0.0/abc'
        ),
        '  },',
        '}',
      ].join('\n')
    );
    expect(findViolations(root)).toEqual([]);
  });

  it.each([
    [
      'a package of another scope',
      lockEntry(
        '@acme-other/client',
        'https://npm.pkg.github.com/download/@acme-other/client/1.0.0/abc'
      ),
    ],
    [
      'a tarball of another package',
      lockEntry(
        '@acme-private/client',
        'https://npm.pkg.github.com/download/@acme-private/spec/1.0.0/abc'
      ),
    ],
    [
      'another host',
      lockEntry(
        '@acme-private/client',
        'https://registry.example.com/download/@acme-private/client/1.0.0/abc'
      ),
    ],
    [
      'a second URL on the line',
      lockEntry(
        '@acme-private/client',
        'https://npm.pkg.github.com/download/@acme-private/client/1.0.0/abc'
      ).replace('{}', '{ "x": "https://registry.example.com/y" }'),
    ],
  ])('flags a lock entry from the package registry for %s', (_label, line) => {
    write('bun.lock', ['{', '  "packages": {', line, '  },', '}'].join('\n'));
    expect(findViolations(root)).toEqual([
      { file: 'bun.lock', key: 'line 3', kind: 'foreign-source-dependency' },
    ]);
  });

  it('flags a lock entry bun resolved as a path, and passes a workspace entry', () => {
    write(
      'bun.lock',
      [
        '{',
        '  "packages": {',
        '    "@acme-private/client": ["@acme-private/client@./vendor/client-1.0.0.tgz", {}, "sha512-x"],',
        '    "@acme-private/a": ["@acme-private/a@workspace:packages/a"],',
        '    "string-width-cjs": ["string-width@4.2.3", "", {}, "sha512-x"],',
        '    "nameless": ["nameless", {}],',
        '  },',
        '}',
      ].join('\n')
    );
    expect(findViolations(root)).toEqual([
      { file: 'bun.lock', key: 'line 3', kind: 'foreign-source-dependency' },
      { file: 'bun.lock', key: 'line 6', kind: 'foreign-source-dependency' },
    ]);
  });
});

describe('runGuard', () => {
  it('prints each violation with its file and exits 1', () => {
    write('packages/a/package.json', {
      name: '@noblecloak/fixture',
      devDependencies: { '@acme-private/shared-types': 'github:acme/shared-types' },
    });
    const lines: string[] = [];
    expect(runGuard(root, (line) => lines.push(line))).toBe(1);
    expect(lines.join('\n')).toContain(
      'packages/a/package.json: devDependencies.@acme-private/shared-types'
    );
    expect(lines.join('\n')).toContain('packages/a/package.json: license');
  });

  it('prints a success line and exits 0 on a clean workspace', () => {
    const lines: string[] = [];
    expect(runGuard(root, (line) => lines.push(line))).toBe(0);
    expect(lines).toEqual(['private-dependency guard: OK (2 package.json files checked)']);
  });
});
