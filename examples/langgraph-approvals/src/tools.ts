/** Two tools that need no credentials and no service: a read, and a refund that only writes a line to a file. */
import { appendFileSync } from 'node:fs';

import { tool } from '@langchain/core/tools';
import { z } from 'zod';

/** What each tool is called in the NobleCloak catalog. The mock knows the first; the demo registers the second. */
export const TOOL_REFS = {
  search_tickets: 'mcp:tracker:search',
  issue_refund: 'ext:billing:issue_refund',
} as const;

export function makeTools(refundLog: string) {
  const searchTickets = tool(
    ({ query }: { query: string }) =>
      `Ticket T-1001 matches "${query}": order A-7 arrived damaged.`,
    {
      name: 'search_tickets',
      description: 'Search support tickets.',
      schema: z.object({ query: z.string() }),
    }
  );
  const issueRefund = tool(
    ({ order_id, amount_cents }: { order_id: string; amount_cents: number }) => {
      // The only effect: one line in a file, so a run that happens twice is visible.
      appendFileSync(refundLog, `${JSON.stringify({ order_id, amount_cents })}\n`);
      return `Refunded ${String(amount_cents / 100)} on ${order_id}.`;
    },
    {
      name: 'issue_refund',
      description: 'Refund an order.',
      schema: z.object({ order_id: z.string(), amount_cents: z.number().int().positive() }),
    }
  );
  return { searchTickets, issueRefund };
}
