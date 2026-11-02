/** `bun run start` / `node dist/bin/demo.js [--middleware]`: runs the whole loop and says what happened. */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runDemo } from '../demo.js';

const result = await runDemo({
  middleware: process.argv.includes('--middleware'),
  binDir: dirname(fileURLToPath(import.meta.url)),
  onLine: (name, line) => {
    console.log(`[${name}] ${line}`);
  },
});
console.log(
  `refunds issued: ${String(result.refunds)}; approval state: ${String(result.approvalState)}`
);
process.exit(result.refunds === 1 && result.approvalState === 'consumed' ? 0 : 1);
