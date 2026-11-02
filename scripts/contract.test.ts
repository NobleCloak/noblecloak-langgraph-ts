import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { checkContract, parseChecksums } from './contract.js';
import { listWorkspacePackages } from './workspace.js';

const ROOT = resolve(import.meta.dirname, '..');

type Json = Record<string, unknown>;
const read = (root: string, file: string): Json =>
  JSON.parse(readFileSync(join(root, file), 'utf8')) as Json;
const write = (root: string, file: string, value: unknown): void => {
  writeFileSync(join(root, file), `${JSON.stringify(value, null, 2)}\n`);
};

describe('the contract pair of this repository', () => {
  it('is one pair in contract.json, the root overrides, the manifests, vendor/ and node_modules', () => {
    expect(checkContract(ROOT)).toEqual([]);
  });

  it('is the pair the adapter and the example declare they are built against', () => {
    const contract = read(ROOT, 'contract.json') as {
      packages: Record<string, { version: string }>;
    };
    expect(
      Object.fromEntries(Object.entries(contract.packages).map(([n, e]) => [n, e.version]))
    ).toEqual({
      '@noblecloak/client': '0.10.0',
      '@noblecloak/spec': '0.9.0',
    });
    expect(read(ROOT, 'packages/langgraph/package.json').dependencies).toMatchObject({
      '@noblecloak/client': 'file:../../vendor/noblecloak-client-0.10.0.tgz',
    });
  });
});

