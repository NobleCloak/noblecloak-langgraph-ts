/**
 * The acceptance run of the langgraph skill (`bun run exercise:skill`, that is `bun scripts/skill-exercise-agent.ts
 * [--keep] [--skip-e2e]`): a Node project, no browser. It builds and packs the adapter, takes the contract client
 * from the vendored tarball the root `overrides` pin, scaffolds a minimal LangGraph project, applies the skill's script, writes in place
 * of the model the files its steps produce (`skill-exercise-agent-fixtures.ts`), then runs `propose.mjs` against
 * `nc-mock`, approves the proposal as the mock's administrator and checks what the deployment did with it. Then it
 * runs the agent and the skill's own worker as separate processes: the agent pauses on the refund, the worker
 * resumes it once an approver decides, and the refund happens once. Last it compares the fixed template files with the example. The agent and the worker authenticate with a
 * real service-principal credential against a stub token endpoint and are given no pasted token, so the run also
 * proves the generated governance module authenticates from that credential.
 *
 * Network: the package registry, and whatever the install script of `better-sqlite3` downloads (its prebuilt binary).
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  AGENT_WALL_TIME_EXCLUDES,
  compareFixedFiles,
  nodeTemplateGaps,
  SKILLS,
  wallTimeReport,
} from './skill-compare.js';
import type { StepTime } from './skill-compare.js';
import {
  FIXTURE_PLAN,
  GOVERNED_AGENT_TS,
  MOCK_SERVICE_PRINCIPAL_ID,
  PROJECT_NAME,
  PROJECT_TSCONFIG,
  RUN_AGENT_TS,
  USER_AGENT_TS,
  projectManifest,
} from './skill-exercise-agent-fixtures.js';
import {
  assert,
  cleanEnv,
  eventsIn,
  servicePrincipalCredential,
  start,
  startTokenEndpoint,
  until,
} from './skill-exercise-agent-support.js';
import type { Json, Running, TokenEndpoint } from './skill-exercise-agent-support.js';
import {
  contractVersions,
  listTemplateFiles,
  pinContractDependencies,
  run,
  settleReport,
  tarballSources,
} from './skill-exercise-common.js';

const shape = SKILLS.langgraph;

export async function exerciseAgent(
  root: string,
  options: { keep: boolean; skipE2e: boolean }
): Promise<StepTime[]> {
  const steps: StepTime[] = [];
  let failedStep: string | undefined;
  const step = async (name: string, body: () => void | Promise<void>): Promise<void> => {
    const started = Date.now();
    console.log(`\n== ${name}`);
    try {
      await body();
    } catch (error) {
      failedStep = name;
      throw error;
    } finally {
      steps.push({ name, ms: Date.now() - started });
    }
  };
  const work = mkdtempSync(join(tmpdir(), 'skill-exercise-'));
  const project = join(work, 'project');
  const tarballs = join(work, 'tarballs');
  const skillDir = join(root, 'skills', shape.dir);
  const running: Running[] = [];
  let tokenEndpoint: TokenEndpoint | undefined;
  const skippedName = 'run the agent and the worker (pause, approve, resume)';
  let failed = false;
  try {
    await step('build the workspace and pack the adapter', () => {
      run('bun', ['run', 'build'], root);
      run('bun', ['run', 'pack:all'], root);
      mkdirSync(tarballs);
      const sources = tarballSources(root, shape.rootPackage);
      for (const source of sources) cpSync(source.from, join(tarballs, source.file));
      // The packed adapter names the vendored client by a path into this repository; the project installs it
      // by version, as it would from a registry, and `apply.mjs` points that version at the client tarball.
      const adapter = sources.find((source) => source.name === shape.rootPackage);
      if (adapter === undefined) throw new Error(`no tarball for ${shape.rootPackage}`);
      pinContractDependencies(join(tarballs, adapter.file), contractVersions(root));
    });
    await step('scaffold a minimal LangGraph project', () => {
      mkdirSync(join(project, 'src'), { recursive: true });
      writeFileSync(
        join(project, 'package.json'),
        `${JSON.stringify(projectManifest(), null, 2)}\n`
      );
      writeFileSync(join(project, 'tsconfig.json'), PROJECT_TSCONFIG);
      writeFileSync(join(project, 'src/agent.ts'), USER_AGENT_TS);
      run('bun', ['install'], project);
    });
    await step('apply the skill', () => {
      run(
        'node',
        [join(skillDir, 'scripts/apply.mjs'), '--project', project, '--source', tarballs],
        root
      );
    });
    const planFile = join(work, 'noblecloak-plan.json');
    await step("write the model's files: the wrapped agent, the agent's name, the plan", () => {
      writeFileSync(join(project, 'src/noblecloak/governed-agent.ts'), GOVERNED_AGENT_TS);
      writeFileSync(join(project, 'src/run-agent.ts'), RUN_AGENT_TS);
      const agentFile = join(project, 'src/noblecloak/agent.json');
      const record = JSON.parse(readFileSync(agentFile, 'utf8')) as Json;
      writeFileSync(
        agentFile,
        `${JSON.stringify({ ...record, name: `${PROJECT_NAME}-agent` }, null, 2)}\n`
      );
      writeFileSync(planFile, JSON.stringify(FIXTURE_PLAN, null, 2));
    });
    await step('type-check the project with the generated files', () => {
      run(join(project, 'node_modules/.bin/tsc'), ['--noEmit'], project);
    });

    // The mock, as `nc-mock` serves it: it prints its address and the dev tokens, then serves.
    const mock = start(
      'node',
      [join(root, 'node_modules/@noblecloak/spec/dist/cli/nc-mock.js'), '--port', '0'],
      root,
      process.env
    );
    running.push(mock);
    const base = { baseUrl: '', tokens: {} as Record<string, string> };
    await step('start the mock and the stand-in token endpoint', async () => {
      await until(
        () => mock.lines.join('\n').trim().endsWith('}'),
        'the mock to print its address',
        30_000,
        () =>
          mock.child.exitCode === null ? undefined : `the mock exited: ${mock.lines.join('\n')}`
      );
      const printed = JSON.parse(mock.lines.join('\n')) as {
        base_url: string;
        tokens: Record<string, string>;
      };
      base.baseUrl = printed.base_url;
      base.tokens = printed.tokens;
      tokenEndpoint = await startTokenEndpoint(base.tokens.creator ?? '');
      writeFileSync(
        join(work, 'sp-credential.json'),
        JSON.stringify(await servicePrincipalCredential(tokenEndpoint.url, base.baseUrl))
      );
    });
    const call = async (
      token: string | undefined,
      method: string,
      path: string,
      body?: unknown
    ): Promise<{ status: number; body: Json }> => {
      const response = await fetch(`${base.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token ?? ''}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: (await response.json()) as Json };
    };
    const rows = async (path: string, token = base.tokens.admin): Promise<Json[]> =>
      ((await call(token, 'GET', path)).body.data ?? []) as Json[];
    const propose = (...args: string[]) =>
      spawnSync('node', [join(skillDir, 'scripts/propose.mjs'), '--project', project, ...args], {
        encoding: 'utf8',
        env: cleanEnv({
          NC_BASE_URL: base.baseUrl,
          NC_PROPOSER_TOKEN: base.tokens.creator_user ?? '',
          NOBLECLOAK_APPROVALS_URL: 'https://approvals.example.test',
        }),
      });
    const agentJson = (): Json =>
      JSON.parse(readFileSync(join(project, 'src/noblecloak/agent.json'), 'utf8')) as Json;
    let approvalId = '';

    await step('open the proposal with propose.mjs (dry run, then for real, then again)', () => {
      const dry = propose('--plan', planFile, '--dry-run');
      assert(dry.status === 0, `the dry run exited ${String(dry.status)}: ${dry.stderr}`);
      assert(agentJson().id === null, 'a dry run declared the agent');
      const opened = propose('--plan', planFile);
      assert(opened.status === 0, `propose exited ${String(opened.status)}: ${opened.stderr}`);
      const id = /Approval opened: (\S+)/.exec(opened.stdout)?.[1];
      assert(id !== undefined, `no approval id in: ${opened.stdout}`);
      approvalId = id;
      assert(
        opened.stdout.includes('https://approvals.example.test'),
        'the approvals address was not printed'
      );
      assert(typeof agentJson().id === 'string', 'agent.json has no agent id after the run');
      // A second run reuses the agent and finds the open approval.
      const again = propose('--plan', planFile);
      assert(again.status === 0, `the second run exited ${String(again.status)}: ${again.stderr}`);
      assert(
        again.stdout.includes(`Approval already open: ${approvalId}`),
        `the second run did not find the open approval: ${again.stdout}`
      );
    });

    await step(
      'approve it as the mock administrator, and check what the deployment did',
      async () => {
        const refundRef = 'ext:billing:issue_refund';
        const agentId = String(agentJson().id);
        assert(
          !(await rows('/v1/tools')).some((t) => t.tool_ref === refundRef),
          'the tool was registered before anyone approved'
        );
        const opened = (await call(base.tokens.admin, 'GET', `/v1/approvals/${approvalId}`)).body
          .data as Json;
        const approved = await call(
          base.tokens.admin,
          'POST',
          `/v1/approvals/${approvalId}/approve`,
          {
            expected_action_digest: opened.action_digest,
          }
        );
        assert(approved.status === 200, `approving answered ${String(approved.status)}`);

        assert(
          (await rows('/v1/tools')).some((t) => t.tool_ref === refundRef),
          'the tool was not registered by the approval'
        );
        const agent = (await call(base.tokens.admin, 'GET', `/v1/agents/${agentId}`)).body
          .data as Json;
        assert(
          agent.principal_id === MOCK_SERVICE_PRINCIPAL_ID,
          'the service principal is not bound'
        );
        const published = [
          ...(await rows('/v1/policies?tool=mcp:tracker:search&limit=200')),
          ...(await rows(`/v1/policies?tool=${refundRef}&limit=200`)),
        ];
        const subjectsOf = (p: Json): string =>
          JSON.stringify((p.subjects as Json[]).map((s) => `${String(s.type)}:${String(s.id)}`));
        for (const subject of [`role:everyone`, `agent:${agentId}`])
          assert(
            published.some((p) => subjectsOf(p).includes(subject) && p.state === 'published'),
            `no published policy for ${subject}`
          );

        // The tightening is the agent's: its bound service principal is asked, an unbound one is not.
        const search = {
          policies: [FIXTURE_PLAN.policies[0]].map((entry) => ({
            kind: 'tool_invocation',
            subjects: [{ type: 'role', id: 'everyone' }],
            targets: { tools: [entry.tool] },
            config: { mode: entry.mode },
          })),
          action: { tool_ref: 'mcp:tracker:search', arguments: { query: 'damaged' } },
        };
        const bound = (await call(base.tokens.creator, 'POST', '/v1/policies/simulate', search))
          .body.data as Json;
        assert(
          bound.decision === 'step_up',
          `the bound service principal's search is ${String(bound.decision)}`
        );
        const unbound = (
          await call(base.tokens.other_service, 'POST', '/v1/policies/simulate', search)
        ).body.data as Json;
        assert(
          unbound.decision === 'allow',
          `an unbound service principal's search is ${String(unbound.decision)}`
        );
      }
    );

    if (options.skipE2e) {
      console.log(`\n(skipped: ${skippedName})`);
    } else {
      await step(skippedName, async () => {
        const refundLog = join(work, 'refunds.log');
        const env = cleanEnv({
          NC_BASE_URL: base.baseUrl,
          NOBLECLOAK_SP_CREDENTIALS: join(work, 'sp-credential.json'),
          NC_EXPECTED_PRINCIPAL: MOCK_SERVICE_PRINCIPAL_ID,
          NC_CHECKPOINTS: join(work, 'checkpoints.sqlite'),
          NC_REFUND_LOG: refundLog,
        });
        const tsx = join(project, 'node_modules/.bin/tsx');
        const agent = start(tsx, ['src/run-agent.ts'], project, env);
        running.push(agent);
        assert((await agent.exited) === 0, `the agent failed:\n${agent.lines.join('\n')}`);
        const paused = eventsIn(agent.lines).find((e) => e.event === 'agent_paused');
        assert(
          paused !== undefined,
          `the agent did not pause on the refund:\n${agent.lines.join('\n')}`
        );

        // The agent process is gone; the paused run is in the checkpoint file. The skill's own worker resumes it.
        const worker = start(tsx, ['src/noblecloak/worker.ts'], project, env);
        running.push(worker);
        await until(
          () => eventsIn(worker.lines).some((e) => e.event === 'worker_ready'),
          'the worker to start',
          60_000,
          () =>
            worker.child.exitCode === null
              ? undefined
              : `the worker exited:\n${worker.lines.join('\n')}`
        );
        const pending = await rows('/v1/approvals?state=pending&approver=me', base.tokens.approver);
        assert(
          pending.length === 1,
          `expected one pending approval, found ${String(pending.length)}`
        );
        const [approval] = pending;
        assert(approval !== undefined, 'no pending approval');
        assert(
          approval.tool_ref === 'ext:billing:issue_refund',
          'the pending approval is not the refund'
        );
        assert(
          approval.id === paused.approval_id,
          'the pending approval is not the one the agent opened'
        );
        const answer = await call(
          base.tokens.approver,
          'POST',
          `/v1/approvals/${String(approval.id)}/approve`,
          {
            expected_action_digest: approval.action_digest,
          }
        );
        assert(answer.status === 200, `approving the refund answered ${String(answer.status)}`);
        await until(
          () => eventsIn(worker.lines).some((e) => e.event === 'worker_resumed'),
          'the worker to resume the thread',
          60_000,
          () =>
            worker.child.exitCode === null
              ? undefined
              : `the worker exited:\n${worker.lines.join('\n')}`
        );
        // Give a second, wrongly started, refund time to show itself.
        await new Promise((resolve) => setTimeout(resolve, 500));
        const refunds = existsSync(refundLog)
          ? readFileSync(refundLog, 'utf8')
              .split('\n')
              .filter((l) => l !== '')
          : [];
        assert(
          refunds.length === 1,
          `the refund happened ${String(refunds.length)} times, not once`
        );
        assert(
          (tokenEndpoint?.requests.length ?? 0) > 0,
          'the agent never asked the token endpoint: it did not authenticate as the service principal'
        );
      });
    }

    await step('compare the fixed template files with the example', async () => {
      const templates = join(skillDir, 'templates');
      const gaps = nodeTemplateGaps(listTemplateFiles(templates), shape);
      const differences = await compareFixedFiles(
        join(root, 'examples/langgraph-approvals'),
        templates,
        shape.fixed
      );
      for (const d of differences) console.error(`${d.reason}: ${d.file}`);
      for (const f of gaps.unlisted)
        console.error(`template that is neither fixed nor unpaired: ${f}`);
      for (const f of gaps.stale) console.error(`listed template the skill does not ship: ${f}`);
      for (const f of gaps.both) console.error(`template that is both fixed and unpaired: ${f}`);
      if (
        differences.length > 0 ||
        gaps.unlisted.length > 0 ||
        gaps.stale.length > 0 ||
        gaps.both.length > 0
      )
        throw new Error('the skill and the example have drifted apart');
    });
    return steps;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    for (const { child } of running) child.kill('SIGTERM');
    await tokenEndpoint?.stop();
    const skipped = options.skipE2e ? [skippedName] : [];
    const report = wallTimeReport(steps, skipped, failedStep, AGENT_WALL_TIME_EXCLUDES);
    settleReport(() => {
      mkdirSync(join(root, 'artifacts'), { recursive: true });
      writeFileSync(
        join(root, 'artifacts', 'skill-exercise-langgraph-wall-time.json'),
        `${JSON.stringify(report, null, 2)}\n`
      );
    }, failed);
    if (failedStep !== undefined)
      console.log(`\nFAILED at step "${failedStep}". This is not the acceptance result.`);
    else if (!report.complete)
      console.log(
        `\nNOT a full run: skipped ${skipped.join(', ')}. This is not the acceptance result.`
      );
    console.log(`\nwall time ${(report.totalMs / 1000).toFixed(1)} s`);
    for (const s of steps) console.log(`  ${(s.ms / 1000).toFixed(1).padStart(7)} s  ${s.name}`);
    if (options.keep) console.log(`kept ${work}`);
    else rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== '--keep' && arg !== '--skip-e2e');
  if (unknown.length > 0) {
    console.error(`unknown argument ${unknown.join(' ')}; the options are --keep and --skip-e2e`);
    process.exit(2);
  }
  await exerciseAgent(resolve(import.meta.dirname, '..'), {
    keep: args.includes('--keep'),
    skipE2e: args.includes('--skip-e2e'),
  });
}
