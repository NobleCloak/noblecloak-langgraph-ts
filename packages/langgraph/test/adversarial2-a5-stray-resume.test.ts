/**
 * A5: when an earlier call of the task does not pause on a pass (it is admitted, or its decision changed since
 * the first run), `interrupt()` of a later claimant returns the resume value meant for the earlier one. The
 * claimant is then a fresh pause: it keeps its own approval and pauses on it; nothing is withdrawn.
 */
import { ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';

import { argDigest } from '@noblecloak/client';

import { denialCodeOf } from '../src/denial.js';
import { governedToolNode } from '../src/governed.js';
import { resumeApproval } from '../src/resume.js';
import { ask, buildGraph, call, makeTools, start, TOOL_REFS } from './graph.js';
import type { Counters } from './graph.js';
import { createHarness } from './harness.js';
import { sleep, until } from './wait.js';

const CFG = { configurable: { thread_id: 't1' } };

describe('A5: a claimant handed the resume value of another call is a fresh pause', () => {
  it('[send_email c1 (admitted on resume), send_sms c2 (gated)]: c2 pauses on its own approval, nothing is withdrawn, and one more answer runs both once', async () => {
    const h = await createHarness();
    const counters: Counters = { runs: [] };
    const made = makeTools(counters);
    const graph = buildGraph({
      script: [
        ask(call('c1', 'send_email', { to: 'a@b.c' }), call('c2', 'send_sms', { to: '555' })),
      ],
      // c1's tool is the gateway's: on the re-run the gateway admits it (an allow carrying the approval).
      toolNode: governedToolNode([made.sendEmail, made.sendSms], {
        toolRefs: TOOL_REFS,
        governance: h.governance,
        gatewayTools: ['send_email'],
      }),
    });
    const first = await graph.invoke(start(), CFG);
    const pending = (first as { __interrupt__?: { value: { tool_call_id: string } }[] })
      .__interrupt__;
    expect(pending?.map((p) => p.value.tool_call_id)).toEqual(['c1']);
    const [x = ''] = h.approvals();
    const withdrawn = () =>
      h.approvals().filter((id) => h.mock.state.obligations.get(id)?.state === 'withdrawn');
    // The first pass opened an approval for c2 without a continuation and withdrew it (c1 held the pause).
    // A call still deciding when its sibling pauses finishes on its own; wait for that withdrawal, not a fixed time.
    await until(() => withdrawn().length > 0);
    const withdrawnBefore = withdrawn();
    await h.approve(x);
    // On the re-run the gateway admits c1 itself: the decision is allow, and carries the approval x.
    const digest = await argDigest({ to: 'a@b.c' });
    h.intercept = (request, body) => {
      const sent = body as { action?: { tool_ref?: string } } | undefined;
      if (
        new URL(request.url).pathname === '/v1/decisions' &&
        sent?.action?.tool_ref === TOOL_REFS.send_email
      ) {
        return Response.json({
          data: {
            decision: 'allow',
            action_digest: digest,
            enforced: true,
            approval: {
              id: x,
              state: 'approved',
              created: false,
              created_at: new Date().toISOString(),
              resume_token_will_issue: false,
            },
          },
          meta: { request_id: 'r', deployment: 'hosted' },
        });
      }
      return undefined;
    };
    await resumeApproval(graph, x, { governance: h.governance });

    const approvals = h.approvals();
    const own = approvals.find(
      (id) =>
        h.mock.state.obligations.get(id)?.toolRef === TOOL_REFS.send_sms &&
        h.mock.state.obligations.get(id)?.state === 'pending'
    );
    expect(own).toBeDefined();
    expect(withdrawn()).toEqual(withdrawnBefore);
    const state = await graph.getState(CFG);
    expect(
      state.tasks.flatMap((t) =>
        t.interrupts.map((i) => (i.value as { approval_id?: string }).approval_id)
      )
    ).toEqual([own]);
    const toolMessages = (state.values as { messages: BaseMessage[] }).messages.filter(
      (m): m is ToolMessage => m instanceof ToolMessage
    );
    expect(toolMessages.map((m) => denialCodeOf(m))).toEqual([]);
    expect(counters.runs).toHaveLength(0);

    // Its answer runs both calls, once.
    await h.approve(own ?? '');
    await resumeApproval(graph, own ?? '', { governance: h.governance });
    expect(counters.runs.map((r) => r.name).sort()).toEqual(['send_email', 'send_sms']);
    const done = (await graph.getState(CFG)).values as { messages: BaseMessage[] };
    expect(done.messages.at(-1)?.content).toBe('done');
    expect(
      done.messages
        .filter((m): m is ToolMessage => m instanceof ToolMessage)
        .map((m) => denialCodeOf(m))
    ).toEqual([undefined, undefined]);
  });

  it('an earlier call whose decision changed between the two runs (gated, then allowed): the later claimant pauses on its own approval', async () => {
    const h = await createHarness();
    const counters: Counters = { runs: [] };
    const made = makeTools(counters);
    const graph = buildGraph({
      script: [
        ask(call('c1', 'send_email', { to: 'a@b.c' }), call('c2', 'send_sms', { to: '555' })),
      ],
      toolNode: governedToolNode([made.sendEmail, made.sendSms], {
        toolRefs: TOOL_REFS,
        governance: h.governance,
      }),
    });
    await graph.invoke(start(), CFG);
    await sleep(100);
    const [x = ''] = h.approvals();
    await h.approve(x);
    // Policy changed: on the re-run, c1's call is allowed.
    const digest = await argDigest({ to: 'a@b.c' });
    h.intercept = (request, body) => {
      const sent = body as { action?: { tool_ref?: string } } | undefined;
      if (
        new URL(request.url).pathname === '/v1/decisions' &&
        sent?.action?.tool_ref === TOOL_REFS.send_email
      ) {
        return Response.json({
          data: { decision: 'allow', action_digest: digest, enforced: true },
          meta: { request_id: 'r', deployment: 'hosted' },
        });
      }
      return undefined;
    };
    await resumeApproval(graph, x, { governance: h.governance });
    const state = await graph.getState(CFG);
    const pendingOn = state.tasks.flatMap((t) =>
      t.interrupts.map(
        (i) => (i.value as { approval_id?: string; tool_call_id?: string }).tool_call_id
      )
    );
    expect(pendingOn).toEqual(['c2']);
    const own = state.tasks[0]?.interrupts[0]?.value as { approval_id: string };
    expect(h.mock.state.obligations.get(own.approval_id)?.state).toBe('pending');
    expect(h.mock.state.obligations.get(own.approval_id)?.toolRef).toBe(TOOL_REFS.send_sms);
    expect(counters.runs).toHaveLength(0);
    expect(h.seen('POST', /\/consume$/)).toHaveLength(0);
  });
});
