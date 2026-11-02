import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { checkGuides, extractBlocks, snippetNames } from './sync-check.js';

const SNIPPETS = import.meta.dirname;
const GUIDES = resolve(SNIPPETS, '../how-to');

describe('the guides under docs/how-to', () => {
  it('show exactly the text of the snippet files, and every snippet file is shown', () => {
    expect(checkGuides(GUIDES, SNIPPETS)).toEqual([]);
  });

  it('show the two snippets the guide is built on', () => {
    expect(snippetNames(SNIPPETS)).toEqual(['adapter', 'connect']);
  });
});

describe('extractBlocks', () => {
  it('reads a marked block with its marker line', () => {
    const markdown =
      'Text.\n\n<!-- snippet: allow -->\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n';
    expect(extractBlocks(markdown)).toEqual({
      blocks: [{ name: 'allow', code: 'const a = 1;\n\nconst b = 2;\n', line: 3 }],
      problems: [],
    });
  });

  it('reads a block whose fence follows the marker without a blank line', () => {
    const { blocks, problems } = extractBlocks('<!-- snippet: a -->\n```ts\nx;\n```\n');
    expect(blocks).toEqual([{ name: 'a', code: 'x;\n', line: 1 }]);
    expect(problems).toEqual([]);
  });

  it('refuses a ts fence without a marker, and still reads the next marked block', () => {
    const markdown = '```ts\nx;\n```\n\n<!-- snippet: b -->\n\n```ts\ny;\n```\n';
    const { blocks, problems } = extractBlocks(markdown);
    expect(problems).toEqual(['line 1: a ```ts fence has no snippet marker']);
    expect(blocks.map((block) => block.name)).toEqual(['b']);
  });

  it('refuses a marker that no ts fence follows', () => {
    const { blocks, problems } = extractBlocks('<!-- snippet: a -->\n```json\n{}\n```\n');
    expect(blocks).toEqual([]);
    expect(problems).toEqual(['line 1: the marker is not followed by a ```ts fence']);
  });

  it.each(['```typescript', '```tsx', '```ts title="a.ts"', '```mts'])(
    'refuses a %s fence without a marker',
    (fence) => {
      const { blocks, problems } = extractBlocks(`${fence}\nx;\n\`\`\`\n`);
      expect(blocks).toEqual([]);
      expect(problems).toHaveLength(1);
    }
  );

  it('reads a marked block whose fence is typescript with a title', () => {
    const { blocks, problems } = extractBlocks(
      '<!-- snippet: a -->\n\n```ts title="a.ts"\nx;\n```\n'
    );
    expect(blocks).toEqual([{ name: 'a', code: 'x;\n', line: 1 }]);
    expect(problems).toEqual([]);
  });

  it('leaves tsconfig-like and other-language fences alone', () => {
    expect(extractBlocks('```tsv\na\n```\n```json\n{}\n```\n')).toEqual({
      blocks: [],
      problems: [],
    });
  });

  it('leaves fences of other languages alone', () => {
    expect(extractBlocks('```sh\nbun install\n```\n')).toEqual({ blocks: [], problems: [] });
  });
});

describe('checkGuides', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A guides directory and a snippets directory in a temporary tree. */
  function tree(guide: string, files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), 'snippets-'));
    dirs.push(root);
    mkdirSync(join(root, 'how-to'));
    mkdirSync(join(root, 'snippets'));
    writeFileSync(join(root, 'how-to/a.md'), guide);
    for (const [name, text] of Object.entries(files))
      writeFileSync(join(root, 'snippets', name), text);
    return { guides: join(root, 'how-to'), snippets: join(root, 'snippets') };
  }

  const GUIDE = '<!-- snippet: one -->\n\n```ts\nexport const one = 1;\n```\n';

  it('accepts a block that is the file', () => {
    const { guides, snippets } = tree(GUIDE, { 'one.ts': 'export const one = 1;\n' });
    expect(checkGuides(guides, snippets)).toEqual([]);
  });

  it('names a block that differs from its file by a single trailing space', () => {
    const { guides, snippets } = tree(GUIDE, { 'one.ts': 'export const one = 1; \n' });
    expect(checkGuides(guides, snippets)).toEqual(['a.md:1: differs from one.ts']);
  });

  it('names a block whose file does not exist', () => {
    const { guides, snippets } = tree(GUIDE, {});
    expect(checkGuides(guides, snippets)).toEqual(['a.md:1: no snippet file one.ts']);
  });

  it('names a snippet file that no guide shows, and ignores tests and the config', () => {
    const { guides, snippets } = tree(GUIDE, {
      'one.ts': 'export const one = 1;\n',
      'two.ts': 'export const two = 2;\n',
      'two.test.ts': '',
      'vitest.config.ts': '',
      'sync-check.ts': '',
    });
    expect(checkGuides(guides, snippets)).toEqual(['two.ts: no guide shows it']);
  });

  it('names an unmarked ts fence', () => {
    const { guides, snippets } = tree('```ts\nx;\n```\n\n' + GUIDE, {
      'one.ts': 'export const one = 1;\n',
    });
    expect(checkGuides(guides, snippets)).toEqual([
      'a.md: line 1: a ```ts fence has no snippet marker',
    ]);
  });

  it('reports a directory with no guide', () => {
    const { guides, snippets } = tree(GUIDE, { 'one.ts': 'export const one = 1;\n' });
    rmSync(join(guides, 'a.md'));
    expect(checkGuides(guides, snippets)).toEqual([
      `no guide under ${guides}`,
      'one.ts: no guide shows it',
    ]);
    expect(checkGuides(join(guides, 'missing'), snippets)[0]).toContain('no guide under');
  });
});
