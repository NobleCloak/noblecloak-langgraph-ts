/**
 * A thread paused by hand: an obligation opened through the API and a graph whose `tools` node
 * interrupts on it. It lets a test make the checkpoint and the approval disagree, which the adapter's
 * own `governed` never does.
 */
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import {
  END,
  interrupt,
  MemorySaver,
  MessagesAnnotation,
  START,
  StateGraph,
} from '@langchain/langgraph';

import type { Harness } from './harness.js';

export interface ManualPause {
  readonly graph: ReturnType<typeof compile>;
  readonly approvalId: string;
  readonly threadId: string;
  readonly config: { configurable: { thread_id: string } };
  /** What the `tools` node returned after it was resumed. */
  readonly resumed: unknown[];
}

function compile(
  approvalId: string,
  toolRef: string,
  checkpointArgs: Record<string, unknown>,
  resumed: unknown[],
  saver: MemorySaver
) {
  return new StateGraph(MessagesAnnotation)
    .addNode('agent', () => ({
      messages: [
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'c1', name: 'send_email', args: checkpointArgs, type: 'tool_call' }],
        }),
      ],
    }))
    .addNode('tools', () => {
      const value: unknown = interrupt({
        approval_id: approvalId,
        tool_ref: toolRef,
        tool_call_id: 'c1',
        summary: 'by hand',
      });
      resumed.push(value);
      return { messages: [] };
    })
    .addEdge(START, 'agent')
    .addEdge('agent', 'tools')
    .addEdge('tools', END)
    .compile({ checkpointer: saver });
}

export async function manualPause(
  h: Harness,
  options: {
    readonly threadId?: string;
    readonly checkpointArgs?: Record<string, unknown>;
    readonly approvedArgs?: Record<string, unknown>;
    readonly continuation?: Record<string, unknown>;
    /** Open the obligation in this run's scope instead of the principal's. */
    readonly runId?: string;
    /** Pause the graph (default true). False leaves the thread without a checkpoint. */
    readonly pause?: boolean;
  } = {}
): Promise<ManualPause> {
  const threadId = options.threadId ?? 'manual-thread';
  const decided = await h.as(h.tokens.creator, 'POST', '/v1/decisions', {
    ...(options.runId === undefined ? {} : { actor: { run_id: options.runId } }),
    action: {
      tool_ref: 'ext:local:send_email',
      arguments: options.approvedArgs ?? { to: 'a@b.c' },
    },
    continuation: {
      kind: 'langgraph',
      delivery: 'pull',
      correlation: { thread_id: threadId, checkpoint_ns: 'tools:manual', tool_call_id: 'c1' },
      ...options.continuation,
    },
  });
  const approvalId = ((await decided.json()) as { data: { approval: { id: string } } }).data
    .approval.id;
  const resumed: unknown[] = [];
  const graph = compile(
    approvalId,
    'ext:local:send_email',
    options.checkpointArgs ?? { to: 'a@b.c' },
    resumed,
    new MemorySaver()
  );
  const config = { configurable: { thread_id: threadId } };
  if (options.pause !== false) await graph.invoke({ messages: [new HumanMessage('go')] }, config);
  return { graph, approvalId, threadId, config, resumed };
}
