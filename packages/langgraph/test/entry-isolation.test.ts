/** The main entry must not load `langchain`: it is an optional peer, needed only by `@noblecloak/langgraph/middleware`. */
import { describe, expect, it, vi } from 'vitest';

vi.mock('langchain', () => {
  throw new Error('langchain was loaded');
});

describe('entry points and the optional langchain peer', () => {
  it('the main entry loads with langchain unresolvable, and exports no middleware', async () => {
    const entry = await import('../src/index.js');
    expect(typeof entry.governed).toBe('function');
    expect(typeof entry.governedToolNode).toBe('function');
    expect(Object.keys(entry)).not.toContain('governanceMiddleware');
  });

  it('the middleware entry is the one that needs langchain', async () => {
    await expect(import('../src/middleware.js')).rejects.toThrow();
  });
});
