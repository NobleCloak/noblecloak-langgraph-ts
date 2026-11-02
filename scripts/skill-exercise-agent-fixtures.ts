/**
 * The files of the langgraph skill's acceptance run that stand in for a person's project and for the model's
 * steps (`skills/langgraph/SKILL.md`, steps 2 to 6): the project the skill is applied to, the files the
 * model writes (the wrapped agent, the plan) and one test-only entry that runs the agent. Strings, not source
 * files, because they import packages that only the scaffolded project installs.
 */

/** Pinned as `examples/langgraph-approvals/package.json` pins them (a test checks the two agree). */
export const PINNED_DEPENDENCIES: Readonly<Record<string, string>> = {
  '@langchain/core': '1.3.0',
  '@langchain/langgraph': '1.5.2',
  '@langchain/langgraph-checkpoint-sqlite': '1.1.0',
  langchain: '1.5.19',
  zod: '4.6.7',
};

/** The project's own dev tooling: a TypeScript runner for the entries and the compiler for the type check. */
export const PINNED_DEV_DEPENDENCIES: Readonly<Record<string, string>> = {
  '@types/node': '24.19.2',
  tsx: '4.20.6',
  typescript: '6.0.3',
};

/** The scaffolded project's package name: it becomes the `<package-name>` of the `ext:` references. */
export const PROJECT_NAME = 'billing';

export function projectManifest(): Record<string, unknown> {
  return {
    name: PROJECT_NAME,
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies: { ...PINNED_DEPENDENCIES },
    devDependencies: { ...PINNED_DEV_DEPENDENCIES },
  };
}

export const PROJECT_TSCONFIG = `{
  "compilerOptions": {
    "target": "es2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src"]
}
`;

/** The person's agent before the skill: two tools (a read and an external refund) and a scripted model. */
export const USER_AGENT_TS = `import { appendFileSync } from 'node:fs';

import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

export const searchTickets = tool(
  ({ query }: { query: string }) => \`Ticket T-1001 matches "\${query}": order A-7 arrived damaged.\`,
  {
    name: 'search_tickets',
    description: 'Search support tickets.',
    schema: z.object({ query: z.string() }),
  }
);

export const issueRefund = tool(
  ({ order_id, amount_cents }: { order_id: string; amount_cents: number }) => {
    // The only effect: one line in a file, so a refund that happens twice is visible.
    appendFileSync(process.env.NC_REFUND_LOG ?? 'refunds.log', \`\${JSON.stringify({ order_id, amount_cents })}\\n\`);
    return \`Refunded \${String(amount_cents / 100)} on \${order_id}.\`;
  },
  {
    name: 'issue_refund',
    description: 'Refund an order.',
    schema: z.object({ order_id: z.string(), amount_cents: z.number().int().positive() }),
  }
);

const SCRIPT: readonly AIMessage[] = [
  new AIMessage({
    content: '',
    tool_calls: [
      {
        id: 'call_1',
        name: 'issue_refund',
        args: { order_id: 'A-7', amount_cents: 2500 },
        type: 'tool_call',
      },
    ],
  }),
  new AIMessage('The refund for order A-7 has been issued.'),
];

/** A model that plays a script, so the project needs no credentials. */
class ScriptedModel extends BaseChatModel {
  _llmType(): string {
    return 'scripted';
  }

  override bindTools(): this {
    return this;
  }

  _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const turn = messages.filter((m) => AIMessage.isInstance(m)).length;
    const message = SCRIPT[turn] ?? new AIMessage('Done.');
    return Promise.resolve({
      generations: [{ text: typeof message.content === 'string' ? message.content : '', message }],
    });
  }
}

export const model = new ScriptedModel({});
`;

/** What the model writes at step 4: the references and the wrapped agent, with the middleware last. */
export const GOVERNED_AGENT_TS = `import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { createAgent } from 'langchain';
import type { Governance } from '@noblecloak/langgraph';
import { governanceMiddleware } from '@noblecloak/langgraph/middleware';

import { issueRefund, model, searchTickets } from '../agent.js';

export const TOOL_REFS = {
  search_tickets: 'mcp:tracker:search',
  issue_refund: 'ext:billing:issue_refund',
} as const;

export function buildGovernedAgent(governance: Governance) {
  return createAgent({
    model,
    tools: [searchTickets, issueRefund],
    middleware: [governanceMiddleware(governance, { toolRefs: TOOL_REFS })],
    checkpointer: SqliteSaver.fromConnString(process.env.NC_CHECKPOINTS ?? 'checkpoints.sqlite'),
  });
}
`;

/** The test-only entry that stands for the person's own way of starting the agent. */
export const RUN_AGENT_TS = `import { HumanMessage } from '@langchain/core/messages';

import { agentGovernance } from './noblecloak/governance.js';
import { buildGovernedAgent } from './noblecloak/governed-agent.js';
import { say } from './noblecloak/log.js';

const graph = buildGovernedAgent(await agentGovernance());
const result = (await graph.invoke(
  { messages: [new HumanMessage('Customer says order A-7 arrived damaged. Sort it out.')] },
  { configurable: { thread_id: 'refund-thread' } }
)) as { __interrupt__?: { value: { approval_id?: string } }[] };
const approvalId = result.__interrupt__?.[0]?.value.approval_id;
say(approvalId === undefined ? 'agent_finished' : 'agent_paused', {
  ...(approvalId === undefined ? {} : { approval_id: approvalId }),
});
`;

const ASSESSMENT_READ = {
  side_effect_level: 'read',
  blast_radius: 'many_records',
  reversible: true,
  external_party: false,
  financial: false,
} as const;

const ASSESSMENT_REFUND = {
  side_effect_level: 'external',
  blast_radius: 'one_record',
  reversible: false,
  external_party: true,
  financial: true,
} as const;

/** The id of the service principal the mock's `creator` token belongs to (it is the token the stub endpoint issues). */
export const MOCK_SERVICE_PRINCIPAL_ID = 'svc_adapter';

/**
 * The plan the model would draft at step 6, written by hand: one registered tool (the refund, which asks for
 * every caller), one MCP tool the catalog already has (reads are allowed for everyone) and a tightening that
 * makes this agent ask before it searches, because it reads many tickets where a person reads one.
 */
export const FIXTURE_PLAN = {
  agent: { principal_id: MOCK_SERVICE_PRINCIPAL_ID },
  tools: [
    {
      tool_ref: 'ext:billing:issue_refund',
      description: 'Refund an order.',
      input_schema: { type: 'object' },
      side_effect_level: 'external',
      show_arguments_to_approvers: true,
    },
  ],
  policies: [
    {
      role: 'baseline',
      tool: 'mcp:tracker:search',
      mode: 'always_allow',
      rationale: 'Searches support tickets and changes nothing, so anyone may run it.',
      assessment: { ...ASSESSMENT_READ, blast_radius: 'one_record' },
    },
    {
      role: 'baseline',
      tool: 'ext:billing:issue_refund',
      mode: 'ask',
      rationale:
        'Issues a refund to a customer: money leaves the organisation and cannot be recalled, so a person approves each one.',
      assessment: ASSESSMENT_REFUND,
    },
    {
      role: 'tightening',
      tool: 'mcp:tracker:search',
      mode: 'ask',
      rationale:
        'This agent searches many tickets automatically where a person reads one at a time, so a person approves its searches.',
      assessment: ASSESSMENT_READ,
    },
  ],
} as const;
