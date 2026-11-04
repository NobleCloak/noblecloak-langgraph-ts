import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { findViolations } from './check-private-deps.js';
import { CONTRACT_CONSUMERS, CONTRACT_PACKAGES, checkContract } from './contract.js';
import { listWorkspacePackages } from './workspace.js';

const ROOT = resolve(import.meta.dirname, '..');

type Json = Record<string, unknown>;
type Deps = Record<string, string>;
const read = (root: string, file: string): Json =>
  JSON.parse(readFileSync(join(root, file), 'utf8')) as Json;
const write = (root: string, file: string, value: unknown): void => {
  writeFileSync(join(root, file), `${JSON.stringify(value, null, 2)}\n`);
};

describe('the contract pair of this repository', () => {
  it('is one pair in contract.json, the manifests and node_modules, with nothing vendored', () => {
    expect(checkContract(ROOT)).toEqual([]);
  });

  it('is the registry pair of contract revision 15, which the adapter, the example and the snippets name', () => {
    expect(read(ROOT, 'contract.json')).toEqual({
      phase: 'registry',
      contractRevision: 'contract-v1-rev15',
      packages: {
        '@noblecloak/client': { version: '0.11.1' },
        '@noblecloak/spec': { version: '0.10.1' },
      },
    });
    const versions: Record<string, string> = {
      '@noblecloak/client': '0.11.1',
      '@noblecloak/spec': '0.10.1',
    };
    for (const consumer of CONTRACT_CONSUMERS) {
      const block = read(ROOT, `${consumer.dir}/package.json`)[consumer.field] as Deps;
      expect(block[consumer.name], `${consumer.dir} ${consumer.field}`).toBe(
        versions[consumer.name]
      );
    }
  });
});

