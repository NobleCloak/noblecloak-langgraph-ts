/**
 * Packs every public workspace package into `artifacts/` with `bun pm pack` (which rewrites
 * `workspace:` ranges to real versions), then checks that each tarball carries the license text.
 * `bun run pack:all` runs it, and the skill's acceptance run packs the adapter with it. `scripts/release.ts`
 * publishes the tarballs it leaves in `artifacts/` as they are; it never packs, installs or builds.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import { listPublicPackages } from './workspace.js';

export type Runner = (command: string, args: readonly string[], cwd: string) => number;

export const runCommand: Runner = (command, args, cwd) =>
  spawnSync(command, [...args], { cwd, stdio: 'inherit' }).status ?? 1;

/** Lists the entry paths inside a tarball. */
export type EntryLister = (tarball: string) => readonly string[];

export const listTarEntries: EntryLister = (tarball) => {
  const result = spawnSync('tar', ['tzf', tarball], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`tar tzf failed for ${tarball}: ${result.stderr}`);
  return result.stdout.split('\n').filter((line) => line !== '');
};

/**
 * Apache-2.0 §4(a) and §4(d): a redistributed package carries the license and the NOTICE file.
 * Each public package keeps copies of the root LICENSE and NOTICE and lists them in `files`.
 */
export const REQUIRED_ENTRIES = ['package/package.json', 'package/LICENSE', 'package/NOTICE'];

/** The required entries a tarball is missing. */
export function missingEntries(entries: readonly string[]): string[] {
  return REQUIRED_ENTRIES.filter((entry) => !entries.includes(entry));
}

/** Packs each public package into `<root>/artifacts`. Returns the tarball paths. */
export function packAll(
  root: string,
  run: Runner = runCommand,
  list: EntryLister = listTarEntries
): string[] {
  const destination = join(root, 'artifacts');
  mkdirSync(destination, { recursive: true });
  for (const pkg of listPublicPackages(root)) {
    const status = run('bun', ['pm', 'pack', '--destination', destination], pkg.dir);
    if (status !== 0)
      throw new Error(`bun pm pack failed for ${pkg.name} (exit ${String(status)})`);
  }
  return verifyTarballs(destination, list);
}

/**
 * Lists the tarballs already in `destination` and checks each carries the required entries.
 * Throws when the directory is missing or empty, or when a tarball lacks an entry.
 */
export function verifyTarballs(destination: string, list: EntryLister = listTarEntries): string[] {
  if (!existsSync(destination)) throw new Error(`${destination} does not exist; nothing to verify`);
  const tarballs = readdirSync(destination)
    .filter((file) => file.endsWith('.tgz'))
    .sort()
    .map((file) => join(destination, file));
  const problems = tarballs.flatMap((tarball) =>
    missingEntries(list(tarball)).map((entry) => `${basename(tarball)} is missing ${entry}`)
  );
  if (tarballs.length === 0) throw new Error(`${destination} holds no .tgz files`);
  if (problems.length > 0) throw new Error(problems.join('\n'));
  return tarballs;
}

if (import.meta.main) {
  for (const tarball of packAll(process.cwd())) console.log(tarball);
}
