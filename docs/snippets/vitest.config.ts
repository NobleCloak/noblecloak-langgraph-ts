import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      include: ['*.ts'],
      // `adapter.ts` builds an agent and starts a worker, and `connect.ts` reads the mock's tokens when it is
      // imported: each needs a running process, so they are typechecked here and shown in the guide, and
      // examples/langgraph-approvals exercises the adapter.
      exclude: ['*.test.ts', 'vitest.config.ts', 'adapter.ts', 'connect.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
