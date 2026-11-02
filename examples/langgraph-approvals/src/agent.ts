/**
 * The agent: a graph with a scripted model (no credentials) and governed tools. Two builds of the same
 * agent: `createAgent` with `governanceMiddleware` (the quickstart), or a hand-built graph with
 * `governedToolNode`.
 */
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { END, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { createAgent } from 'langchain';
import { governedToolNode } from '@noblecloak/langgraph';
import { governanceMiddleware } from '@noblecloak/langgraph/middleware';
import type { Governance } from '@noblecloak/langgraph';

import { ScriptedModel } from './model.js';
import { TOOL_REFS, makeTools } from './tools.js';

/** The thread the agent runs on. The worker needs no more than the checkpoint file to find it. */
export const THREAD_ID = 'refund-thread';

/** What the model says, turn by turn: look the ticket up, ask for the refund, report. */
const SCRIPT: readonly AIMessage[] = [
  new AIMessage({
    content: '',
    tool_calls: [
      { id: 'call_1', name: 'search_tickets', args: { query: 'damaged' }, type: 'tool_call' },
    ],
  }),
  new AIMessage({
    content: '',
    tool_calls: [
      {
        id: 'call_2',
        name: 'issue_refund',
        args: { order_id: 'A-7', amount_cents: 2500 },
        type: 'tool_call',
      },
    ],
  }),
  new AIMessage('The refund for order A-7 has been issued.'),
];

export interface AgentOptions {
  readonly governance: Governance;
  /** The SQLite file holding the paused run. The agent and the worker open the same file. */
  readonly checkpointFile: string;
  /** The file the refund tool appends to. */
  readonly refundLog: string;
  /** Build the agent with `createAgent` and `governanceMiddleware` instead of a hand-built graph. */
  readonly middleware?: boolean;
}

/** Builds the graph. The agent process and the worker process each build their own from the same options. */
export function buildAgent(options: AgentOptions) {
  const { searchTickets, issueRefund } = makeTools(options.refundLog);
  if (options.middleware === true) {
    return createAgent({
      model: new ScriptedModel(SCRIPT),
      tools: [searchTickets, issueRefund],
      middleware: [governanceMiddleware(options.governance, { toolRefs: TOOL_REFS })],
      checkpointer: SqliteSaver.fromConnString(options.checkpointFile),
    });
  }
  const tools = governedToolNode([searchTickets, issueRefund], {
    toolRefs: TOOL_REFS,
    governance: options.governance,
  });
  return new StateGraph(MessagesAnnotation)
    .addNode('agent', (state) => {
      // The model reads the thread, so a re-run or a second process says the same thing.
      const turn = state.messages.filter((m: BaseMessage) => AIMessage.isInstance(m)).length;
      return { messages: [SCRIPT[turn] ?? new AIMessage('Done.')] };
    })
    .addNode('tools', tools)
    .addEdge(START, 'agent')
    .addConditionalEdges(
      'agent',
      (state) => {
        const last = state.messages.at(-1);
        return last !== undefined &&
          AIMessage.isInstance(last) &&
          (last.tool_calls?.length ?? 0) > 0
          ? 'tools'
          : END;
      },
      ['tools', END]
    )
    .addEdge('tools', 'agent')
    .compile({ checkpointer: SqliteSaver.fromConnString(options.checkpointFile) });
}

/** Starts the agent on its thread. Resolves to the approval it paused on, or undefined when it finished. */
export async function runAgent(
  options: AgentOptions
): Promise<{ approvalId?: string; finished: boolean }> {
  const graph = buildAgent(options);
  const result = (await graph.invoke(
    { messages: [new HumanMessage('Customer says order A-7 arrived damaged. Sort it out.')] },
    { configurable: { thread_id: THREAD_ID } }
  )) as { __interrupt__?: { value: { approval_id?: string } }[] };
  const approvalId = result.__interrupt__?.[0]?.value.approval_id;
  return approvalId === undefined ? { finished: true } : { approvalId, finished: false };
}
