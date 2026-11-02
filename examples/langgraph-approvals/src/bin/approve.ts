/** The approver: the person in the inbox, as a script. Waits for a pending approval and approves it. */
import { approvePending } from '../deployment.js';
import { env, say } from '../log.js';

const deployment = { baseUrl: env('NC_BASE_URL') };
const token = env('NC_APPROVER_TOKEN');
const deadline = Date.now() + 30_000;
for (;;) {
  const approved = await approvePending(deployment, token);
  if (approved.length > 0) {
    say('approved', { approval_ids: approved });
    break;
  }
  if (Date.now() > deadline) throw new Error('no approval became pending');
  await new Promise((resolve) => setTimeout(resolve, 200));
}
