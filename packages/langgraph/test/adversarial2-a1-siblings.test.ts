/** A1: a call that is allowed does not run on a pass whose node ends up pausing, including the pass of a race loser. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { describe, expect, it } from 'vitest';

import { governedToolNode } from '../src/governed.js';
import { resumeApproval } from '../src/resume.js';
import { ask, buildGraph, call, makeTools, start, TOOL_REFS } from './graph.js';
import type { Counters } from './graph.js';
import { createHarness } from './harness.js';
import { sleep } from './wait.js';

const THREAD = { configurable: { thread_id: 'race' } };

describe('A1: a sibling waits for the claimant outcome', () => {
  it('two resumers race at /consume over one checkpoint file: the allowed sibling runs exactly once, one record each', async () => {
    const h = await createHarness();
    const file = join(mkdtempSync(join(tmpdir(), 'nc-a1-')), 'c.sqlite');
    const counters: Counters = { runs: [] };
    const script = [
      ask(call('c1', 'send_email', { to: 'a@b.c' }), call('c2', 'search', { q: 'z' })),
    ];
    const world = (governance = h.anotherGovernance()) => {
      const made = makeTools(counters);
      return {
        governance,
        graph: buildGraph({
          script,
          checkpointer: SqliteSaver.fromConnString(file),
          toolNode: governedToolNode([made.sendEmail, made.search], {
            toolRefs: TOOL_REFS,
            governance,
          }),
        }),
      };
    };
    const agent = world(h.governance);
    await agent.graph.invoke(start(), THREAD);
    expect(counters.runs).toHaveLength(0);
    const [id = ''] = h.approvals();
    await h.approve(id);
    const a = world();
    const b = world();
    // Both tool nodes read the Resumption before either consumes; the second consume is held back.
    let reads = 0;
    let consumes = 0;
    let release!: () => void;
    const both = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.intercept = async (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path.endsWith('/resumption')) {
        reads += 1;
        if (reads === 3 || reads === 4) {
          if (reads === 4) release();
          await Promise.race([both, sleep(3000)]);
        }
      }
      if (path.endsWith('/consume')) {
        consumes += 1;
        if (consumes === 2) await sleep(200);
      }
      return undefined;
    };
    const results = await Promise.allSettled([
      resumeApproval(a.graph, id, { governance: a.governance }),
      resumeApproval(b.graph, id, { governance: b.governance }),
    ]);
    expect(consumes).toBe(2);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(counters.runs.map((r) => r.name).sort()).toEqual(['search', 'send_email']);
    expect(h.mock.state.records.map((r: { tool_ref: string }) => r.tool_ref).sort()).toEqual(
      [TOOL_REFS.search, TOOL_REFS.send_email].sort()
    );
  });
});
