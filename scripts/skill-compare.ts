/**
 * The pure half of `skill-exercise-agent.ts`: which of the langgraph skill's templates are the example's files,
 * and how a template is compared with the example's file (formatting and the order of binding imports ignored).
 * Trimmed from the spec repository's `skill-compare.ts` at 0620a1d to the Node-agent shape; the Next.js skills'
 * shapes stay there.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { format } from 'prettier';

/**
 * A template that is an example file: the template's path under the skill's `templates/` and the example's path
 * under `examples/langgraph-approvals/`. The two are compared by `compareFixedFiles`.
 */
export interface FixedFile {
  readonly template: string;
  readonly example: string;
}

/**
 * What the exercise needs of a skill for a Node agent project (no browser): the template files that are also the
 * example's, which it compares. The templates not listed (`governance.ts`, `worker.ts`, `agent.json`) have no
 * counterpart in the example and are exercised by running them, so `unpaired` names them and a test fails when a
 * template is in neither list.
 */
export interface NodeAgentSkillShape {
  readonly kind: 'node-agent';
  readonly dir: string;
  /** The package whose tarball the project installs; its contract dependencies come from the public npm registry. */
  readonly rootPackage: string;
  readonly fixed: readonly FixedFile[];
  readonly unpaired: readonly string[];
}

/** The files the langgraph skill generates that are the example's files, byte for byte up to formatting. */
export const LANGGRAPH_FIXED_FILES: readonly FixedFile[] = [
  { template: 'log.ts', example: 'src/log.ts' },
];

/**
 * The langgraph skill's templates that have no example counterpart: `governance.ts` is the example's
 * `creator-token.ts` without its `NC_TOKEN` branch (the agent runs as a service principal only), plus the
 * `createGovernance` call; `worker.ts` is `src/bin/worker.ts` for any project's agent; `agent.json` is a stub.
 */
export const LANGGRAPH_UNPAIRED_TEMPLATES: readonly string[] = [
  'agent.json',
  'governance.ts',
  'worker.ts',
];

export const SKILLS: Readonly<{ langgraph: NodeAgentSkillShape }> = {
  langgraph: {
    kind: 'node-agent',
    dir: 'langgraph',
    rootPackage: '@noblecloak/langgraph',
    fixed: LANGGRAPH_FIXED_FILES,
    unpaired: LANGGRAPH_UNPAIRED_TEMPLATES,
  },
};

/** Fixed formatting options (the repository's own), so neither side's prettier configuration takes part. */
const FORMAT = {
  semi: true,
  singleQuote: true,
  trailingComma: 'es5',
  printWidth: 100,
  tabWidth: 2,
} as const;

/** `import x from`, `import { … } from`, `import type …`: an import that binds a name, so its order is free. */
const isBindingImport = (statement: string): boolean => /^import\s[^'"]*\sfrom\s/.test(statement);

/**
 * The text formatted by prettier with fixed options, then, in each run of import statements at the start of a
 * line, the binding imports sorted among the places binding imports hold, and the blank lines in and after the
 * run dropped.
 * A bare side-effect import (`import './x.css';`) keeps its place: their order is the order the styles apply.
 * Prettier leaves string and template literal contents alone, so a difference inside one is a difference.
 * `filepath` picks the parser (`.ts` or `.tsx`).
 */
export async function normalize(text: string, filepath: string): Promise<string> {
  const lines = (await format(text, { ...FORMAT, filepath })).split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length;) {
    if (!(lines[i] ?? '').startsWith('import ')) {
      out.push(lines[i] ?? '');
      i += 1;
      continue;
    }
    // One run: import statements (each joined onto one line); the blank lines between and after them go.
    const run: string[] = [];
    while (i < lines.length) {
      const line = lines[i] ?? '';
      if (line === '') {
        i += 1;
        continue;
      }
      if (!line.startsWith('import ')) break;
      let statement = line;
      while (!statement.trimEnd().endsWith(';') && i + 1 < lines.length)
        statement += ` ${(lines[++i] ?? '').trim()}`;
      run.push(statement);
      i += 1;
    }
    const sorted = run.filter(isBindingImport).sort();
    out.push(
      ...run.map((statement) => (isBindingImport(statement) ? (sorted.shift() ?? '') : statement))
    );
  }
  return out.join('\n');
}

export interface FileDifference {
  readonly file: string;
  readonly reason: 'missing' | 'differs';
}

/**
 * The fixed files of a Node-agent skill whose normalized text differs between the template tree and the example
 * (`missing` when the template tree lacks the file).
 */
export async function compareFixedFiles(
  exampleDir: string,
  templatesDir: string,
  fixed: readonly FixedFile[]
): Promise<FileDifference[]> {
  const found: FileDifference[] = [];
  for (const { template, example } of fixed) {
    const generated = join(templatesDir, template);
    if (!existsSync(generated)) {
      found.push({ file: template, reason: 'missing' });
      continue;
    }
    const expected = await normalize(readFileSync(join(exampleDir, example), 'utf8'), template);
    if (expected !== (await normalize(readFileSync(generated, 'utf8'), template)))
      found.push({ file: template, reason: 'differs' });
  }
  return found;
}

/** Templates in neither the fixed nor the unpaired list, and listed templates the skill does not ship. */
export function nodeTemplateGaps(templates: readonly string[], shape: NodeAgentSkillShape) {
  const listed = [...shape.fixed.map((f) => f.template), ...shape.unpaired];
  return {
    unlisted: templates.filter((file) => !listed.includes(file)),
    stale: listed.filter((file) => !templates.includes(file)),
    both: shape.unpaired.filter((file) => shape.fixed.some((f) => f.template === file)),
  };
}

export interface StepTime {
  readonly name: string;
  readonly ms: number;
}

/** What the langgraph run's timer leaves out: the workspace install (the scaffold's own install is timed). */
export const AGENT_WALL_TIME_EXCLUDES = ['bun install (the workspace)'] as const;

export interface WallTimeReport {
  totalMs: number;
  /**
   * True only for a run in which every step ran and passed. False when a step was left out (`--skip-e2e`)
   * or a step threw (`failedStep`): the figure is then not comparable with a full run.
   */
  complete: boolean;
  /** The name of the step that threw, when one did; the steps after it did not run. */
  failedStep?: string;
  skipped: readonly string[];
  /** What the steps do not time, so the figure is read for what it is. */
  excludes: readonly string[];
  steps: readonly StepTime[];
}

export function wallTimeReport(
  steps: readonly StepTime[],
  skipped: readonly string[] = [],
  failedStep?: string,
  excludes: readonly string[] = AGENT_WALL_TIME_EXCLUDES
): WallTimeReport {
  return {
    totalMs: steps.reduce((sum, step) => sum + step.ms, 0),
    complete: failedStep === undefined && skipped.length === 0,
    ...(failedStep === undefined ? {} : { failedStep }),
    skipped,
    excludes,
    steps,
  };
}
