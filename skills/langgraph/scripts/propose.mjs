#!/usr/bin/env node
// Opens one approval, `tool:noblecloak:propose-policy-set`, for an agent: its tools, its binding to a service
// principal and the policies that govern it (contract rev 14, `PolicySetProposal`). Applying it is the deployment's
// job, when an administrator approves; this script registers nothing and publishes nothing itself. It only
// declares the agent (`POST /v1/agents`, with an `Idempotency-Key` that `agent.json` keeps until the id is written)
// when `src/noblecloak/agent.json` has no id yet.
//
//   node propose.mjs --plan <plan.json> [--project <dir>] [--base-url <origin>] [--dry-run]
//
// Plain Node (18 or later), no dependencies, and raw `fetch` instead of `@noblecloak/client`: it must run before
// anything is installed, and the client has no helper for these routes anyway (it is `openapi-fetch` over the
// whole contract), so importing it would buy no types the script uses.
//
// The plan file is smaller than the proposal. `agent` carries `principal_id` (the service principal's id as
// `GET /v1/principals` lists it); its `id` comes from `agent.json`, and a plan that names another is refused; `tools` are `POST /v1/tools`
// bodies (`owner_kind` defaults to `org`); each `policies` entry is `{ role, tool, mode, rationale, assessment }` plus an optional `name` and `description`.
// The script fills in the rest of each policy (kind, subject, target) and checks the built proposal against the
// rules of `PolicySetProposal` before it sends anything. The deployment checks them again. A real run then reads the
// policies already in force (`GET /v1/policies`, with the builder's token; read only) before it declares the agent or
// opens the approval, and refuses a baseline for a tool an `everyone` policy already governs (`baseline_exists`) and a
// tightening for a tool this agent already has a policy for (`policy_conflict`, which an approval would otherwise
// refuse later). A dry run sends nothing, so it does not read them.
//
// Environment: `NC_BASE_URL` (the module API's origin; `--base-url` wins), `NC_PROPOSER_TOKEN` (the builder's own
// user token; a service principal's or agent's token is refused, and the agent's credential is never read here),
// `NOBLECLOAK_APPROVALS_URL` (the approvals module's address, optional; printed with the approval id. The contract defines no
// per-approval route, so the script prints the address and the id and builds no deep link).
//
// Exit codes: 0 opened (or a dry run) · 2 refused or invalid input (a code is printed; includes a 409 `rejected_duplicate`
// or `continuation_conflict`, and the two refusals above) · 3 no usable user token
// (missing, not accepted, or not a user's: a service principal or agent token, or `not_a_user`) ·
// 1 anything else (network, 5xx, a deployment that does not apply proposals).
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

export const PROPOSE_REF = 'tool:noblecloak:propose-policy-set';
const REQUEST_TIMEOUT_MS = 15_000;

const SIDE_EFFECT_LEVELS = ['read', 'write', 'delete', 'external', 'admin'];
const BLAST_RADII = ['one_record', 'many_records', 'org_wide'];
/** The modes a proposed policy may carry, with their strictness: a tighter mode has a higher rank. */
const MODE_RANK = { always_allow: 0, ask: 1, escalate: 1, deny: 2 };
/** True for one of the modes above, and only those: `in` would accept `constructor` and `toString` too. */
const isMode = (value) => typeof value === 'string' && Object.hasOwn(MODE_RANK, value);
const ROLES = ['baseline', 'tightening'];
const MAX_ENTRIES = 50;

/** The refusal codes a deployment answers a proposal with (`PolicySetProposal`), all input the builder can fix. */
const REFUSAL_CODES = new Set([
  'shape',
  'unknown_agent',
  'principal_bound',
  'tool_ref_in_use',
  'target_unknown',
  'baseline_exists',
  'tightening_looser',
]);

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const nonEmpty = (value) => typeof value === 'string' && value.trim() !== '';

/** The members of `value` that are not in `allowed`, as `path.member` strings. */
function unknownMembers(value, allowed, path) {
  return Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => `${path}.${key} is not a member of this object`);
}

