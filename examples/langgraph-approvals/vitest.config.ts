import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // The end-to-end test starts separate node processes from the built entry points.
    globalSetup: ['./test/build.ts'],
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/bin/agent.ts',
        'src/bin/worker.ts',
        'src/bin/approve.ts',
        'src/bin/demo.ts',
        'src/bin/browser.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
