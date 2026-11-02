/**
 * The resumer worker: its own process, the same service principal as the agent and the same checkpoint
 * store. It watches for approvals the agent opened and resumes the paused thread once a person approves.
 * Run it for as long as the agent runs (`node --import tsx src/noblecloak/worker.ts`, or the build of it).
 * Nothing here awaits at the top level, so the file runs the same in a package with or without
 * `"type": "module"`.
 */
import { GovernanceError, runResumer } from '@noblecloak/langgraph';

import { agentGovernance } from './governance.js';
import { buildGovernedAgent } from './governed-agent.js';
import { say } from './log.js';

/** Say why the worker stops and exit non-zero, so a supervisor restarts it. */
function fatal(error: unknown): never {
  say('worker_fatal', {
    code: error instanceof GovernanceError ? error.code : undefined,
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
}

async function main(): Promise<void> {
  const governance = await agentGovernance();
  const graph = await buildGovernedAgent(governance);
  const worker = await runResumer(graph, {
    governance,
    onResumed: (approvalId, outcome) => {
      say('worker_resumed', { approval_id: approvalId, status: outcome.status });
    },
    onError: (error, approvalId) => {
      say('worker_error', { code: error.code, message: error.message, approval_id: approvalId });
    },
    // The worker stops itself when an approval it lists as its own cannot be read back (`not_owner`: the
    // Resumption answered 403).
    onFatal: fatal,
  });
  say('worker_ready');
  process.once('SIGTERM', () => {
    void worker.stop().then(() => process.exit(0));
  });
}

// A failure while starting (a missing variable, `principal_mismatch`, a rejected token) ends here.
main().catch(fatal);