// The guard maps no scope to any registry, so the contract pair installs from registry.npmjs.org. This pins
// the pair to the @noblecloak scope and the repository to carrying no registry mapping or token file.
describe('where the contract pair installs from', () => {
  it('is the public registry: the pair is @noblecloak/*, the root has no .npmrc and no scope mapping', () => {
    for (const name of CONTRACT_PACKAGES) expect(name.startsWith('@noblecloak/'), name).toBe(true);
    expect(existsSync(join(ROOT, '.npmrc'))).toBe(false);
    expect(findViolations(ROOT)).toEqual([]);
  });

  it('records the pair under the @noblecloak scope only, so a changed scope is stopped by checkContract', () => {
    const tree = mkdtempSync(join(tmpdir(), 'contract-scope-'));
    try {
      write(tree, 'contract.json', {
        phase: 'registry',
        contractRevision: 'contract-v1-rev15',
        packages: { '@other/client': { version: '0.11.1' }, '@other/spec': { version: '0.10.1' } },
      });
      write(tree, 'package.json', { name: 'x', private: true, license: 'Apache-2.0' });
      expect(checkContract(tree)).toContain(
        'contract.json: lists @other/client, @other/spec, not @noblecloak/client, @noblecloak/spec'
      );
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });
});

describe('checkContract', () => {
  const trees: string[] = [];
  afterEach(() => {
    for (const tree of trees.splice(0)) rmSync(tree, { recursive: true, force: true });
  });

  /** A copy of the files the check reads: the manifests, contract.json and the installed pair. */
  function copyOfRoot(): string {
    const tree = mkdtempSync(join(tmpdir(), 'contract-'));
    trees.push(tree);
    for (const file of ['package.json', 'contract.json'])
      cpSync(join(ROOT, file), join(tree, file));
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

  const editManifest = (tree: string, file: string, edit: (manifest: Json) => void): void => {
    const manifest = read(tree, file);
    edit(manifest);
    write(tree, file, manifest);
  };

  it('accepts an exact copy', () => {
    expect(checkContract(copyOfRoot())).toEqual([]);
  });

  it('names a contract.json that is not in the registry phase, has no revision, or lists another package', () => {
    const tree = copyOfRoot();
    write(tree, 'contract.json', { phase: 'vendored', packages: {} });
    expect(checkContract(tree)).toEqual([
      'contract.json: phase is vendored, not registry',
      'contract.json: contractRevision is undefined, not contract-v<major>-rev<n>',
      'contract.json: lists , not @noblecloak/client, @noblecloak/spec',
    ]);
  });

  it('names a contract revision that is not a contract-v<major>-rev<n> label', () => {
    const tree = copyOfRoot();
    editManifest(tree, 'contract.json', (record) => {
      record.contractRevision = 'rev15';
    });
    expect(checkContract(tree)).toEqual([
      'contract.json: contractRevision is rev15, not contract-v<major>-rev<n>',
    ]);
  });

  it('names a recorded version that is not exact', () => {
    const tree = copyOfRoot();
    editManifest(tree, 'contract.json', (record) => {
      (record.packages as Record<string, Json>)['@noblecloak/client'] = { version: '^0.11.1' };
    });
    expect(checkContract(tree)).toEqual([
      'contract.json: @noblecloak/client is at "^0.11.1", not an exact version',
    ]);
  });

  it('names a recorded version that is not the one installed and the manifests name', () => {
    const tree = copyOfRoot();
    editManifest(tree, 'contract.json', (record) => {
      (record.packages as Record<string, Json>)['@noblecloak/spec'] = { version: '0.10.0' };
    });
    expect(checkContract(tree)).toEqual([
      'node_modules/@noblecloak/spec: installed 0.10.1, not 0.10.0',
      'docs/snippets/package.json: devDependencies.@noblecloak/spec is 0.10.1, not 0.10.0',
      'examples/langgraph-approvals/package.json: dependencies.@noblecloak/spec is 0.10.1, not 0.10.0',
      'packages/langgraph/package.json: devDependencies.@noblecloak/spec is 0.10.1, not 0.10.0',
    ]);
  });

  it('names a workspace manifest that names the pair at another version or as a range', () => {
    const tree = copyOfRoot();
    editManifest(tree, 'packages/langgraph/package.json', (manifest) => {
      (manifest.dependencies as Deps)['@noblecloak/client'] = '^0.11.1';
    });
    editManifest(tree, 'scripts/package.json', (manifest) => {
      (manifest.devDependencies as Deps)['@noblecloak/spec'] = '0.9.0';
    });
    expect(checkContract(tree)).toEqual([
      'packages/langgraph/package.json: dependencies.@noblecloak/client is ^0.11.1, not 0.11.1',
      'scripts/package.json: devDependencies.@noblecloak/spec is 0.9.0, not 0.10.1',
    ]);
  });

  it('names a consumer that no longer names its contract package in its field', () => {
    const tree = copyOfRoot();
    editManifest(tree, 'docs/snippets/package.json', (manifest) => {
      const dev = manifest.devDependencies as Deps;
      manifest.dependencies = { ...(manifest.dependencies as Deps), '@noblecloak/spec': '0.10.1' };
      delete dev['@noblecloak/spec'];
    });
    expect(checkContract(tree)).toEqual([
      'docs/snippets/package.json: devDependencies.@noblecloak/spec is missing, not 0.10.1',
    ]);
  });

  it('names a consumer manifest that is not a workspace any more', () => {
    const tree = copyOfRoot();
    editManifest(tree, 'package.json', (manifest) => {
      manifest.workspaces = (manifest.workspaces as string[]).filter((w) => w !== 'docs/snippets');
    });
    expect(checkContract(tree)).toEqual([
      'docs/snippets/package.json: missing; it names @noblecloak/client',
      'docs/snippets/package.json: missing; it names @noblecloak/spec',
    ]);
  });

  it('names the root manifest when it names a contract package', () => {
    const tree = copyOfRoot();
    editManifest(tree, 'package.json', (manifest) => {
      (manifest.devDependencies as Deps)['@noblecloak/client'] = '0.11.1';
    });
    expect(checkContract(tree)).toEqual([
      'package.json: devDependencies.@noblecloak/client; the root names no contract package',
    ]);
  });

  it('names an overrides or resolutions block in the root or a workspace', () => {
    const tree = copyOfRoot();
    editManifest(tree, 'package.json', (manifest) => {
      manifest.overrides = { '@noblecloak/client': '0.11.1' };
    });
    editManifest(tree, 'examples/langgraph-approvals/package.json', (manifest) => {
      manifest.resolutions = {};
    });
    expect(checkContract(tree)).toEqual([
      'package.json: has overrides; nothing is redirected',
      'examples/langgraph-approvals/package.json: has resolutions; nothing is redirected',
    ]);
  });

  it('names a file: or link: dependency on anything, in the root or a workspace', () => {
    const tree = copyOfRoot();
    editManifest(tree, 'package.json', (manifest) => {
      (manifest.devDependencies as Deps)['left-pad'] = 'file:./vendor/left-pad.tgz';
    });
    editManifest(tree, 'packages/langgraph/package.json', (manifest) => {
      (manifest.dependencies as Deps)['@noblecloak/client'] =
        'file:../../vendor/noblecloak-client-0.11.1.tgz';
    });
    editManifest(tree, 'docs/snippets/package.json', (manifest) => {
      (manifest.dependencies as Deps)['right-pad'] = 'npm:link:../right-pad';
    });
    expect(checkContract(tree)).toEqual([
      'package.json: devDependencies.left-pad is file:./vendor/left-pad.tgz, a path dependency',
      'docs/snippets/package.json: dependencies.right-pad is npm:link:../right-pad, a path dependency',
      'packages/langgraph/package.json: dependencies.@noblecloak/client is file:../../vendor/noblecloak-client-0.11.1.tgz, a path dependency',
      'packages/langgraph/package.json: dependencies.@noblecloak/client is file:../../vendor/noblecloak-client-0.11.1.tgz, not 0.11.1',
    ]);
  });

  it('names a vendor/ directory', () => {
    const tree = copyOfRoot();
    mkdirSync(join(tree, 'vendor'));
    expect(checkContract(tree)).toEqual([
      'vendor/: exists; nothing is vendored in the registry phase',
    ]);
  });

  it('names an installed version that is not the pair, and an install that is missing', () => {
    const tree = copyOfRoot();
    write(tree, 'node_modules/@noblecloak/client/package.json', {
      name: '@noblecloak/client',
      version: '0.10.0',
    });
    rmSync(join(tree, 'node_modules/@noblecloak/spec'), { recursive: true });
    expect(checkContract(tree)).toEqual([
      'node_modules/@noblecloak/client: installed 0.10.0, not 0.11.1',
      'node_modules/@noblecloak/spec: installed undefined, not 0.10.1',
    ]);
  });
});
