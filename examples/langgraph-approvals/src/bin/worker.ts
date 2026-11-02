/**
 * The resumer worker: its own process, the same service principal as the agent (only the principal that
 * created an approval can read its Resumption), the same checkpoint file.
 */
import { createGovernance, runResumer } from '@noblecloak/langgraph';

import { buildAgent } from '../agent.js';
import { creatorGetToken } from '../creator-token.js';
import { env, say } from '../log.js';

const governance = createGovernance({
  baseUrl: env('NC_BASE_URL'),
  getToken: await creatorGetToken(),
});
const middleware = process.env.NC_MIDDLEWARE === '1';
const graph = buildAgent({
  governance,
  checkpointFile: env('NC_CHECKPOINTS'),
  refundLog: env('NC_REFUND_LOG'),
  middleware,
});
const worker = await runResumer(graph, {
  governance,
  onResumed: (approvalId, outcome) => {
    say('worker_resumed', { approval_id: approvalId, status: outcome.status });
  },
  onError: (error, approvalId) => {
    say('worker_error', { code: error.code, message: error.message, approval_id: approvalId });
  },
});
say('worker_ready', { entry: middleware ? 'middleware' : 'graph' });
process.once('SIGTERM', () => {
  void worker.stop().then(() => process.exit(0));
});
