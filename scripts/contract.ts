/**
 * Checks that the contract packages this adapter is built against are one pair everywhere they are named. The
 * pair installs from the organisation's package registry by exact version (`contract.json` says
 * `"phase": "registry"`), and these must all agree:
 *
 * - `contract.json`, the record of the pair: the two packages, each at an exact version, and the contract
 *   revision they implement as a recorded label (`contract-v<major>-rev<n>`);
 * - the workspace manifests in `CONTRACT_CONSUMERS`, each naming its contract package at exactly the recorded
 *   version in the field listed there, and any other manifest that names one at that version too;
 * - the versions bun installed under `node_modules/@noblecloak/`.
 *
 * And nothing is vendored or redirected: the root manifest names neither package, no manifest has an `overrides`
 * or `resolutions` block, no manifest has a `file:` or `link:` dependency, and there is no `vendor/` directory.
 * `checkContract` returns one line per disagreement and an empty list when there is none.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { listWorkspacePackages } from './workspace.js';

export const CONTRACT_PACKAGES = ['@noblecloak/client', '@noblecloak/spec'] as const;

type ContractPackage = (typeof CONTRACT_PACKAGES)[number];

/** Where each workspace that uses the pair names it: the manifest's directory, the package and the field. */
export const CONTRACT_CONSUMERS: readonly {
  readonly dir: string;
  readonly name: ContractPackage;
  readonly field: 'dependencies' | 'devDependencies';
}[] = [
  { dir: 'packages/langgraph', name: '@noblecloak/client', field: 'dependencies' },
  { dir: 'packages/langgraph', name: '@noblecloak/spec', field: 'devDependencies' },
  { dir: 'examples/langgraph-approvals', name: '@noblecloak/client', field: 'dependencies' },
  { dir: 'examples/langgraph-approvals', name: '@noblecloak/spec', field: 'dependencies' },
  { dir: 'docs/snippets', name: '@noblecloak/client', field: 'dependencies' },
  { dir: 'docs/snippets', name: '@noblecloak/spec', field: 'devDependencies' },
];

interface ContractRecord {
  readonly phase?: unknown;
  readonly contractRevision?: unknown;
  readonly packages?: Readonly<Record<string, { readonly version?: unknown }>>;
}

type Json = Record<string, unknown>;

const readJson = (file: string): Json => JSON.parse(readFileSync(file, 'utf8')) as Json;

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const CONTRACT_REVISION = /^contract-v\d+-rev\d+$/;
const LOCAL_PATH = /^(?:npm:)?(?:file|link):/;

export function checkContract(root: string): string[] {
  const problems: string[] = [];
  const record = readJson(join(root, 'contract.json')) as ContractRecord;
  const packages = record.packages ?? {};
  const names = Object.keys(packages).sort();
  if (record.phase !== 'registry')
    problems.push(`contract.json: phase is ${String(record.phase)}, not registry`);
  if (
    typeof record.contractRevision !== 'string' ||
    !CONTRACT_REVISION.test(record.contractRevision)
  )
    problems.push(
      `contract.json: contractRevision is ${String(record.contractRevision)}, not contract-v<major>-rev<n>`
    );
  if (names.join() !== [...CONTRACT_PACKAGES].join())
    problems.push(`contract.json: lists ${names.join(', ')}, not ${CONTRACT_PACKAGES.join(', ')}`);

  const versions = new Map<string, string>();
  for (const name of CONTRACT_PACKAGES) {
    const version = packages[name]?.version;
    if (version === undefined) continue;
    if (typeof version !== 'string' || !EXACT_VERSION.test(version)) {
      problems.push(
        `contract.json: ${name} is at ${JSON.stringify(version)}, not an exact version`
      );
      continue;
    }
    versions.set(name, version);
    const installedFile = join(root, 'node_modules', name, 'package.json');
    const installed = existsSync(installedFile) ? readJson(installedFile).version : undefined;
    if (installed !== version)
      problems.push(`node_modules/${name}: installed ${String(installed)}, not ${version}`);
  }

  if (existsSync(join(root, 'vendor')))
    problems.push('vendor/: exists; nothing is vendored in the registry phase');

  // The root manifest and every workspace manifest. The root is not a workspace, so it is listed on its own.
  const manifests = new Map<string, Json>();
  const label = (dir: string): string =>
    dir === root ? 'package.json' : `${relative(root, dir).split(sep).join('/')}/package.json`;
  for (const dir of [root, ...listWorkspacePackages(root).map((pkg) => pkg.dir)]) {
    const manifest = readJson(join(dir, 'package.json'));
    manifests.set(dir === root ? '' : relative(root, dir).split(sep).join('/'), manifest);
    for (const block of ['overrides', 'resolutions'] as const) {
      if (block in manifest) problems.push(`${label(dir)}: has ${block}; nothing is redirected`);
    }
    for (const field of DEPENDENCY_FIELDS) {
      const entries = (manifest[field] ?? {}) as Record<string, string>;
      for (const [dependency, range] of Object.entries(entries)) {
        if (LOCAL_PATH.test(range))
          problems.push(`${label(dir)}: ${field}.${dependency} is ${range}, a path dependency`);
        const version = versions.get(dependency);
        if (version === undefined) continue;
        if (dir === root)
          problems.push(`package.json: ${field}.${dependency}; the root names no contract package`);
        else if (range !== version)
          problems.push(`${label(dir)}: ${field}.${dependency} is ${range}, not ${version}`);
      }
    }
  }

  for (const consumer of CONTRACT_CONSUMERS) {
    const version = versions.get(consumer.name);
    const manifest = manifests.get(consumer.dir);
    if (version === undefined) continue;
    if (manifest === undefined) {
      problems.push(`${consumer.dir}/package.json: missing; it names ${consumer.name}`);
      continue;
    }
    const block = (manifest[consumer.field] ?? {}) as Record<string, string>;
    if (block[consumer.name] === undefined)
      problems.push(
        `${consumer.dir}/package.json: ${consumer.field}.${consumer.name} is missing, not ${version}`
      );
  }
  return problems;
}
