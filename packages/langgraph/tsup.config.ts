import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/middleware.ts'],
  format: ['esm'],
  // Declarations are emitted by `tsc -p tsconfig.build.json` (see the build script): tsup's
  // dts step injects `baseUrl`, which TypeScript 6 rejects as deprecated.
  dts: false,
  sourcemap: true,
  clean: true,
  target: 'es2022',
});
