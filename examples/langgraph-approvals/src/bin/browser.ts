/**
 * `bun run start:browser`: the mock on 127.0.0.1:8787 and an agent paused on a refund, for the example app
 * at http://localhost:3000 to approve. `NC_DECISION=deny` expects a Deny instead. Exits 0 only when the
 * outcome matches the decision.
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { browserDemoSucceeded, parseDecision, runBrowserDemo } from '../browser.js';
import { say } from '../log.js';

const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stop.abort();
  });
}

const decision = parseDecision(process.env.NC_DECISION);
try {
  const result = await runBrowserDemo({
    binDir: dirname(fileURLToPath(import.meta.url)),
    decision,
    mockPort: Number(process.env.NC_MOCK_PORT ?? '8787'),
    appOrigin: process.env.NC_APP_ORIGIN ?? 'http://localhost:3000',
    signal: stop.signal,
    onLine: (name, line) => {
      console.log(`[${name}] ${line}`);
    },
    onReady: ({ baseUrl, approvalsUrl, approvalId }) => {
      say('browser_ready', { api: baseUrl, open: approvalsUrl, approval_id: approvalId });
    },
  });
  say('browser_done', { ...result });
  process.exit(browserDemoSucceeded(result) ? 0 : 1);
} catch (error) {
  say('browser_failed', { message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}
