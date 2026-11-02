/** What the demo does to the deployment itself: registers the refund tool, and plays the approver. */

export interface Deployment {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
}

async function call(
  deployment: Deployment,
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  const send = deployment.fetch ?? fetch;
  return send(`${deployment.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** The per-tool setting that shows the call's arguments to approvers (contract rev 5). Named once. */
export const SHOW_ARGUMENTS_FIELD = 'show_arguments_to_approvers';

/**
 * Puts `issue_refund` in the catalog: an external tool whose policy is "ask", registered with the setting
 * that shows the call's arguments to approvers on the single read, so the approver sees what they approve.
 */
export async function registerRefundTool(deployment: Deployment, token: string): Promise<void> {
  const response = await call(deployment, token, 'POST', '/v1/tools', {
    tool_ref: 'ext:billing:issue_refund',
    transport: 'external',
    description: 'Refund an order.',
    side_effect_level: 'external',
    input_schema: { type: 'object' },
    owner_kind: 'org',
    [SHOW_ARGUMENTS_FIELD]: true,
  });
  // 400 when a previous run registered it already.
  if (!response.ok && response.status !== 400) {
    throw new Error(`registering the tool answered ${String(response.status)}`);
  }
}

interface Pending {
  readonly id: string;
  readonly action_digest: string;
  readonly tool_ref: string;
}

/**
 * The approver: a person in the inbox, here a script. Approves every pending approval it can see and
 * returns their ids. The approver is a user principal; the agent's service principal can never approve.
 */
export async function approvePending(
  deployment: Deployment,
  approverToken: string
): Promise<string[]> {
  const listed = await call(
    deployment,
    approverToken,
    'GET',
    '/v1/approvals?state=pending&approver=me'
  );
  if (!listed.ok) throw new Error(`listing approvals answered ${String(listed.status)}`);
  const pending = ((await listed.json()) as { data: Pending[] }).data;
  const approved: string[] = [];
  for (const approval of pending) {
    const answer = await call(
      deployment,
      approverToken,
      'POST',
      `/v1/approvals/${approval.id}/approve`,
      {
        expected_action_digest: approval.action_digest,
      }
    );
    if (!answer.ok) throw new Error(`approving ${approval.id} answered ${String(answer.status)}`);
    approved.push(approval.id);
  }
  return approved;
}

/** The approver says no to every pending approval it can see, with a reason; returns their ids. */
export async function denyPending(
  deployment: Deployment,
  approverToken: string,
  reason = 'Not approved.'
): Promise<string[]> {
  const listed = await call(
    deployment,
    approverToken,
    'GET',
    '/v1/approvals?state=pending&approver=me'
  );
  if (!listed.ok) throw new Error(`listing approvals answered ${String(listed.status)}`);
  const pending = ((await listed.json()) as { data: Pending[] }).data;
  const denied: string[] = [];
  for (const approval of pending) {
    const answer = await call(
      deployment,
      approverToken,
      'POST',
      `/v1/approvals/${approval.id}/resolve`,
      { resolution: 'rejected', expected_action_digest: approval.action_digest, reason }
    );
    if (!answer.ok) throw new Error(`denying ${approval.id} answered ${String(answer.status)}`);
    denied.push(approval.id);
  }
  return denied;
}
