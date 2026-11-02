import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runDemo } from '../src/demo.js';

describe('the example, as separate processes', () => {
  it('reports a process that fails, and stops what it started', async () => {
    await expect(
      runDemo({ binDir: join(import.meta.dirname, 'no-such-directory') })
    ).rejects.toThrow('the agent failed');
  });

  it.each([
    ['governedToolNode', {}],
    ['createAgent with governanceMiddleware', { middleware: true }],
  ])(
    '%s: the mock, the agent, the worker and the approver each run in a process of their own: the refund happens once',
    async (_name, variant) => {
      const lines: string[] = [];
      const result = await runDemo({
        ...variant,
        binDir: join(import.meta.dirname, '../dist/bin'),
        onLine: (name, line) => lines.push(`[${name}] ${line}`),
      });
      expect(result.refunds, lines.join('\n')).toBe(1);
      expect(result.approvalState).toBe('consumed');
      // Both processes built the agent the way the variant says.
      const entry = 'middleware' in variant ? 'middleware' : 'graph';
      expect(lines.filter((l) => l.includes(`"entry":"${entry}"`))).toHaveLength(2);
      expect(result.events.map((e) => `${e.process}:${e.event}`)).toEqual(
        expect.arrayContaining([
          'agent:agent_paused',
          'worker:worker_ready',
          'approver:approved',
          'worker:worker_resumed',
        ])
      );
      // The agent exited before the worker started: the paused run lived in the checkpoint file.
      const order = lines.map((l) => l.slice(0, l.indexOf(']') + 1));
      expect(order.indexOf('[agent]')).toBeLessThan(order.indexOf('[worker]'));
    }
  );
});
