import { defineConfig } from 'tsup';

// Five entry points: the four processes of the demo, and the browser mode's wrapper. Dependencies stay external: node resolves them from node_modules.
export default defineConfig({
  entry: {
    'bin/agent': 'src/bin/agent.ts',
    'bin/worker': 'src/bin/worker.ts',
    'bin/approve': 'src/bin/approve.ts',
    'bin/demo': 'src/bin/demo.ts',
    'bin/browser': 'src/bin/browser.ts',
  },
  format: ['esm'],
  platform: 'node',
  dts: false,
  sourcemap: true,
  clean: true,
  target: 'es2022',
});
