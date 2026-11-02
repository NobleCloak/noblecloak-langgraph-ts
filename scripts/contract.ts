/**
 * Checks that the contract packages this adapter is built against are one pair everywhere they are named.
 * While they are vendored (`contract.json` says `"phase": "vendored"`) the pair is two tarballs under `vendor/`,
 * and these must all name the same two packages at the same versions:
 *
 * - `contract.json`, the record of the pair;
 * - the root `overrides`, which point both packages at their tarballs (the packed spec depends on client by
 *   version, so the override also answers for that);
 * - every workspace manifest that depends on either package;
 * - `vendor/SHA256SUMS` and the tarballs it lists, and the `package.json` inside each tarball;
 * - the versions bun installed under `node_modules/@noblecloak/`.
 *
 * Nothing else may be vendored: no other file under `vendor/`, and no `file:` dependency on any other package.
 * `checkContract` returns one line per disagreement and an empty list when there is none.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, posix, relative, resolve, sep } from 'node:path';

import { listWorkspacePackages } from './workspace.js';

export const CONTRACT_PACKAGES = ['@noblecloak/client', '@noblecloak/spec'] as const;

interface ContractRecord {
  readonly phase: string;
  readonly packages: Readonly<
    Record<string, { readonly version: string; readonly tarball: string }>
  >;
}

type Json = Record<string, unknown>;

const readJson = (file: string): Json => JSON.parse(readFileSync(file, 'utf8')) as Json;

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

/** `sha256sum`-format lines (`<hash>  <name>`) as a map from file name to hash. */
export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) sums.set(match[2], match[1]);
  }
  return sums;
}

function tarballManifest(tarball: string): Json | undefined {
  const result = spawnSync('tar', ['xzOf', tarball, 'package/package.json'], { encoding: 'utf8' });
  return result.status === 0 ? (JSON.parse(result.stdout) as Json) : undefined;
}

export function checkContract(root: string): string[] {
  const problems: string[] = [];
  const record = readJson(join(root, 'contract.json')) as unknown as ContractRecord;
  const names = Object.keys(record.packages).sort();
  if (record.phase !== 'vendored')
    problems.push(`contract.json: phase is ${record.phase}, not vendored`);
  if (names.join() !== [...CONTRACT_PACKAGES].join())
    problems.push(`contract.json: lists ${names.join(', ')}, not ${CONTRACT_PACKAGES.join(', ')}`);

  const rootManifest = readJson(join(root, 'package.json'));
  const overrides = (rootManifest.overrides ?? {}) as Record<string, string>;
  if (Object.keys(overrides).sort().join() !== [...CONTRACT_PACKAGES].join())
    problems.push(
      `package.json: overrides name ${Object.keys(overrides).sort().join(', ')}, not ${CONTRACT_PACKAGES.join(', ')}`
    );

  const vendored = new Set<string>();
  for (const name of CONTRACT_PACKAGES) {
    const entry = record.packages[name];
    if (entry === undefined) continue;
    vendored.add(posix.basename(entry.tarball));
    if (overrides[name] !== `file:./${entry.tarball}`)
      problems.push(
        `package.json: overrides.${name} is ${overrides[name] ?? 'missing'}, not file:./${entry.tarball}`
      );
    const file = join(root, entry.tarball);
    const inside = existsSync(file) ? tarballManifest(file) : undefined;
    if (inside === undefined) problems.push(`${entry.tarball}: missing or not a package tarball`);
    else if (inside.name !== name || inside.version !== entry.version)
      problems.push(
        `${entry.tarball}: holds ${String(inside.name)}@${String(inside.version)}, not ${name}@${entry.version}`
      );
    const installedFile = join(root, 'node_modules', name, 'package.json');
    const installed = existsSync(installedFile) ? readJson(installedFile).version : undefined;
    if (installed !== entry.version)
      problems.push(`node_modules/${name}: installed ${String(installed)}, not ${entry.version}`);
  }

  // vendor/ holds the two tarballs and their checksums, nothing else.
  const vendorDir = join(root, 'vendor');
  const present = existsSync(vendorDir) ? readdirSync(vendorDir).sort() : [];
  const expected = [...vendored, 'SHA256SUMS'].sort();
  if (present.join() !== expected.join())
    problems.push(`vendor/: holds ${present.join(', ')}, not ${expected.join(', ')}`);
  const sumsFile = join(vendorDir, 'SHA256SUMS');
  const sums = existsSync(sumsFile)
    ? parseChecksums(readFileSync(sumsFile, 'utf8'))
    : new Map<string, string>();
  if ([...sums.keys()].sort().join() !== [...vendored].sort().join())
    problems.push(
      `vendor/SHA256SUMS: lists ${[...sums.keys()].sort().join(', ')}, not ${[...vendored].sort().join(', ')}`
    );
  for (const name of vendored) {
    const file = join(vendorDir, name);
    if (!existsSync(file)) continue;
    const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (sums.get(name) !== actual)
      problems.push(
        `vendor/${name}: sha256 is ${actual}, SHA256SUMS says ${sums.get(name) ?? 'nothing'}`
      );
  }

  // The root manifest and every workspace manifest: a contract package is the vendored tarball, and nothing
  // else is a file: pin. The root is not a workspace, so it is listed on its own.
  const manifestDirs = [root, ...listWorkspacePackages(root).map((pkg) => pkg.dir)];
  for (const dir of manifestDirs) {
    const manifest = readJson(join(dir, 'package.json'));
    const label =
      dir === root ? 'package.json' : `${relative(root, dir).split(sep).join('/')}/package.json`;
    for (const field of DEPENDENCY_FIELDS) {
      const block = (manifest[field] ?? {}) as Record<string, string>;
      for (const [dependency, range] of Object.entries(block)) {
        const entry = record.packages[dependency];
        if (entry !== undefined) {
          const pinned = range.startsWith('file:')
            ? resolve(dir, range.slice('file:'.length))
            : undefined;
          if (pinned !== resolve(root, entry.tarball))
            problems.push(
              `${label}: ${field}.${dependency} is ${range}, not the tarball ${entry.tarball}`
            );
        } else if (range.startsWith('file:')) {
          problems.push(
            `${label}: ${field}.${dependency} is ${range}; nothing but the contract pair is vendored`
          );
        }
      }
    }
  }
  return problems;
}
