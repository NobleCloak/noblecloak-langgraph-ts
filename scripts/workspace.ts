import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface WorkspacePackage {
  /** Absolute directory of the package. */
  readonly dir: string;
  readonly name: string;
  readonly version: string;
  readonly private: boolean;
}

/**
 * Resolves the root package.json `workspaces` globs. Supports the two shapes this repo uses:
 * a literal directory (`scripts`) and a single trailing `*` (`packages/*`). A directory counts
 * only when it holds a package.json, which is how bun matches workspaces.
 */
export function listWorkspacePackages(root: string): WorkspacePackage[] {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    workspaces?: string[];
  };
  const dirs: string[] = [];
  for (const pattern of manifest.workspaces ?? []) {
    if (pattern.endsWith('/*')) {
      const parent = join(root, pattern.slice(0, -2));
      if (!existsSync(parent)) continue;
      for (const entry of readdirSync(parent, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(join(parent, entry.name));
      }
    } else {
      dirs.push(join(root, pattern));
    }
  }
  return dirs
    .filter((dir) => existsSync(join(dir, 'package.json')))
    .sort()
    .map((dir) => {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name: string;
        version: string;
        private?: boolean;
      };
      return { dir, name: pkg.name, version: pkg.version, private: pkg.private === true };
    });
}

/** The packages that are published to npm (everything not marked `private`). */
export function listPublicPackages(root: string): WorkspacePackage[] {
  return listWorkspacePackages(root).filter((pkg) => !pkg.private);
}
