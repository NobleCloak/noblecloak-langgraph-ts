/**
 * A tool the deployment executes through the governed MCP gateway, declared with `gatewayTools`.
 *
 * Three things are the builder's here, and the adapter does none of them:
 *  - the tool's function is the gateway call (an MCP client; here one `fetch`);
 *  - the gateway has its own token, minted for `MCP_SP_AUDIENCE` with the same client credentials, and
 *    never the token `govern` uses for `/v1`;
 *  - the call names the external run, so the gateway can match it to the approval: the adapter hands the
 *    function the run through `gatewayCallContext(config)`, and the function sends the header form.
 *
 * `fakeGateway` stands in for the gateway: it admits a call only when it names the run and carries the
 * arguments that were approved, and only once.
 */
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { END, MemorySaver, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import { argDigest } from '@noblecloak/client';
import type { JsonValue } from '@noblecloak/client';
import { gatewayCallContext, governedToolNode } from '@noblecloak/langgraph';
import type { Governance } from '@noblecloak/langgraph';
import type { Mock } from '@noblecloak/spec';
import { z } from 'zod';

/** The catalog name the deployment already proxies: a call to it is executed by the gateway, not by this process. */
export const GATEWAY_TOOL_REF = 'mcp:tracker:create_issue';

export const GATEWAY_URL = 'https://gateway.example.test/mcp';

/** The token the gateway accepts: minted for the gateway's audience, not the one `/v1` accepts. */
export const GATEWAY_TOKEN = 'gateway-token-for-MCP_SP_AUDIENCE';

export interface GatewayClient {
  readonly fetch: typeof globalThis.fetch;
  readonly getToken: () => string | Promise<string>;
}

/** The tool: its function calls the gateway, naming the run the adapter decided under. */
export function makeGatewayTool(gateway: GatewayClient) {
  return tool(
    async ({ title }: { title: string }, config) => {
      const { header } = gatewayCallContext(config);
      const response = await gateway.fetch(GATEWAY_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await gateway.getToken()}`,
          'content-type': 'application/json',
          // One form only: the header. Sending `_meta` as well would be a refusal if the two differed.
          ...header,
        },
        body: JSON.stringify({ tool_ref: GATEWAY_TOOL_REF, arguments: { title } }),
      });
      const body = (await response.json()) as { result?: string; error?: string };
      // The gateway's refusal is the tool's own error: the model is told, and nothing is decided again.
      if (!response.ok) throw new Error(`the gateway refused the call: ${body.error ?? 'unknown'}`);
      return body.result ?? '';
    },
    {
      name: 'create_issue',
      description: 'Create an issue (executed by the gateway).',
      schema: z.object({ title: z.string() }),
    }
  );
}

export interface GatewayCall {
  readonly runId: string | null;
  readonly digest: string;
  readonly admitted: boolean;
}

/**
 * The gateway, in process. It is laxer than the hosted one. The hosted selector requires the run id
 * to be a UUID (hosted `/v1/runs` ids are) and refuses a header and `_meta` that disagree; this
 * fake checks no UUID, so the mock's `run_xxxxxxxx` ids pass here and would be refused by the real
 * selector, and it reads only headers. It reads the run from the `X-NobleCloak-External-Run-Id`
 * header (trimmed and lower-cased, a blank value counts as absent; the pre-NobleCloak name is not
 * read, as in the hosted gateway), finds the approval of that run for this tool and these
 * arguments, and spends it: a second call with the same approval is refused. It uses the mock's
 * approvals as its record of what was approved.
 */
export function fakeGateway(mock: Mock): { fetch: typeof globalThis.fetch; calls: GatewayCall[] } {
  const calls: GatewayCall[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const refuse = (status: number, error: string): Response =>
      Response.json({ error }, { status });
    if (request.headers.get('authorization') !== `Bearer ${GATEWAY_TOKEN}`) {
      return refuse(401, 'bad_token');
    }
    const body = (await request.json()) as { tool_ref: string; arguments: Record<string, unknown> };
    const digest = await argDigest(body.arguments as JsonValue);
    // As in the hosted gateway, the value is trimmed and lower-cased and a blank one counts as absent.
    const header = request.headers.get('x-noblecloak-external-run-id')?.trim().toLowerCase() ?? '';
    const runId = header === '' ? null : header;
    const record = (admitted: boolean): void => {
      calls.push({ runId, digest, admitted });
    };
    if (runId === null) {
      record(false);
      return refuse(403, 'external_run_required');
    }
    const obligation = [...mock.state.obligations.values()].find(
      (o) => o.runId === runId && o.toolRef === body.tool_ref && o.argDigest === digest
    );
    if (obligation === undefined) {
      record(false);
      return refuse(403, 'no_matching_obligation');
    }
    if (obligation.state === 'consumed') {
      record(false);
      return refuse(409, 'obligation_already_consumed');
    }
    if (obligation.state !== 'approved') {
      record(false);
      return refuse(403, 'approval_required');
    }
    obligation.state = 'consumed';
    record(true);
    return Response.json({ result: `Issue "${String(body.arguments.title)}" created.` });
  };
  return { fetch: fetchImpl, calls };
}

export const GATEWAY_THREAD_ID = 'gateway-thread';

/** An agent whose one tool is executed by the gateway. In-process: the pause lives in a `MemorySaver`. */
export function buildGatewayAgent(options: {
  readonly governance: Governance;
  readonly gateway: GatewayClient;
}) {
  const tools = governedToolNode([makeGatewayTool(options.gateway)], {
    toolRefs: { create_issue: GATEWAY_TOOL_REF },
    governance: options.governance,
    gatewayTools: ['create_issue'],
  });
  const script: readonly AIMessage[] = [
    new AIMessage({
      content: '',
      tool_calls: [
        { id: 'call_1', name: 'create_issue', args: { title: 'Order A-7' }, type: 'tool_call' },
      ],
    }),
    new AIMessage('The issue has been created.'),
  ];
  return new StateGraph(MessagesAnnotation)
    .addNode('agent', (state) => {
      const turn = state.messages.filter((m: BaseMessage) => AIMessage.isInstance(m)).length;
      return { messages: [script[turn] ?? new AIMessage('Done.')] };
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
    .compile({ checkpointer: new MemorySaver() });
}

/** Starts the gateway agent on its thread; resolves to the approval it paused on. */
export async function runGatewayAgent(
  graph: ReturnType<typeof buildGatewayAgent>
): Promise<string | undefined> {
  const result = (await graph.invoke(
    { messages: [new HumanMessage('File an issue for order A-7.')] },
    { configurable: { thread_id: GATEWAY_THREAD_ID } }
  )) as { __interrupt__?: { value: { approval_id?: string } }[] };
  return result.__interrupt__?.[0]?.value.approval_id;
}