const PLAN_KEYS = ['agent', 'tools', 'policies'];
const PLAN_ENTRY_KEYS = ['role', 'tool', 'mode', 'rationale', 'assessment'];
// Optional on a plan entry: the policy's `name` (1 to 200 characters) and `description` (at most 2000), as the
// contract's `PolicyWrite` bounds them. Absent, the deployment names the policy itself.
const PLAN_ENTRY_OPTIONAL_KEYS = ['name', 'description'];
const NAME_MAX = 200;
const DESCRIPTION_MAX = 2000;
// Lengths count code points (`[...value].length`), as JSON Schema `maxLength` does, not UTF-16 units.
const textLength = (value) => [...value].length;
const addProblem = (problems, problem) => {
  if (problem !== undefined) problems.push(problem);
};
/** The problem with a policy `name` at `at`, or `undefined` when it is a string of 1 to NAME_MAX characters. */
const nameProblem = (value, at) => {
  if (typeof value !== 'string') return `${at} must be a string`;
  const length = textLength(value);
  return length >= 1 && length <= NAME_MAX
    ? undefined
    : `${at} must be 1 to ${NAME_MAX} characters`;
};
/** The problem with a policy `description` at `at`, or `undefined` when it is a string of at most DESCRIPTION_MAX characters. */
const descriptionProblem = (value, at) => {
  if (typeof value !== 'string') return `${at} must be a string`;
  return textLength(value) <= DESCRIPTION_MAX
    ? undefined
    : `${at} must be at most ${DESCRIPTION_MAX} characters`;
};
const TOOL_KEYS = [
  'tool_ref',
  'transport',
  'description',
  'input_schema',
  'side_effect_level',
  'owner_kind',
  'show_arguments_to_approvers',
];
const ASSESSMENT_KEYS = [
  'side_effect_level',
  'blast_radius',
  'reversible',
  'external_party',
  'financial',
];

/**
 * Builds the `PolicySetProposal` from a plan and the agent's id. Returns `{ proposal }`, or `{ problems }` naming
 * every member of the plan that cannot be built into one (the proposal's own rules are `validateProposal`'s).
 */
export function buildProposal(plan, agentId) {
  const problems = [];
  if (!isObject(plan)) return { problems: ['the plan must be a JSON object'] };
  problems.push(...unknownMembers(plan, PLAN_KEYS, 'plan'));
  const agent = isObject(plan.agent) ? plan.agent : {};
  if (plan.agent !== undefined && !isObject(plan.agent))
    problems.push('plan.agent must be an object');
  else problems.push(...unknownMembers(agent, ['id', 'principal_id'], 'plan.agent'));
  if (!nonEmpty(agent.principal_id))
    problems.push(
      'plan.agent.principal_id is required: the agent runs as its own service principal, and the proposal binds it'
    );
  if (agent.id !== undefined && agent.id !== agentId)
    problems.push(
      `plan.agent.id (${String(agent.id)}) is not the id in agent.json (${String(agentId)}): leave it out`
    );

  const tools = plan.tools ?? [];
  if (!Array.isArray(tools)) problems.push('plan.tools must be a list');
  const policies = plan.policies;
  if (!Array.isArray(policies)) problems.push('plan.policies must be a list');
  if (problems.length > 0 || !Array.isArray(tools) || !Array.isArray(policies)) return { problems };

  const builtTools = tools.map((tool, i) => {
    if (!isObject(tool)) {
      problems.push(`plan.tools[${i}] must be an object`);
      return tool;
    }
    problems.push(...unknownMembers(tool, TOOL_KEYS, `plan.tools[${i}]`));
    return { owner_kind: 'org', transport: 'external', ...tool };
  });
  const builtPolicies = policies.map((entry, i) => {
    const at = `plan.policies[${i}]`;
    if (!isObject(entry)) {
      problems.push(`${at} must be an object`);
      return entry;
    }
    problems.push(...unknownMembers(entry, [...PLAN_ENTRY_KEYS, ...PLAN_ENTRY_OPTIONAL_KEYS], at));
    for (const key of PLAN_ENTRY_KEYS)
      if (entry[key] === undefined) problems.push(`${at}.${key} is required`);
    if (entry.name !== undefined) addProblem(problems, nameProblem(entry.name, `${at}.name`));
    if (entry.description !== undefined)
      addProblem(problems, descriptionProblem(entry.description, `${at}.description`));
    const subject =
      entry.role === 'baseline' ? { type: 'role', id: 'everyone' } : { type: 'agent', id: agentId };
    return {
      role: entry.role,
      rationale: entry.rationale,
      assessment: entry.assessment,
      policy: {
        kind: 'tool_invocation',
        ...(entry.name !== undefined ? { name: entry.name } : {}),
        ...(entry.description !== undefined ? { description: entry.description } : {}),
        subjects: [subject],
        targets: { tools: [entry.tool] },
        config: { mode: entry.mode },
      },
    };
  });
  if (problems.length > 0) return { problems };
  const proposal = {
    agent: { id: agentId, principal_id: agent.principal_id },
    ...(builtTools.length > 0 ? { tools: builtTools } : {}),
    policies: builtPolicies,
  };
  return { proposal };
}

