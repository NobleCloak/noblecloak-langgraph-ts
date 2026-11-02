/**
 * Keeps the guides under docs/how-to and the typechecked files in this directory the same text.
 *
 * A fenced `ts` block in a guide (any of ts, tsx, typescript, mts, cts, with or without attributes) is written as a marker line and the fence, with the one blank line
 * prettier puts after an HTML comment:
 *
 *     <!-- snippet: allow -->
 *
 *     ```ts
 *     ...
 *     ```
 *
 * and must be byte-identical to `adapter.ts` here. A `ts` fence without a marker is refused, so no code in a
 * guide escapes the typecheck; so is a snippet file that no guide shows.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Block {
  /** The snippet name from the marker. */
  readonly name: string;
  /** The code between the fences, each line ended by a newline. */
  readonly code: string;
  /** The 1-based line of the marker. */
  readonly line: number;
}

export interface Extracted {
  readonly blocks: readonly Block[];
  readonly problems: readonly string[];
}

const MARKER = /^<!-- snippet: ([a-z0-9-]+) -->$/;
/** A fence opening a TypeScript block: ts, tsx, typescript, mts or cts, with or without attributes after it. */
const TS_FENCE = /^```(ts|tsx|typescript|mts|cts)(\s.*)?$/;

/** The marked blocks of a guide, and the places where a `ts` fence has no marker or a marker no fence. */
export function extractBlocks(markdown: string): Extracted {
  const lines = markdown.split('\n');
  const blocks: Block[] = [];
  const problems: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const text = lines[index] ?? '';
    const marker = MARKER.exec(text);
    if (marker === null && !TS_FENCE.test(text)) {
      index += 1;
      continue;
    }
    // The fence is the next line, or the one after it when prettier has put a blank line in between.
    const fenceAt = marker === null ? index : lines[index + 1] === '' ? index + 2 : index + 1;
    if (!TS_FENCE.test(lines[fenceAt] ?? '')) {
      problems.push(`line ${String(index + 1)}: the marker is not followed by a \`\`\`ts fence`);
      index += 1;
      continue;
    }
    if (marker === null) {
      problems.push(`line ${String(index + 1)}: a \`\`\`ts fence has no snippet marker`);
    }
    const start = fenceAt + 1;
    let end = start;
    while (end < lines.length && lines[end] !== '```') end += 1;
    if (marker?.[1] !== undefined) {
      const code = lines.slice(start, end).join('\n') + '\n';
      blocks.push({ name: marker[1], code, line: index + 1 });
    }
    index = end + 1;
  }
  return { blocks, problems };
}

/** The snippet files of `snippetsDir`: every `.ts` file that is not a test, the config or this module. */
export function snippetNames(snippetsDir: string): string[] {
  return readdirSync(snippetsDir)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .filter((file) => file !== 'vitest.config.ts' && file !== 'sync-check.ts')
    .map((file) => file.slice(0, -'.ts'.length))
    .sort();
}

/** Every way the guides and the snippets disagree, as `file:line: problem`; empty when they are the same text. */
export function checkGuides(guidesDir: string, snippetsDir: string): string[] {
  const problems: string[] = [];
  const shown = new Set<string>();
  const guides = existsSync(guidesDir)
    ? readdirSync(guidesDir)
        .filter((file) => file.endsWith('.md'))
        .sort()
    : [];
  if (guides.length === 0) problems.push(`no guide under ${guidesDir}`);
  for (const guide of guides) {
    const extracted = extractBlocks(readFileSync(join(guidesDir, guide), 'utf8'));
    for (const problem of extracted.problems) problems.push(`${guide}: ${problem}`);
    for (const block of extracted.blocks) {
      shown.add(block.name);
      const file = join(snippetsDir, `${block.name}.ts`);
      if (!existsSync(file)) {
        problems.push(`${guide}:${String(block.line)}: no snippet file ${block.name}.ts`);
      } else if (readFileSync(file, 'utf8') !== block.code) {
        problems.push(`${guide}:${String(block.line)}: differs from ${block.name}.ts`);
      }
    }
  }
  for (const name of snippetNames(snippetsDir)) {
    if (!shown.has(name)) problems.push(`${name}.ts: no guide shows it`);
  }
  return problems;
}
