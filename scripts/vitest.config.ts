import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      include: ['*.ts'],
      // `skill-exercise-agent.ts` is the langgraph skill's acceptance run itself: it packs, installs and starts
      // processes, so `bun run exercise:skill` is its test. The parts it is made of are in
      // `skill-exercise-agent-support.ts` and `skill-exercise-common.ts`, which `skill-langgraph.test.ts` covers.
      exclude: ['*.test.ts', 'vitest.config.ts', 'skill-exercise-agent.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
