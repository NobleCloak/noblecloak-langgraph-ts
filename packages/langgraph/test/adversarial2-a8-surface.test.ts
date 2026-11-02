/** A8: the published surface of `Governance` is the documented API; the coordination between calls is internal. */
import { describe, expect, it } from 'vitest';

import * as entry from '../src/index.js';
import { coordinationOf, Governance } from '../src/governance.js';
import { createHarness } from './harness.js';

const INTERNAL = ['claimResume', 'releaseResume', 'markDispatched', 'wasDispatched', 'enterTask'];

describe('A8: the coordination methods are not on the published class', () => {
  it('Governance has none of them, on the prototype or on an instance', async () => {
    const h = await createHarness();
    for (const name of INTERNAL) {
      expect(Object.getOwnPropertyNames(Governance.prototype)).not.toContain(name);
      expect(name in h.governance).toBe(false);
    }
  });

  it('they live on an object only the package modules can reach, and it is not exported from the entry point', async () => {
    const h = await createHarness();
    const coordination = coordinationOf(h.governance) as unknown as Record<string, unknown>;
    for (const name of INTERNAL) expect(typeof coordination[name]).toBe('function');
    expect(Object.keys(entry)).not.toContain('coordinationOf');
    expect(Object.keys(entry)).not.toContain('Coordination');
  });

  it('coordinationOf refuses a thing that is not a Governance', () => {
    expect(() => coordinationOf({} as never)).toThrow(/createGovernance/);
  });
});
