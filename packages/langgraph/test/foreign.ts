/** Helpers for the ownership tests: our agent over one checkpoint file, and another principal of the same organisation. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';

import { governedToolNode } from '../src/governed.js';
import { ask, buildGraph, call, makeTools, start, TOOL_REFS } from './graph.js';
import type { Counters } from './graph.js';
import { createHarness } from './harness.js';
import type { Harness } from './harness.js';

export const SEND = [ask(call('c1', 'send_email', { to: 'a@b.c' }))];

export async function world() {
  const h = await createHarness();
  const file = join(mkdtempSync(join(tmpdir(), 'nc-a2-')), 'c.sqlite');
  const counters: Counters = { runs: [] };
  const agent = buildGraph({
    script: SEND,
    checkpointer: SqliteSaver.fromConnString(file),
    toolNode: governedToolNode([makeTools(counters).sendEmail], {
      toolRefs: TOOL_REFS,
      governance: h.governance,
    }),
  });
  return { h, counters, agent };
}

/** Another principal of the same organisation opens an approval of its own (its own agent, its own checkpointer). */
export async function foreignApproval(h: Harness, threadId: string): Promise<string> {
  const before = h.approvals().length;
  const other = h.anotherGovernance({ getToken: () => h.tokens.creator_user });
  const graph = buildGraph({
    script: SEND,
    toolNode: governedToolNode([makeTools({ runs: [] }).sendEmail], {
      toolRefs: TOOL_REFS,
      governance: other,
    }),
  });
  await graph.invoke(start(), { configurable: { thread_id: threadId } });
  return h.approvals()[before] ?? '';
}

export const ours = (h: Harness) => {
  const governance = h.anotherGovernance();
  governance.registerTool('send_email', 'ext:local:send_email');
  return governance;
};