describe('checkContract', () => {
  const trees: string[] = [];
  afterEach(() => {
    for (const tree of trees.splice(0)) rmSync(tree, { recursive: true, force: true });
  });

  /** A copy of the files the check reads: the manifests, contract.json, vendor/ and the installed pair. */
  function copyOfRoot(): string {
    const tree = mkdtempSync(join(tmpdir(), 'contract-'));
    trees.push(tree);
    for (const file of ['package.json', 'contract.json'])
      cpSync(join(ROOT, file), join(tree, file));
    cpSync(join(ROOT, 'vendor'), join(tree, 'vendor'), { recursive: true });
    for (const pkg of listWorkspacePackages(ROOT)) {
      const dir = join(tree, pkg.dir.slice(ROOT.length));
      mkdirSync(dir, { recursive: true });
      cpSync(join(pkg.dir, 'package.json'), join(dir, 'package.json'));
    }
    for (const name of ['client', 'spec']) {
      mkdirSync(join(tree, 'node_modules/@noblecloak', name), { recursive: true });
      cpSync(
        join(ROOT, 'node_modules/@noblecloak', name, 'package.json'),
        join(tree, 'node_modules/@noblecloak', name, 'package.json')
      );
    }
    return tree;
  }

  it('accepts an exact copy', () => {
    expect(checkContract(copyOfRoot())).toEqual([]);
  });

  it('names a contract.json version that is not the tarball it points at', () => {
    const tree = copyOfRoot();
    const contract = read(tree, 'contract.json') as { packages: Record<string, unknown> };
    contract.packages['@noblecloak/spec'] = {
      version: '0.9.1',
      tarball: 'vendor/noblecloak-spec-0.9.0.tgz',
    };
    write(tree, 'contract.json', contract);
    expect(checkContract(tree)).toEqual([
      'vendor/noblecloak-spec-0.9.0.tgz: holds @noblecloak/spec@0.9.0, not @noblecloak/spec@0.9.1',
      'node_modules/@noblecloak/spec: installed 0.9.0, not 0.9.1',
    ]);
  });

  it('names a root override that does not point at the vendored tarball', () => {
    const tree = copyOfRoot();
    const manifest = read(tree, 'package.json') as { overrides: Record<string, string> };
    manifest.overrides['@noblecloak/client'] = '0.10.0';
    write(tree, 'package.json', manifest);
    expect(checkContract(tree)).toEqual([
      'package.json: overrides.@noblecloak/client is 0.10.0, not file:./vendor/noblecloak-client-0.10.0.tgz',
    ]);
  });

  it('names a third override', () => {
    const tree = copyOfRoot();
    const manifest = read(tree, 'package.json') as { overrides: Record<string, string> };
    manifest.overrides['left-pad'] = 'file:./vendor/left-pad.tgz';
    write(tree, 'package.json', manifest);
    expect(checkContract(tree)).toEqual([
      'package.json: overrides name @noblecloak/client, @noblecloak/spec, left-pad, not @noblecloak/client, @noblecloak/spec',
    ]);
  });

  it('names a workspace manifest that pins the pair to something else', () => {
    const tree = copyOfRoot();
    const manifest = read(tree, 'packages/langgraph/package.json') as {
      dependencies: Record<string, string>;
    };
    manifest.dependencies['@noblecloak/client'] = '0.10.0';
    write(tree, 'packages/langgraph/package.json', manifest);
    expect(checkContract(tree)).toEqual([
      'packages/langgraph/package.json: dependencies.@noblecloak/client is 0.10.0, not the tarball vendor/noblecloak-client-0.10.0.tgz',
    ]);
  });

  it('names a file: dependency on anything but the pair', () => {
    const tree = copyOfRoot();
    const manifest = read(tree, 'examples/langgraph-approvals/package.json') as {
      dependencies: Record<string, string>;
    };
    manifest.dependencies['left-pad'] = 'file:../../vendor/left-pad.tgz';
    write(tree, 'examples/langgraph-approvals/package.json', manifest);
    expect(checkContract(tree)).toEqual([
      'examples/langgraph-approvals/package.json: dependencies.left-pad is file:../../vendor/left-pad.tgz; nothing but the contract pair is vendored',
    ]);
  });

  it('names a file: dependency on anything but the pair in the root manifest', () => {
    const tree = copyOfRoot();
    const manifest = read(tree, 'package.json') as { devDependencies: Record<string, string> };
    manifest.devDependencies['left-pad'] = 'file:../left-pad.tgz';
    write(tree, 'package.json', manifest);
    expect(checkContract(tree)).toEqual([
      'package.json: devDependencies.left-pad is file:../left-pad.tgz; nothing but the contract pair is vendored',
    ]);
  });

  it('names a tarball whose bytes are not the ones SHA256SUMS records', () => {
    const tree = copyOfRoot();
    writeFileSync(join(tree, 'vendor/noblecloak-client-0.10.0.tgz'), 'not a tarball');
    const problems = checkContract(tree);
    expect(problems).toContain(
      'vendor/noblecloak-client-0.10.0.tgz: missing or not a package tarball'
    );
    expect(
      problems.some((line) => line.startsWith('vendor/noblecloak-client-0.10.0.tgz: sha256 is'))
    ).toBe(true);
  });

  it('names a vendored file that is not part of the pair', () => {
    const tree = copyOfRoot();
    writeFileSync(join(tree, 'vendor/extra.tgz'), '');
    expect(checkContract(tree)).toEqual([
      'vendor/: holds SHA256SUMS, extra.tgz, noblecloak-client-0.10.0.tgz, noblecloak-spec-0.9.0.tgz, not SHA256SUMS, noblecloak-client-0.10.0.tgz, noblecloak-spec-0.9.0.tgz',
    ]);
  });

  it('names a missing SHA256SUMS and a checksum line for the wrong file', () => {
    const tree = copyOfRoot();
    rmSync(join(tree, 'vendor/SHA256SUMS'));
    expect(checkContract(tree)[0]).toContain('vendor/: holds noblecloak-client-0.10.0.tgz');
    const sums = readFileSync(join(ROOT, 'vendor/SHA256SUMS'), 'utf8').replace(
      'noblecloak-spec-0.9.0.tgz',
      'noblecloak-spec-0.8.0.tgz'
    );
    writeFileSync(join(tree, 'vendor/SHA256SUMS'), sums);
    expect(checkContract(tree)).toContain(
      'vendor/SHA256SUMS: lists noblecloak-client-0.10.0.tgz, noblecloak-spec-0.8.0.tgz, not noblecloak-client-0.10.0.tgz, noblecloak-spec-0.9.0.tgz'
    );
  });

  it('names an installed version that is not the pair, and an install that is missing', () => {
    const tree = copyOfRoot();
    write(tree, 'node_modules/@noblecloak/client/package.json', {
      name: '@noblecloak/client',
      version: '0.9.9',
    });
    rmSync(join(tree, 'node_modules/@noblecloak/spec'), { recursive: true });
    expect(checkContract(tree)).toEqual([
      'node_modules/@noblecloak/client: installed 0.9.9, not 0.10.0',
      'node_modules/@noblecloak/spec: installed undefined, not 0.9.0',
    ]);
  });

  it('names a contract.json that is not in the vendored phase or lists another package', () => {
    const tree = copyOfRoot();
    write(tree, 'contract.json', { phase: 'registry', packages: {} });
    const problems = checkContract(tree);
    expect(problems[0]).toBe('contract.json: phase is registry, not vendored');
    expect(problems[1]).toBe('contract.json: lists , not @noblecloak/client, @noblecloak/spec');
  });
});

describe('parseChecksums', () => {
  it('reads sha256sum lines in text and binary mode and skips anything else', () => {
    const hash = 'a'.repeat(64);
    expect(parseChecksums(`${hash}  one.tgz\n${hash} *two.tgz\nnot a line\n\n`)).toEqual(
      new Map([
        ['one.tgz', hash],
        ['two.tgz', hash],
      ])
    );
  });
});
