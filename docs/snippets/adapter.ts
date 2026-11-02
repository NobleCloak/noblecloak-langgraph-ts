import { tool } from '@langchain/core/tools';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { createAgent } from 'langchain';
import { z } from 'zod';
import { createGovernance, runResumer } from '@noblecloak/langgraph';
import { governanceMiddleware } from '@noblecloak/langgraph/middleware';

import { baseUrl, token } from './connect.js';

// The agent and its worker authenticate as the same service principal.
const governance = createGovernance({ baseUrl, getToken: () => token('creator') });

const sendEmail = tool(
  ({ to, subject }: { to: string; subject: string }) => `sent "${subject}" to ${to}`,
  {
    name: 'send_email',
    description: 'Send an email.',
    schema: z.object({ to: z.string(), subject: z.string() }),
  }
);

export function buildAgent(model: BaseChatModel) {
  return createAgent({
    model,
    tools: [sendEmail],
    // Governance goes last, so retry and similar middleware wrap it rather than the tool.
    middleware: [
      governanceMiddleware(governance, { toolRefs: { send_email: 'ext:local:send_email' } }),
    ],
    // A persistent checkpointer: the paused run has to survive a restart.
    checkpointer: SqliteSaver.fromConnString('checkpoints.db'),
  });
}

type Agent = ReturnType<typeof buildAgent>;

/** One thread_id per conversation. A call that needs approval pauses the run here. */
export function ask(agent: Agent, threadId: string, text: string) {
  return agent.invoke(
    { messages: [{ role: 'user', content: text }] },
    { configurable: { thread_id: threadId } }
  );
}

/** The worker: its own process, built from the same agent and checkpoint file. */
export function startWorker(agent: Agent) {
  return runResumer(agent, {
    governance,
    onError: (error) => {
      console.error(error.code);
    },
  });
}
