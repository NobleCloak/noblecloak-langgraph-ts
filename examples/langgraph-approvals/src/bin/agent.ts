/** The agent process: runs the thread until it pauses for an approval, then exits. The run lives in the checkpoint file. */
import { createGovernance } from '@noblecloak/langgraph';

import { runAgent } from '../agent.js';
import { creatorGetToken } from '../creator-token.js';
import { env, say } from '../log.js';

const governance = createGovernance({
  baseUrl: env('NC_BASE_URL'),
  getToken: await creatorGetToken(),
});
const middleware = process.env.NC_MIDDLEWARE === '1';
const outcome = await runAgent({
  governance,
  checkpointFile: env('NC_CHECKPOINTS'),
  refundLog: env('NC_REFUND_LOG'),
  middleware,
});
say(outcome.finished ? 'agent_finished' : 'agent_paused', {
  entry: middleware ? 'middleware' : 'graph',
  ...(outcome.approvalId === undefined ? {} : { approval_id: outcome.approvalId }),
});