/**
 * The rules of `PolicySetProposal` (rev 14) that can be checked without the deployment's state: the shape, the
 * subjects and targets each role must have, no duplicates, no policy on a `tool:noblecloak:` reference, `mode` only,
 * and no tightening that is looser than the baseline beside it. Returns a list of problems, each naming the member
 * the way the deployment does (`action.arguments.…`); empty when the proposal can be opened.
 */
export function validateProposal(proposal) {
  const at = 'action.arguments';
  const problems = [];
  if (!isObject(proposal)) return [`${at} must be an object`];
  problems.push(...unknownMembers(proposal, ['agent', 'tools', 'policies'], at));
  const agent = proposal.agent;
  if (!isObject(agent) || !nonEmpty(agent.id)) problems.push(`${at}.agent.id is required`);
  else {
    problems.push(...unknownMembers(agent, ['id', 'principal_id'], `${at}.agent`));
    if (agent.principal_id !== undefined && !nonEmpty(agent.principal_id))
      problems.push(`${at}.agent.principal_id must be a non-empty string`);
  }
  const agentId = isObject(agent) ? agent.id : undefined;

  const tools = proposal.tools ?? [];
  if (!Array.isArray(tools) || tools.length > MAX_ENTRIES)
    problems.push(`${at}.tools must be a list of at most ${MAX_ENTRIES}`);
  else {
    const seen = new Set();
    tools.forEach((tool, i) => {
      const path = `${at}.tools[${i}]`;
      if (!isObject(tool)) return problems.push(`${path} must be an object`);
      problems.push(...unknownMembers(tool, TOOL_KEYS, path));
      if (!nonEmpty(tool.tool_ref) || !tool.tool_ref.startsWith('ext:'))
        problems.push(
          `${path}.tool_ref must start with ext: (an mcp: tool is already in the catalog)`
        );
      else if (seen.has(tool.tool_ref)) problems.push(`${path}.tool_ref repeats ${tool.tool_ref}`);
      else seen.add(tool.tool_ref);
      if (tool.transport !== 'external') problems.push(`${path}.transport must be external`);
      if (tool.owner_kind !== 'org') problems.push(`${path}.owner_kind must be org`);
      if (!isObject(tool.input_schema)) problems.push(`${path}.input_schema must be an object`);
      if (!SIDE_EFFECT_LEVELS.includes(tool.side_effect_level))
        problems.push(`${path}.side_effect_level must be one of ${SIDE_EFFECT_LEVELS.join(', ')}`);
      if (tool.description !== undefined && typeof tool.description !== 'string')
        problems.push(`${path}.description must be a string`);
      if (
        tool.show_arguments_to_approvers !== undefined &&
        typeof tool.show_arguments_to_approvers !== 'boolean'
      )
        problems.push(`${path}.show_arguments_to_approvers must be true or false`);
    });
  }

  const policies = proposal.policies;
  if (!Array.isArray(policies) || policies.length < 1 || policies.length > MAX_ENTRIES) {
    problems.push(`${at}.policies must be a list of 1 to ${MAX_ENTRIES}`);
    return problems;
  }
  const keys = new Set();
  const modes = { baseline: new Map(), tightening: new Map() };
  policies.forEach((entry, i) => {
    const path = `${at}.policies[${i}]`;
    if (!isObject(entry)) return problems.push(`${path} must be an object`);
    problems.push(...unknownMembers(entry, ['role', 'rationale', 'assessment', 'policy'], path));
    if (!ROLES.includes(entry.role)) problems.push(`${path}.role must be baseline or tightening`);
    if (!nonEmpty(entry.rationale) || entry.rationale.length > 500)
      problems.push(`${path}.rationale must be 1 to 500 characters`);
    const assessment = entry.assessment;
    if (!isObject(assessment)) problems.push(`${path}.assessment is required`);
    else {
      problems.push(...unknownMembers(assessment, ASSESSMENT_KEYS, `${path}.assessment`));
      if (!SIDE_EFFECT_LEVELS.includes(assessment.side_effect_level))
        problems.push(
          `${path}.assessment.side_effect_level must be one of ${SIDE_EFFECT_LEVELS.join(', ')}`
        );
      if (!BLAST_RADII.includes(assessment.blast_radius))
        problems.push(`${path}.assessment.blast_radius must be one of ${BLAST_RADII.join(', ')}`);
      for (const flag of ['reversible', 'external_party', 'financial'])
        if (typeof assessment[flag] !== 'boolean')
          problems.push(`${path}.assessment.${flag} must be true or false`);
    }
    const policy = entry.policy;
    if (!isObject(policy)) return problems.push(`${path}.policy is required`);
    problems.push(
      ...unknownMembers(
        policy,
        ['kind', 'name', 'description', 'subjects', 'targets', 'config'],
        `${path}.policy`
      )
    );
    if (policy.kind !== 'tool_invocation')
      problems.push(`${path}.policy.kind must be tool_invocation`);
    if (policy.name !== undefined)
      addProblem(problems, nameProblem(policy.name, `${path}.policy.name`));
    if (policy.description !== undefined)
      addProblem(problems, descriptionProblem(policy.description, `${path}.policy.description`));
    const subject =
      Array.isArray(policy.subjects) && policy.subjects.length === 1
        ? policy.subjects[0]
        : undefined;
    const wanted =
      entry.role === 'baseline' ? { type: 'role', id: 'everyone' } : { type: 'agent', id: agentId };
    if (!isObject(subject) || subject.type !== wanted.type || subject.id !== wanted.id)
      problems.push(
        `${path}.policy.subjects must be exactly [{ type: ${wanted.type}, id: ${String(wanted.id)} }] for a ${String(entry.role)}`
      );
    const targets = isObject(policy.targets) ? policy.targets.tools : undefined;
    const target = Array.isArray(targets) && targets.length === 1 ? targets[0] : undefined;
    if (!nonEmpty(target))
      problems.push(`${path}.policy.targets.tools must list exactly one tool_ref`);
    else if (target.startsWith('tool:noblecloak:'))
      problems.push(
        `${path}.policy.targets.tools[0] is in the reserved namespace tool:noblecloak:`
      );
    const config = policy.config;
    if (!isObject(config) || Object.keys(config).some((key) => key !== 'mode'))
      problems.push(`${path}.policy.config must carry mode only`);
    else if (!isMode(config.mode))
      problems.push(
        `${path}.policy.config.mode must be one of ${Object.keys(MODE_RANK).join(', ')}`
      );
    if (nonEmpty(target) && ROLES.includes(entry.role)) {
      const key = `${entry.role}|${target}`;
      if (keys.has(key)) problems.push(`${path} repeats the ${entry.role} for ${target}`);
      keys.add(key);
      if (isObject(config) && isMode(config.mode))
        modes[entry.role].set(target, { mode: config.mode, path });
    }
  });
  for (const [target, tightening] of modes.tightening) {
    const baseline = modes.baseline.get(target);
    if (baseline !== undefined && MODE_RANK[tightening.mode] < MODE_RANK[baseline.mode])
      problems.push(
        `${tightening.path}.policy.config.mode (${tightening.mode}) is looser than the baseline for ${target} (${baseline.mode}): a tightening only tightens`
      );
  }
  return problems;
}

/** The text that says what the proposal asks an administrator to approve, one fact to a line. */
export function describeProposal(proposal) {
  const lines = [
    `Agent ${proposal.agent.id}` +
      (proposal.agent.principal_id === undefined
        ? ' (binding left as it is)'
        : `, bound to service principal ${proposal.agent.principal_id}`),
  ];
  for (const tool of proposal.tools ?? [])
    lines.push(`Register ${tool.tool_ref} (${tool.side_effect_level}) for the organisation`);
  for (const entry of proposal.policies) {
    const [target] = entry.policy.targets.tools;
    const who = entry.role === 'baseline' ? 'everyone' : 'this agent';
    lines.push(`Policy for ${who} on ${target}: ${entry.policy.config.mode} (${entry.role})`);
    lines.push(`  ${entry.rationale}`);
  }
  return lines.join('\n');
}

/** The body of `POST /v1/approvals` for a proposal. The proposal's reply is held; nothing calls back. */
export function approvalBody(proposal) {
  return {
    action: { tool_ref: PROPOSE_REF, arguments: proposal },
    continuation: { kind: 'mcp_held', delivery: 'held' },
  };
}

/**
 * The claims of a JWT without verifying it, or undefined when it is not one. Only a convenience for a clear
 * message: the deployment verifies the token and refuses any principal that is not a user (`not_a_user`) whatever this says.
 */
export function claimsOf(token) {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

/** The last path segment of a problem's `type`: its code (`proposal_refused`, `approval_unroutable`, ...). */
function problemType(body) {
  return typeof body?.type === 'string' ? (body.type.split('/').pop() ?? '') : '';
}

function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `cannot read ${what} ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * The published `tool_invocation` policies that govern `tool` for subjects of one type, read with `call`
 * (`GET /v1/policies`, every page). Answers `{ rows }`, `{ rejected }` (a 401: the caller handles it like any other),
 * or `{ unread }` with a reason when the list could not be read.
 */
async function governingPolicies(call, tool, subjectType) {
  const rows = [];
  let cursor;
  for (let page = 0; page < 10; page += 1) {
    const query = new URLSearchParams({
      tool,
      subject_type: subjectType,
      kind: 'tool_invocation',
      state: 'published',
      limit: '200',
    });
    if (cursor !== undefined) query.set('cursor', cursor);
    const result = await call('GET', `/v1/policies?${query.toString()}`);
    if (result === undefined) return { unread: 'unreachable' };
    if (result.response.status === 401) return { rejected: result };
    if (result.response.status !== 200 || !Array.isArray(result.body?.data))
      return { unread: `answered ${result.response.status}` };
    rows.push(...result.body.data.filter(isObject));
    cursor = result.body.meta?.next;
    if (!nonEmpty(cursor)) break;
  }
  return { rows };
}

const USAGE =
  'Usage: propose.mjs --plan <plan.json> [--project <dir>] [--base-url <origin>] [--dry-run]';

/**
 * @param {string[]} argv
 * @param {{ env?: Record<string, string | undefined>, fetch?: typeof fetch, out?: (line: string) => void, err?: (line: string) => void }} [io]
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const send = io.fetch ?? fetch;
  const out = io.out ?? ((line) => console.log(line));
  const err = io.err ?? ((line) => console.error(line));

  let args;
  try {
    args = parseArgs({
      args: argv,
      options: {
        plan: { type: 'string' },
        project: { type: 'string' },
        'base-url': { type: 'string' },
        'dry-run': { type: 'boolean' },
      },
      strict: true,
    }).values;
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  if (args.plan === undefined) {
    err(`--plan is required\n${USAGE}`);
    return 2;
  }
  const project = resolve(args.project ?? process.cwd());
  const agentFile = join(project, 'src', 'noblecloak', 'agent.json');
  if (!existsSync(agentFile)) {
    err(`${agentFile} does not exist: run the skill's apply.mjs first`);
    return 2;
  }
  let plan;
  let agentRecord;
  try {
    plan = readJson(args.plan, 'plan');
    agentRecord = readJson(agentFile, 'agent file');
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (!isObject(agentRecord)) {
    err(`${agentFile} must be a JSON object with "name" and "id"`);
    return 2;
  }
  let agentId = nonEmpty(agentRecord.id) ? agentRecord.id : undefined;
  const dryRun = args['dry-run'] === true;
  const unnamed = agentId === undefined && !nonEmpty(agentRecord.name);
  if (unnamed) {
    err(`${agentFile} has neither an id nor a name: set "name" so the agent can be declared`);
    return 2;
  }

  // Check before any request: a placeholder id stands in until the agent is declared.
  const check = (id) => {
    const built = buildProposal(plan, id);
    return built.proposal === undefined ? built.problems : validateProposal(built.proposal);
  };
  const early = check(agentId ?? 'agent_new');
  if (early.length > 0) {
    err(`Refused: the plan does not make a valid proposal:\n  ${early.join('\n  ')}`);
    return 2;
  }
  out(describeProposal(buildProposal(plan, agentId ?? '(declared when this runs)').proposal));
  if (dryRun) {
    out(
      agentId === undefined
        ? `Dry run: would declare the agent "${String(agentRecord.name)}", then open the approval. Nothing was sent.`
        : 'Dry run: nothing was sent.'
    );
    return 0;
  }

  const baseUrl = (args['base-url'] ?? env.NC_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (baseUrl === '') {
    err('NC_BASE_URL (or --base-url) is not set: the module API origin.');
    return 1;
  }
  const token = (env.NC_PROPOSER_TOKEN ?? '').trim();
  if (token === '') {
    err(
      'NC_PROPOSER_TOKEN is not set. The proposal is opened by a person: set it to your own user token. ' +
        "The agent's service principal never opens it."
    );
    return 3;
  }
  const kind = claimsOf(token)?.principal_kind;
  if (kind !== undefined && kind !== 'user') {
    err(
      `NC_PROPOSER_TOKEN is a ${String(kind)} principal token, not a user's. Only a person proposes: use your own user token.`
    );
    return 3;
  }

  const call = async (method, path, body, extraHeaders = {}) => {
    try {
      const response = await send(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...extraHeaders,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return { response, body: await response.json().catch(() => undefined) };
    } catch (error) {
      err(`Could not reach ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };
  const fail = (result) => {
    const { response, body } = result;
    const detail = typeof body?.detail === 'string' ? `: ${body.detail}` : '';
    if (response.status === 401) {
      err(
        `Not signed in (${problemType(body)})${detail}. Your user token was not accepted: get a new one.`
      );
      return 3;
    }
    if (response.status === 403) {
      err(`Access denied (${problemType(body)})${detail}. Your account may not open approvals.`);
      return 1;
    }
    err(
      `The deployment answered ${response.status} (${problemType(body) || 'no problem type'})${detail}.`
    );
    return 1;
  };

  // Read what the deployment already enforces, with the proposer's own token (listing policies needs no
  // administrator), and refuse here what the deployment would refuse when the approval is opened, or when it is
  // approved. A tool this proposal registers has no policies yet and is not asked about. A policy that cannot be
  // read is not a refusal: say so and let the deployment check.
  const proposed = buildProposal(plan, agentId ?? 'agent_new').proposal;
  const registering = new Set((proposed?.tools ?? []).map((tool) => tool.tool_ref));
  const conflicts = [];
  for (const [i, entry] of (proposed?.policies ?? []).entries()) {
    const [tool] = entry.policy.targets.tools;
    const [wanted] = entry.policy.subjects;
    const baseline = entry.role === 'baseline';
    // A new agent has no policies of its own to collide with.
    if (registering.has(tool) || (!baseline && agentId === undefined)) continue;
    const found = await governingPolicies(call, tool, wanted.type);
    if (found.rejected !== undefined) return fail(found.rejected);
    if (found.unread !== undefined) {
      err(
        `Could not read the policies that govern ${tool} (${found.unread}): the deployment checks them when the approval is opened.`
      );
      continue;
    }
    const same = found.rows.find((row) =>
      (row.subjects ?? []).some((s) => s.type === wanted.type && s.id === wanted.id)
    );
    if (same === undefined) continue;
    const at = `action.arguments.policies[${i}]`;
    conflicts.push(
      baseline
        ? `baseline_exists at ${at}: policy ${String(same.id)} already governs ${tool} for everyone, so a baseline would replace it. Drop this entry, or propose a tightening for this agent.`
        : `policy_conflict at ${at}: policy ${String(same.id)} already governs ${tool} for this agent, and an approval would refuse a second one. Change or retire that policy first, or drop this entry.`
    );
  }
  if (conflicts.length > 0) {
    err(`Refused before opening (nothing was sent):\n  ${conflicts.join('\n  ')}`);
    return 2;
  }

  if (agentId === undefined) {
    // The key is written to agent.json before the request, so a run that dies after the deployment created the
    // agent (a timeout, a crash) declares it again with the same key and gets the same agent back: a key is
    // replayed for 24 hours, and a list route to find an orphan does not exist. A changed name needs a new key.
    const pending = isObject(agentRecord.declare) ? agentRecord.declare : undefined;
    const declare =
      pending !== undefined && pending.name === agentRecord.name && nonEmpty(pending.key)
        ? pending
        : { name: agentRecord.name, key: randomUUID() };
    if (declare !== pending) {
      agentRecord = { ...agentRecord, declare };
      writeFileSync(agentFile, `${JSON.stringify(agentRecord, null, 2)}\n`);
    }
    const declared = await call(
      'POST',
      '/v1/agents',
      { name: agentRecord.name },
      { 'idempotency-key': declare.key }
    );
    if (declared === undefined) return 1;
    const id = declared.body?.data?.id;
    if (declared.response.status !== 201 || !nonEmpty(id)) return fail(declared);
    agentId = id;
    const kept = { ...agentRecord, id: agentId };
    delete kept.declare;
    writeFileSync(agentFile, `${JSON.stringify(kept, null, 2)}\n`);
    out(`Declared the agent "${String(agentRecord.name)}": ${agentId} (kept in ${agentFile})`);
  }
  const built = buildProposal(plan, agentId);
  const problems = built.proposal === undefined ? built.problems : validateProposal(built.proposal);
  if (built.proposal === undefined || problems.length > 0) {
    err(`Refused: the plan does not make a valid proposal:\n  ${problems.join('\n  ')}`);
    return 2;
  }

  const opened = await call('POST', '/v1/approvals', approvalBody(built.proposal));
  if (opened === undefined) return 1;
  const { response, body } = opened;
  const type = problemType(body);
  if (response.status === 422 && type === 'proposal_refused' && body?.code === 'not_a_user') {
    err(
      'Refused (not_a_user): the token is not a user token. Only a person proposes: use your own user token.'
    );
    return 3;
  }
  if (response.status === 422 && type === 'proposal_refused' && REFUSAL_CODES.has(body?.code)) {
    const member = typeof body.member === 'string' ? ` at ${body.member}` : '';
    const detail = typeof body.detail === 'string' ? `: ${body.detail}` : '';
    err(`Refused (${String(body.code)})${member}${detail}`);
    return 2;
  }
  if (response.status === 422 && type === 'approval_unroutable') {
    err(
      'This deployment does not apply policy-set proposals (approval_unroutable). Changing the plan will not help: ask the administrator.'
    );
    return 1;
  }
  if (response.status === 409 && type === 'rejected_duplicate') {
    const earlier = nonEmpty(body?.rejected_approval_id)
      ? ` (rejected approval ${String(body.rejected_approval_id)})`
      : '';
    err(
      `Refused (rejected_duplicate): an administrator rejected this same proposal recently${earlier}. Change the plan to answer their reason, or wait out the deployment's duplicate-requests window.`
    );
    return 2;
  }
  if (response.status === 409 && type === 'continuation_conflict') {
    err(
      'Refused (continuation_conflict): an approval for this proposal is already open with another continuation. Resolve it in the approvals module first.'
    );
    return 2;
  }
  if (response.status === 400) {
    err(
      `Refused (${type || 'invalid_request'})${typeof body?.detail === 'string' ? `: ${body.detail}` : ''}`
    );
    return 2;
  }
  const id = body?.data?.id;
  if (!(response.status === 200 || response.status === 201) || !nonEmpty(id)) return fail(opened);

  out(`${response.status === 200 ? 'Approval already open' : 'Approval opened'}: ${id}`);
  const approvalsUrl = (env.NOBLECLOAK_APPROVALS_URL ?? '').trim();
  out(
    approvalsUrl === ''
      ? `An administrator approves it in the NobleCloak approvals module (set NOBLECLOAK_APPROVALS_URL to print its address). Approval id: ${id}`
      : `An administrator approves it in the approvals module at ${approvalsUrl}: look for approval ${id}`
  );
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`propose: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
