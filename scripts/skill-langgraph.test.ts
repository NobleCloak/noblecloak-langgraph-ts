/**
 * The langgraph skill (`skills/langgraph`): its two scripts, the templates it ships, and the parts of the
 * node-agent acceptance run (`skill-exercise-agent.ts`) that can be checked without installing a project. The run
 * itself is `bun run exercise:skill`.
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { transformSync } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AGENT_WALL_TIME_EXCLUDES,
  LANGGRAPH_FIXED_FILES,
  SKILLS,
  compareFixedFiles,
  nodeTemplateGaps,
  wallTimeReport,
} from './skill-compare.js';
import {
  FIXTURE_PLAN,
  PINNED_DEPENDENCIES,
  PINNED_DEV_DEPENDENCIES,
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
import {
  collectTarballs,
  contractVersions,
  listTemplateFiles,
  run,
  tarballFile,
  registryTokenEnv,
  tarballSources,
  withoutRegistryToken,
} from './skill-exercise-common.js';

const ROOT = resolve(import.meta.dirname, '..');
const SKILL = join(ROOT, 'skills/langgraph');
const APPLY = join(SKILL, 'scripts/apply.mjs');
const PROPOSE = join(SKILL, 'scripts/propose.mjs');
const TEMPLATES = join(SKILL, 'templates');
const EXAMPLE = join(ROOT, 'examples/langgraph-approvals');

type Json = Record<string, unknown>;

interface ProposeModule {
  buildProposal(plan: unknown, agentId: string): { proposal?: Json; problems?: string[] };
  validateProposal(proposal: unknown): string[];
  describeProposal(proposal: Json): string;
  claimsOf(token: string): Json | undefined;
  main(
    argv: string[],
    io?: {
      env?: Record<string, string | undefined>;
      fetch?: typeof fetch;
      out?: (line: string) => void;
      err?: (line: string) => void;
    }
  ): Promise<number>;
}
const propose = (await import(pathToFileURL(PROPOSE).href)) as ProposeModule;

/** A proposal the fixture plan makes, copied so a test may change it. */
const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('expected a value');
  return value;
};
const fixtureProposal = (): Json =>
  structuredClone(must(propose.buildProposal(FIXTURE_PLAN, 'agent_1').proposal));
const entriesOf = (proposal: Json): Json[] => proposal.policies as Json[];
const policyOf = (entry: Json): Json => entry.policy as Json;

describe('the skill in the exercise', () => {
  it('is a node-agent skill rooted at the adapter', () => {
    expect(SKILLS.langgraph.kind).toBe('node-agent');
    expect(SKILLS.langgraph.rootPackage).toBe('@noblecloak/langgraph');
  });

  it('installs the adapter as packed and the contract client from the registry at the recorded version', () => {
    const sources = tarballSources(ROOT, SKILLS.langgraph.rootPackage);
    const adapter = JSON.parse(
      readFileSync(join(ROOT, 'packages/langgraph/package.json'), 'utf8')
    ) as {
      version: string;
    };
    expect(contractVersions(ROOT)).toEqual({
      '@noblecloak/client': '0.11.0',
      '@noblecloak/spec': '0.10.0',
    });
    expect(sources).toEqual([
      {
        kind: 'registry',
        name: '@noblecloak/client',
        file: 'noblecloak-client-0.11.0.tgz',
        version: '0.11.0',
      },
      {
        kind: 'packed',
        name: '@noblecloak/langgraph',
        file: tarballFile('@noblecloak/langgraph', adapter.version),
        from: join(ROOT, 'artifacts', tarballFile('@noblecloak/langgraph', adapter.version)),
      },
    ]);
  });

  it('refuses a contract dependency contract.json does not record, or names at another version', () => {
    const root = mkdtempSync(join(tmpdir(), 'tarball-sources-'));
    try {
      mkdirSync(join(root, 'packages/a'), { recursive: true });
      writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
      writeFileSync(
        join(root, 'contract.json'),
        JSON.stringify({ packages: { '@noblecloak/client': { version: '0.11.0' } } })
      );
      const manifest = (dependencies: Record<string, string>): void => {
        writeFileSync(
          join(root, 'packages/a/package.json'),
          JSON.stringify({ name: '@noblecloak/a', version: '1.0.0', dependencies })
        );
      };
      manifest({ '@noblecloak/client': '0.11.0', 'plain-lib': '1.2.3' });
      expect(tarballSources(root, '@noblecloak/a').map((source) => source.name)).toEqual([
        '@noblecloak/a',
        '@noblecloak/client',
      ]);
      manifest({ '@noblecloak/client': '0.10.0' });
      expect(() => tarballSources(root, '@noblecloak/a')).toThrow(
        '@noblecloak/a names @noblecloak/client@0.10.0, but contract.json records 0.11.0'
      );
      manifest({ '@noblecloak/other': '1.0.0' });
      expect(() => tarballSources(root, '@noblecloak/a')).toThrow(
        '@noblecloak/other is not in contract.json; nothing to install it from'
      );
      expect(() => tarballSources(root, '@noblecloak/missing')).toThrow(
        '@noblecloak/missing is not a public workspace package'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs a command, and says the command, the exit status and the directory when it fails', () => {
    expect(() => {
      run('node', ['-e', 'process.exit(0)'], ROOT);
    }).not.toThrow();
    expect(() => {
      run('node', ['-e', 'process.exit(3)'], ROOT);
    }).toThrow(`node -e process.exit(3) failed (exit 3) in ${ROOT}`);
    expect(() => {
      run('no-such-command-here', [], ROOT);
    }).toThrow(/failed \(exit null\) in .*: spawnSync no-such-command-here ENOENT/);
  });

  it('runs a command without the registry token unless the caller passes it', () => {
    const saved = process.env.NODE_AUTH_TOKEN;
    process.env.NODE_AUTH_TOKEN = 'job-token';
    try {
      // Exit 4 when the child sees the token, 0 when it does not.
      const probe = ['-e', 'process.exit(process.env.NODE_AUTH_TOKEN === undefined ? 0 : 4)'];
      expect(() => {
        run('node', probe, ROOT);
      }).not.toThrow();
      expect(() => {
        run('node', probe, ROOT, { NODE_AUTH_TOKEN: 'job-token' });
      }).toThrow('failed (exit 4)');
      expect(withoutRegistryToken({ NODE_AUTH_TOKEN: 't', PATH: '/bin' })).toEqual({
        PATH: '/bin',
      });
      expect(registryTokenEnv({ NODE_AUTH_TOKEN: 't', PATH: '/bin' })).toEqual({
        NODE_AUTH_TOKEN: 't',
      });
      expect(registryTokenEnv({ PATH: '/bin' })).toEqual({});
      expect(cleanEnv({}).NODE_AUTH_TOKEN).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.NODE_AUTH_TOKEN;
      else process.env.NODE_AUTH_TOKEN = saved;
    }
  });

  it('starts no process of the skill run with the registry token in its environment', () => {
    // Importing the run would start it, so this reads its source: `process.env` only ever reaches a child through
    // `withoutRegistryToken`, and its one direct `spawnSync` is given `cleanEnv`.
    const source = readFileSync(join(ROOT, 'scripts/skill-exercise-agent.ts'), 'utf8');
    const passed = source.match(/process\.env/g) ?? [];
    const scrubbed = source.match(/withoutRegistryToken\(process\.env\)/g) ?? [];
    expect(passed.length).toBeGreaterThan(0);
    expect(scrubbed.length).toBe(passed.length);
    const spawns = source.split('spawnSync(').slice(1);
    expect(spawns.length).toBeGreaterThan(0);
    for (const call of spawns)
      expect(call.slice(0, call.indexOf('});'))).toContain('env: cleanEnv(');
  });

  it('copies a packed tarball and fetches a registry one with npm pack, pinned to the package registry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'collect-'));
    const saved = process.env.NODE_AUTH_TOKEN;
    try {
      const packed = join(dir, 'packed.tgz');
      writeFileSync(packed, 'packed');
      const out = join(dir, 'out');
      mkdirSync(out);
      const calls: {
        command: string;
        args: readonly string[];
        cwd: string;
        env: NodeJS.ProcessEnv;
      }[] = [];
      process.env.NODE_AUTH_TOKEN = 'job-token';
      collectTarballs(
        '/repo',
        [
          {
            kind: 'packed',
            name: '@noblecloak/langgraph',
            file: 'noblecloak-langgraph-1.0.0.tgz',
            from: packed,
          },
          {
            kind: 'registry',
            name: '@noblecloak/client',
            file: 'noblecloak-client-0.11.0.tgz',
            version: '0.11.0',
          },
        ],
        out,
        (command, args, cwd, env) => {
          calls.push({ command, args, cwd, env });
          writeFileSync(join(out, 'noblecloak-client-0.11.0.tgz'), 'fetched');
        }
      );
      expect(readFileSync(join(out, 'noblecloak-langgraph-1.0.0.tgz'), 'utf8')).toBe('packed');
      expect(calls).toEqual([
        {
          command: 'npm',
          args: [
            'pack',
            '@noblecloak/client@0.11.0',
            '--pack-destination',
            out,
            '--registry',
            'https://npm.pkg.github.com',
            '--@noblecloak:registry=https://npm.pkg.github.com',
          ],
          cwd: '/repo',
          // The fetch is the one command handed the registry token.
          env: { NODE_AUTH_TOKEN: 'job-token' },
        },
      ]);
      expect(() => {
        collectTarballs(
          '/repo',
          [
            {
              kind: 'registry',
              name: '@noblecloak/spec',
              file: 'noblecloak-spec-0.10.0.tgz',
              version: '0.10.0',
            },
          ],
          out,
          () => undefined
        );
      }).toThrow(`npm pack @noblecloak/spec@0.10.0 left no noblecloak-spec-0.10.0.tgz in ${out}`);
    } finally {
      if (saved === undefined) delete process.env.NODE_AUTH_TOKEN;
      else process.env.NODE_AUTH_TOKEN = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists every template once, as fixed or unpaired, and the fixed ones are the example files', async () => {
    expect(nodeTemplateGaps(listTemplateFiles(TEMPLATES), SKILLS.langgraph)).toEqual({
      unlisted: [],
      stale: [],
      both: [],
    });
    expect(await compareFixedFiles(EXAMPLE, TEMPLATES, LANGGRAPH_FIXED_FILES)).toEqual([]);
  });

  it('names a template in neither list, a listed one that is gone, and one in both', () => {
    const gaps = nodeTemplateGaps(['a.ts', 'b.ts'], {
      ...SKILLS.langgraph,
      fixed: [{ template: 'b.ts', example: 'src/b.ts' }],
      unpaired: ['b.ts', 'c.ts'],
    });
    expect(gaps).toEqual({ unlisted: ['a.ts'], stale: ['c.ts'], both: ['b.ts'] });
  });

  it('reports a fixed file that differs from the example and one that is missing', async () => {
    const copy = mkdtempSync(join(tmpdir(), 'templates-'));
    try {
      cpSync(TEMPLATES, copy, { recursive: true });
      writeFileSync(join(copy, 'log.ts'), `${readFileSync(join(copy, 'log.ts'), 'utf8')}// x\n`);
      expect(await compareFixedFiles(EXAMPLE, copy, LANGGRAPH_FIXED_FILES)).toEqual([
        { file: 'log.ts', reason: 'differs' },
      ]);
      rmSync(join(copy, 'log.ts'));
      expect(await compareFixedFiles(EXAMPLE, copy, LANGGRAPH_FIXED_FILES)).toEqual([
        { file: 'log.ts', reason: 'missing' },
      ]);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });

  it("pins the scaffold's dependencies to the versions the example is tested with", () => {
    const manifest = JSON.parse(readFileSync(join(EXAMPLE, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    for (const [name, version] of Object.entries(PINNED_DEPENDENCIES))
      expect(manifest.dependencies[name]).toBe(version);
    const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      devDependencies: Record<string, string>;
    };
    expect(PINNED_DEV_DEPENDENCIES.typescript).toBe(root.devDependencies.typescript);
    expect(PINNED_DEV_DEPENDENCIES['@types/node']).toBe(root.devDependencies['@types/node']);
    expect(projectManifest().name).toBe('billing');
  });

  it('has a fixture plan that makes a valid proposal, with one of each role', () => {
    const built = propose.buildProposal(FIXTURE_PLAN, 'agent_1');
    expect(built.problems).toBeUndefined();
    expect(propose.validateProposal(built.proposal)).toEqual([]);
    expect(entriesOf(built.proposal ?? {}).map((e) => e.role)).toEqual([
      'baseline',
      'baseline',
      'tightening',
    ]);
  });
});

describe('the acceptance run, the parts that stand alone', () => {
  it('reads the JSON events a process printed and skips every other line', () => {
    expect(
      eventsIn(['{"event":"worker_ready"}', 'plain text', '{"no":"event"}', '{"event":"x","n":1}'])
    ).toEqual([{ event: 'worker_ready' }, { event: 'x', n: 1 }]);
  });

  it('writes a credential the client accepts and a token endpoint that answers an assertion', async () => {
    const endpoint = await startTokenEndpoint('the-token');
    try {
      const credential = await servicePrincipalCredential(endpoint.url, 'http://audience.test');
      expect(credential.client_id).toMatch(/^sp_[0-9a-f-]{36}$/);
      expect(credential.private_jwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
      expect(credential.private_jwk.d).toBeTypeOf('string');
      const ask = (form: Record<string, string>) =>
        fetch(endpoint.url, { method: 'POST', body: new URLSearchParams(form) });
      const granted = await ask({
        grant_type: 'client_credentials',
        client_id: credential.client_id,
        client_assertion: 'a.b.c',
      });
      expect(await granted.json()).toEqual({
        access_token: 'the-token',
        token_type: 'Bearer',
        expires_in: 3600,
      });
      expect(endpoint.requests).toEqual([credential.client_id]);
      // No assertion, or another grant: refused, and not counted as a request that authenticated.
      expect((await ask({ grant_type: 'client_credentials' })).status).toBe(400);
      expect((await ask({ grant_type: 'password', client_assertion: 'x' })).status).toBe(400);
      expect(endpoint.requests).toHaveLength(1);
    } finally {
      await endpoint.stop();
    }
  });
});

describe('the langgraph wall-time report', () => {
  it('lists what its own timer leaves out, by default and when passed', () => {
    const report = wallTimeReport([{ name: 'a', ms: 5 }], [], undefined, AGENT_WALL_TIME_EXCLUDES);
    expect(report.excludes).toEqual(['bun install (the workspace)']);
    expect(wallTimeReport([{ name: 'a', ms: 5 }]).excludes).toEqual(AGENT_WALL_TIME_EXCLUDES);
    expect(wallTimeReport([{ name: 'a', ms: 5 }], [], undefined, ['x']).excludes).toEqual(['x']);
  });
});

// The first import of the template transpiles it: 5.5 s on a GitHub runner, so the describe has its own timeout.
describe('the governance template', { timeout: 60_000 }, () => {
  const jwt = (sub: string): string =>
    `h.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.s`;
  interface GovernanceTemplate {
    agentGovernance: (options: { env: Record<string, string | undefined> }) => Promise<{
      assertReady: () => Promise<void>;
    }>;
  }
  const load = async () =>
    (await import(pathToFileURL(join(TEMPLATES, 'governance.ts')).href)) as GovernanceTemplate;

  it('refuses to start without NC_EXPECTED_PRINCIPAL, naming it', async () => {
    const { agentGovernance } = await load();
    await expect(
      agentGovernance({
        env: { NC_BASE_URL: 'http://127.0.0.1:1', NOBLECLOAK_SP_CREDENTIALS: '{}' },
      })
    ).rejects.toThrow('NC_EXPECTED_PRINCIPAL is not set');
  });

  it('stops with principal_mismatch when the credential is another principal than the one expected', async () => {
    const { agentGovernance } = await load();
    const endpoint = await startTokenEndpoint(jwt('svc_other'));
    try {
      const credential = await servicePrincipalCredential(endpoint.url, 'http://audience.test');
      const env = {
        NC_BASE_URL: 'http://127.0.0.1:1',
        NOBLECLOAK_SP_CREDENTIALS: JSON.stringify(credential),
      };
      const mismatched = await agentGovernance({
        env: { ...env, NC_EXPECTED_PRINCIPAL: 'svc_agent' },
      });
      await expect(mismatched.assertReady()).rejects.toMatchObject({ code: 'principal_mismatch' });
    } finally {
      await endpoint.stop();
    }
  });
});

describe('the acceptance run, its process helpers', () => {
  it('reads the lines a child printed on stdout and stderr, the last one without a newline too', async () => {
    const child = start(
      'node',
      ['-e', "process.stdout.write('one\\ntwo'); console.error('three')"],
      ROOT,
      process.env
    );
    expect(await child.exited).toBe(0);
    await until(() => child.lines.length === 3, 'the three lines', 5_000);
    expect([...child.lines].sort()).toEqual(['one', 'three', 'two']);
  });

  it('waits for a condition, and ends the wait with the failure message or a timeout', async () => {
    let n = 0;
    await until(() => (n += 1) > 2, 'a count', 5_000);
    await expect(
      until(
        () => false,
        'never',
        5_000,
        () => 'the process died'
      )
    ).rejects.toThrow('the process died');
    await expect(
      until(
        () => false,
        'never',
        120,
        () => undefined
      )
    ).rejects.toThrow('timed out waiting for never');
  });

  it('asserts with the message, and hands a child no pasted token', () => {
    expect(() => {
      assert(false, 'it broke');
    }).toThrow('assertion failed: it broke');
    expect(() => {
      assert(true, 'fine');
    }).not.toThrow();
    process.env.NC_TOKEN = 'a';
    process.env.NC_PROPOSER_TOKEN = 'b';
    try {
      const env = cleanEnv({ NC_PROPOSER_TOKEN: 'mine', NC_BASE_URL: 'https://x.test' });
      expect(env.NC_TOKEN).toBeUndefined();
      expect(env.NC_PROPOSER_TOKEN).toBe('mine');
      expect(env.NC_BASE_URL).toBe('https://x.test');
      expect(cleanEnv({}).NC_PROPOSER_TOKEN).toBeUndefined();
    } finally {
      delete process.env.NC_TOKEN;
      delete process.env.NC_PROPOSER_TOKEN;
    }
  });
});

describe('apply.mjs', () => {
  let project: string;
  const apply = (...args: string[]) =>
    spawnSync('node', [APPLY, '--project', project, ...args], { encoding: 'utf8' });
  const manifest = (extra: Record<string, unknown> = {}): void => {
    writeFileSync(
      join(project, 'package.json'),
      JSON.stringify({ name: 'x', dependencies: { '@langchain/langgraph': '1.5.1' }, ...extra })
    );
  };
  const at = (path: string): string => join(project, 'src/noblecloak', path);

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'apply-langgraph-'));
    manifest();
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it('writes every template under src/noblecloak, byte for byte', () => {
    const result = apply('--skip-install');
    expect(result.status).toBe(0);
    for (const file of listTemplateFiles(TEMPLATES))
      expect(readFileSync(at(file), 'utf8')).toBe(readFileSync(join(TEMPLATES, file), 'utf8'));
  });

  it('wires langchain alone, as a dev dependency too, and refuses a project with neither', () => {
    manifest({ dependencies: {}, devDependencies: { langchain: '1.5.18' } });
    expect(apply('--skip-install').status).toBe(0);
    rmSync(join(project, 'src'), { recursive: true });
    manifest({ dependencies: { express: '5.0.0' } });
    const refused = apply('--skip-install');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(
      'depends on neither @langchain/langgraph nor langchain: the skill wires a LangGraph JS agent'
    );
    expect(existsSync(join(project, 'src'))).toBe(false);
  });

  it('adds the environment keys and never NC_TOKEN, once', () => {
    apply('--skip-install');
    apply('--skip-install');
    const env = readFileSync(join(project, '.env.example'), 'utf8');
    expect(env).toContain('NC_BASE_URL=');
    expect(env).toContain('NOBLECLOAK_SP_CREDENTIALS=');
    expect(env).toContain('NC_EXPECTED_PRINCIPAL=');
    expect(env).toContain('# NC_AUDIENCE=');
    expect(env).not.toContain('NC_TOKEN');
    expect(env.match(/NC_BASE_URL=/g)).toHaveLength(1);
  });

  it('keeps the keys an env file already has', () => {
    writeFileSync(join(project, '.env.example'), 'NC_BASE_URL=https://mine.test\n');
    apply('--skip-install');
    const env = readFileSync(join(project, '.env.example'), 'utf8');
    expect(env).toContain('NC_BASE_URL=https://mine.test');
    expect(env.match(/NC_BASE_URL=/g)).toHaveLength(1);
    expect(env).toContain('NOBLECLOAK_SP_CREDENTIALS=');
  });

  it('refuses to overwrite a different file, and writes nothing, unless forced', () => {
    mkdirSync(at('.'), { recursive: true });
    writeFileSync(at('worker.ts'), '// mine\n');
    const refused = apply('--skip-install');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('src/noblecloak/worker.ts');
    expect(existsSync(at('governance.ts'))).toBe(false);
    expect(existsSync(join(project, '.env.example'))).toBe(false);
    expect(apply('--skip-install', '--force').status).toBe(0);
    expect(readFileSync(at('worker.ts'), 'utf8')).toBe(
      readFileSync(join(TEMPLATES, 'worker.ts'), 'utf8')
    );
  });

  it('keeps an agent.json that exists, even with --force, and says so', () => {
    apply('--skip-install');
    writeFileSync(at('agent.json'), '{ "name": "mine", "id": "agent_9" }\n');
    const result = apply('--skip-install', '--force');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('keep (it holds the agent id) src/noblecloak/agent.json');
    expect(readFileSync(at('agent.json'), 'utf8')).toBe('{ "name": "mine", "id": "agent_9" }\n');
  });

  it('writes nothing on a dry run', () => {
    const result = apply('--dry-run');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('create src/noblecloak/governance.ts');
    expect(result.stdout).toContain(
      'would run npm install @noblecloak/langgraph @noblecloak/client'
    );
    expect(existsSync(join(project, 'src'))).toBe(false);
    expect(existsSync(join(project, '.env.example'))).toBe(false);
  });

  it('un-ignores .env.example under a .env* rule, and takes the manager from the lockfile', () => {
    writeFileSync(join(project, '.gitignore'), 'node_modules\n.env*\n');
    writeFileSync(join(project, 'bun.lock'), '');
    const result = apply('--dry-run');
    expect(result.stdout).toContain('add !.env.example to .gitignore');
    expect(result.stdout).toContain('bun add @noblecloak/langgraph @noblecloak/client');
  });

  it('says why the install failed, and what was already written', () => {
    manifest({ packageManager: 'bun@1.4.3' });
    const bin = mkdtempSync(join(tmpdir(), 'bin-'));
    try {
      writeFileSync(join(bin, 'bun'), '#!/bin/sh\nexit 7\n', { mode: 0o755 });
      const result = spawnSync('node', [APPLY, '--project', project], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      });
      expect(result.status).toBe(7);
      expect(result.stderr).toContain(
        'bun add @noblecloak/langgraph @noblecloak/client failed: exit 7'
      );
      expect(result.stderr).toContain('The files above were written');
      expect(existsSync(at('worker.ts'))).toBe(true);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  describe('--source <tarballs>', () => {
    let tarballs: string;
    beforeEach(() => {
      tarballs = mkdtempSync(join(tmpdir(), 'tarballs-'));
    });
    afterEach(() => {
      rmSync(tarballs, { recursive: true, force: true });
    });
    const pack = (...files: string[]): void => {
      for (const file of files) writeFileSync(join(tarballs, file), '');
    };

    it('needs exactly one tarball of the adapter and of the client', () => {
      expect(apply('--source', tarballs).stderr).toContain(
        'expected one noblecloak-langgraph-<version>.tgz, found 0'
      );
      pack('noblecloak-langgraph-1.0.0.tgz');
      expect(apply('--source', tarballs, '--skip-install').stderr).toContain(
        'expected one noblecloak-client-<version>.tgz, found 0'
      );
      expect(apply('--source', join(tarballs, 'nope')).stderr).toContain('no such directory');
    });

    it('installs both and pins the client dependency of the adapter tarball to its own', () => {
      pack('noblecloak-langgraph-1.0.0.tgz', 'noblecloak-client-2.0.0.tgz');
      const result = apply('--source', tarballs, '--dry-run');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        `pin @noblecloak/client to file:${join(tarballs, 'noblecloak-client-2.0.0.tgz')}`
      );
      expect(result.stdout).toContain(
        `npm install ${join(tarballs, 'noblecloak-langgraph-1.0.0.tgz')} ${join(tarballs, 'noblecloak-client-2.0.0.tgz')}`
      );
      expect(apply('--source', tarballs, '--skip-install').status).toBe(0);
      const written = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')) as {
        overrides: Record<string, string>;
      };
      expect(written.overrides['@noblecloak/client']).toBe(
        `file:${join(tarballs, 'noblecloak-client-2.0.0.tgz')}`
      );
    });
  });
});

describe('propose.mjs: validateProposal', () => {
  const problemsOf = (change: (proposal: Json) => void): string[] => {
    const proposal = fixtureProposal();
    change(proposal);
    return propose.validateProposal(proposal);
  };
  const entry = (proposal: Json, i: number): Json => must(entriesOf(proposal)[i]);

  it('accepts what the fixture plan builds', () => {
    expect(propose.validateProposal(fixtureProposal())).toEqual([]);
  });

  it('names every member it refuses the way the deployment does', () => {
    expect(problemsOf((p) => ((p.agent as Json).extra = 1))).toEqual([
      'action.arguments.agent.extra is not a member of this object',
    ]);
    expect(problemsOf((p) => (p.policies = []))).toEqual([
      'action.arguments.policies must be a list of 1 to 50',
    ]);
    expect(problemsOf((p) => (p.surprise = true))).toEqual([
      'action.arguments.surprise is not a member of this object',
    ]);
    expect(problemsOf((p) => delete entry(p, 0).rationale)).toEqual([
      'action.arguments.policies[0].rationale must be 1 to 500 characters',
    ]);
    expect(problemsOf((p) => (entry(p, 0).rationale = 'x'.repeat(501)))).toEqual([
      'action.arguments.policies[0].rationale must be 1 to 500 characters',
    ]);
  });

  it('holds a baseline to the everyone role and a tightening to this agent, one target each', () => {
    expect(
      problemsOf((p) => (policyOf(entry(p, 0)).subjects = [{ type: 'agent', id: 'agent_1' }]))
    ).toEqual([
      'action.arguments.policies[0].policy.subjects must be exactly [{ type: role, id: everyone }] for a baseline',
    ]);
    expect(
      problemsOf((p) => (policyOf(entry(p, 2)).subjects = [{ type: 'agent', id: 'agent_2' }]))
    ).toEqual([
      'action.arguments.policies[2].policy.subjects must be exactly [{ type: agent, id: agent_1 }] for a tightening',
    ]);
    expect(problemsOf((p) => (policyOf(entry(p, 0)).targets = { tools: ['a', 'b'] }))).toEqual([
      'action.arguments.policies[0].policy.targets.tools must list exactly one tool_ref',
    ]);
    expect(problemsOf((p) => (policyOf(entry(p, 0)).targets = {}))).toEqual([
      'action.arguments.policies[0].policy.targets.tools must list exactly one tool_ref',
    ]);
  });

  it('refuses a policy on the reserved namespace, more than the mode, and a mode it does not know', () => {
    expect(
      problemsOf(
        (p) => (policyOf(entry(p, 0)).targets = { tools: ['tool:noblecloak:propose-policy-set'] })
      )
    ).toEqual([
      'action.arguments.policies[0].policy.targets.tools[0] is in the reserved namespace tool:noblecloak:',
    ]);
    expect(
      problemsOf((p) => (policyOf(entry(p, 0)).config = { mode: 'ask', on_deny: 'x' }))
    ).toEqual(['action.arguments.policies[0].policy.config must carry mode only']);
    expect(problemsOf((p) => (policyOf(entry(p, 0)).config = { mode: 'not_granted' }))).toEqual([
      'action.arguments.policies[0].policy.config.mode must be one of always_allow, ask, escalate, deny',
    ]);
    for (const inherited of ['constructor', 'toString', '__proto__'])
      expect(problemsOf((p) => (policyOf(entry(p, 0)).config = { mode: inherited }))).toEqual([
        'action.arguments.policies[0].policy.config.mode must be one of always_allow, ask, escalate, deny',
      ]);
    expect(problemsOf((p) => (policyOf(entry(p, 0)).origin = { format: 'x' }))).toEqual([
      'action.arguments.policies[0].policy.origin is not a member of this object',
    ]);
  });

  it('refuses a duplicate policy, and a tightening looser than the baseline beside it', () => {
    expect(problemsOf((p) => entriesOf(p).push(structuredClone(entry(p, 1))))).toEqual([
      'action.arguments.policies[3] repeats the baseline for ext:billing:issue_refund',
    ]);
    // The search baseline is always_allow and the tightening ask: swapping them makes the tightening looser.
    const swapped = problemsOf((p) => {
      policyOf(entry(p, 0)).config = { mode: 'ask' };
      policyOf(entry(p, 2)).config = { mode: 'always_allow' };
    });
    expect(swapped).toEqual([
      'action.arguments.policies[2].policy.config.mode (always_allow) is looser than the baseline for mcp:tracker:search (ask): a tightening only tightens',
    ]);
    // Equal is not looser.
    expect(
      problemsOf((p) => {
        policyOf(entry(p, 2)).config = { mode: 'always_allow' };
      })
    ).toEqual([]);
  });

  it('checks the assessment: levels, radius and the three flags', () => {
    expect(
      problemsOf((p) => ((entry(p, 0).assessment as Json).side_effect_level = 'write!'))[0]
    ).toContain('assessment.side_effect_level must be one of read, write, delete, external, admin');
    expect(problemsOf((p) => ((entry(p, 0).assessment as Json).blast_radius = 'few'))[0]).toContain(
      'assessment.blast_radius must be one of one_record, many_records, org_wide'
    );
    expect(problemsOf((p) => ((entry(p, 0).assessment as Json).financial = 'no'))[0]).toContain(
      'assessment.financial must be true or false'
    );
    expect(problemsOf((p) => delete entry(p, 0).assessment)).toEqual([
      'action.arguments.policies[0].assessment is required',
    ]);
  });

  it('checks each registration: ext: only, org-owned, external transport, no repeat, a known level', () => {
    const tool = (p: Json): Json => must((p.tools as Json[])[0]);
    expect(problemsOf((p) => (tool(p).tool_ref = 'mcp:tracker:search'))[0]).toContain(
      'action.arguments.tools[0].tool_ref must start with ext:'
    );
    expect(problemsOf((p) => (tool(p).owner_kind = 'principal'))).toEqual([
      'action.arguments.tools[0].owner_kind must be org',
    ]);
    expect(problemsOf((p) => (tool(p).transport = 'mcp'))).toEqual([
      'action.arguments.tools[0].transport must be external',
    ]);
    expect(problemsOf((p) => (tool(p).side_effect_level = 'huge'))[0]).toContain(
      'action.arguments.tools[0].side_effect_level must be one of'
    );
    expect(problemsOf((p) => (p.tools as Json[]).push(structuredClone(tool(p))))).toEqual([
      'action.arguments.tools[1].tool_ref repeats ext:billing:issue_refund',
    ]);
    expect(problemsOf((p) => delete tool(p).input_schema)).toEqual([
      'action.arguments.tools[0].input_schema must be an object',
    ]);
  });

  it('allows at most 50 tools and 50 policies', () => {
    expect(problemsOf((p) => (p.tools = Array.from({ length: 51 }, () => ({}))))[0]).toContain(
      'action.arguments.tools must be a list of at most 50'
    );
    expect(problemsOf((p) => (p.policies = Array.from({ length: 51 }, () => ({}))))).toEqual([
      'action.arguments.policies must be a list of 1 to 50',
    ]);
  });
});

describe('propose.mjs: buildProposal', () => {
  const plan = (change: (p: Json) => void = () => undefined): Json => {
    const copy = structuredClone(FIXTURE_PLAN) as unknown as Json;
    change(copy);
    return copy;
  };

  it('fills in the kind, the subject and the target of each policy, and the registration defaults', () => {
    const { proposal } = propose.buildProposal(plan(), 'agent_7');
    expect(proposal?.agent).toEqual({ id: 'agent_7', principal_id: 'svc_adapter' });
    const [tool] = proposal?.tools as Json[];
    expect(tool).toMatchObject({ owner_kind: 'org', transport: 'external' });
    expect(entriesOf(proposal ?? {}).map((e) => policyOf(e))).toEqual([
      {
        kind: 'tool_invocation',
        subjects: [{ type: 'role', id: 'everyone' }],
        targets: { tools: ['mcp:tracker:search'] },
        config: { mode: 'always_allow' },
      },
      expect.objectContaining({ subjects: [{ type: 'role', id: 'everyone' }] }),
      expect.objectContaining({
        subjects: [{ type: 'agent', id: 'agent_7' }],
        targets: { tools: ['mcp:tracker:search'] },
      }),
    ]);
  });

  it('refuses a plan without the service principal, with a stray agent id and with unknown members', () => {
    expect(
      propose.buildProposal(
        plan((p) => (p.agent = {})),
        'a'
      ).problems
    ).toEqual([
      'plan.agent.principal_id is required: the agent runs as its own service principal, and the proposal binds it',
    ]);
    expect(
      propose.buildProposal(
        plan((p) => (p.agent = { principal_id: 'x', id: 'other' })),
        'a'
      ).problems
    ).toEqual(['plan.agent.id (other) is not the id in agent.json (a): leave it out']);
    expect(
      propose.buildProposal(
        plan((p) => (p.extra = 1)),
        'a'
      ).problems
    ).toEqual(['plan.extra is not a member of this object']);
    expect(
      propose.buildProposal(
        plan((p) => delete (p.policies as Json[])[0]?.mode),
        'a'
      ).problems
    ).toEqual(['plan.policies[0].mode is required']);
    expect(
      propose.buildProposal(
        plan((p) => (p.policies = 'x')),
        'a'
      ).problems
    ).toEqual(['plan.policies must be a list']);
    expect(propose.buildProposal('x', 'a').problems).toEqual(['the plan must be a JSON object']);
  });

  it('describes the proposal for the person who runs it, rationale included', () => {
    const text = propose.describeProposal(fixtureProposal());
    expect(text).toContain('Agent agent_1, bound to service principal svc_adapter');
    expect(text).toContain('Register ext:billing:issue_refund (external) for the organisation');
    expect(text).toContain('Policy for everyone on ext:billing:issue_refund: ask (baseline)');
    expect(text).toContain('Policy for this agent on mcp:tracker:search: ask (tightening)');
    expect(text).toContain('money leaves the organisation');
  });

  it('reads the claims of a token without trusting it', () => {
    const token = `h.${Buffer.from(JSON.stringify({ principal_kind: 'service' })).toString('base64url')}.s`;
    expect(propose.claimsOf(token)).toEqual({ principal_kind: 'service' });
    expect(propose.claimsOf('not a token')).toBeUndefined();
  });
});

describe('propose.mjs: the command', () => {
  let project: string;
  let server: Server | undefined;
  let requests: {
    method: string;
    path: string;
    auth: string;
    key: string | undefined;
    body: Json;
  }[];
  let answer: (req: { method: string; path: string; body: Json }) => { status: number; body: Json };
  let baseUrl: string;
  let planFile: string;
  const USER_TOKEN = `h.${Buffer.from(JSON.stringify({ principal_kind: 'user' })).toString('base64url')}.s`;
  const SERVICE_TOKEN = `h.${Buffer.from(JSON.stringify({ principal_kind: 'service' })).toString('base64url')}.s`;
  const agentFile = (): string => join(project, 'src/noblecloak/agent.json');
  const declareKey = (): string | undefined => requests.find((r) => r.path === '/v1/agents')?.key;
  const agentRecord = (): Json => JSON.parse(readFileSync(agentFile(), 'utf8')) as Json;

  const run = async (
    args: string[],
    env: Record<string, string | undefined> = {}
  ): Promise<{ code: number; out: string[]; err: string[] }> => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await propose.main(['--project', project, '--plan', planFile, ...args], {
      env: {
        NC_BASE_URL: baseUrl,
        NC_PROPOSER_TOKEN: USER_TOKEN,
        NOBLECLOAK_APPROVALS_URL: 'https://approvals.example.test',
        ...env,
      },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    return { code, out, err };
  };

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'propose-'));
    mkdirSync(join(project, 'src/noblecloak'), { recursive: true });
    writeFileSync(agentFile(), `${JSON.stringify({ name: 'billing-agent', id: null }, null, 2)}\n`);
    planFile = join(project, 'plan.json');
    writeFileSync(planFile, JSON.stringify(FIXTURE_PLAN));
    requests = [];
    answer = ({ method, path }) =>
      method === 'GET' && path.startsWith('/v1/policies?')
        ? { status: 200, body: { data: [], meta: {} } }
        : method === 'POST' && path === '/v1/agents'
          ? { status: 201, body: { data: { id: 'agent_42' } } }
          : { status: 201, body: { data: { id: 'appr_1' } } };
    server = createServer((req: IncomingMessage, res) => {
      let text = '';
      req.on('data', (chunk: Buffer) => (text += chunk.toString()));
      req.on('end', () => {
        const body = text === '' ? {} : (JSON.parse(text) as Json);
        const path = req.url ?? '';
        requests.push({
          method: req.method ?? '',
          path,
          auth: req.headers.authorization ?? '',
          key: req.headers['idempotency-key'] as string | undefined,
          body,
        });
        const reply = answer({ method: req.method ?? '', path, body });
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolveListen) => server?.listen(0, '127.0.0.1', resolveListen));
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolveClose) => {
      if (server === undefined) resolveClose();
      else
        server.close(() => {
          resolveClose();
        });
    });
    rmSync(project, { recursive: true, force: true });
  });

  it('declares the agent, writes its id, opens the approval and prints where to approve it', async () => {
    const { code, out } = await run([]);
    expect(code).toBe(0);
    expect(requests.map((r) => `${r.method} ${r.path.split('?')[0] ?? ''}`)).toEqual([
      'GET /v1/policies',
      'POST /v1/agents',
      'POST /v1/approvals',
    ]);
    expect(requests[1]).toMatchObject({
      auth: `Bearer ${USER_TOKEN}`,
      body: { name: 'billing-agent' },
    });
    expect(agentRecord()).toEqual({ name: 'billing-agent', id: 'agent_42' });
    const opened = requests[2]?.body as { action: Json; continuation: Json };
    expect(opened.action.tool_ref).toBe('tool:noblecloak:propose-policy-set');
    expect((opened.action.arguments as Json).agent).toEqual({
      id: 'agent_42',
      principal_id: 'svc_adapter',
    });
    expect(opened.continuation).toEqual({ kind: 'mcp_held', delivery: 'held' });
    expect(out).toContain('Approval opened: appr_1');
    expect(out.at(-1)).toContain(
      'in the approvals module at https://approvals.example.test: look for approval appr_1'
    );
  });

  it('declares the agent with an idempotency key kept in agent.json, so a run that died is replayed, not repeated', async () => {
    answer = ({ path }) =>
      path === '/v1/agents'
        ? { status: 503, body: { type: 'https://x.test/problems/service_unavailable' } }
        : { status: 201, body: { data: { id: 'appr_1' } } };
    expect((await run([])).code).toBe(1);
    const first = declareKey();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(agentRecord()).toMatchObject({
      id: null,
      declare: { name: 'billing-agent', key: first },
    });
    requests = [];
    answer = ({ path }) =>
      path === '/v1/agents'
        ? { status: 201, body: { data: { id: 'agent_42' } } }
        : { status: 201, body: { data: { id: 'appr_1' } } };
    expect((await run([])).code).toBe(0);
    expect(declareKey()).toBe(first);
    expect(agentRecord()).toEqual({ name: 'billing-agent', id: 'agent_42' });
  });

  it('uses a new key when the agent was renamed since the failed run', async () => {
    answer = () => ({ status: 503, body: { type: 'https://x.test/problems/service_unavailable' } });
    await run([]);
    const first = declareKey();
    writeFileSync(agentFile(), JSON.stringify({ ...agentRecord(), name: 'refund-agent' }));
    requests = [];
    await run([]);
    expect(declareKey()).toMatch(/^[0-9a-f-]{36}$/);
    expect(declareKey()).not.toBe(first);
  });

  it('reuses the agent on a second run, and says when the approval was already open', async () => {
    await run([]);
    requests = [];
    answer = ({ method }) =>
      method === 'GET'
        ? { status: 200, body: { data: [], meta: {} } }
        : { status: 200, body: { data: { id: 'appr_1' } } };
    const { code, out } = await run([]);
    expect(code).toBe(0);
    expect(requests.map((r) => `${r.method} ${r.path.split('?')[0] ?? ''}`)).toEqual([
      'GET /v1/policies',
      'GET /v1/policies',
      'POST /v1/approvals',
    ]);
    expect(out).toContain('Approval already open: appr_1');
  });

  it('says how to find the approval when no approvals address is configured', async () => {
    const { out } = await run([], { NOBLECLOAK_APPROVALS_URL: undefined });
    expect(out.at(-1)).toContain('set NOBLECLOAK_APPROVALS_URL');
    expect(out.at(-1)).toContain('appr_1');
  });

  describe('the policies already in force', () => {
    const everyone = { id: 'pol_all', subjects: [{ type: 'role', id: 'everyone' }] };
    const forAgent = { id: 'pol_mine', subjects: [{ type: 'agent', id: 'agent_42' }] };
    const reads = (): URLSearchParams[] =>
      requests
        .filter((r) => r.method === 'GET')
        .map((r) => new URLSearchParams(r.path.split('?')[1] ?? ''));
    const listing =
      (rows: (query: URLSearchParams) => Json[], then: Json = { data: { id: 'appr_1' } }) =>
      ({ method, path }: { method: string; path: string }): { status: number; body: Json } =>
        method === 'GET'
          ? {
              status: 200,
              body: { data: rows(new URLSearchParams(path.split('?')[1] ?? '')), meta: {} },
            }
          : path === '/v1/agents'
            ? { status: 201, body: { data: { id: 'agent_42' } } }
            : { status: 201, body: then };

    it('asks for the published tool_invocation policies of the tool, by subject type, with the proposer token', async () => {
      await run([]);
      expect(reads().map((q) => Object.fromEntries(q))).toEqual([
        {
          tool: 'mcp:tracker:search',
          subject_type: 'role',
          kind: 'tool_invocation',
          state: 'published',
          limit: '200',
        },
      ]);
      expect(requests[0]?.auth).toBe(`Bearer ${USER_TOKEN}`);
    });

    it('does not ask about a tool the proposal registers, nor about a new agent for a tightening', async () => {
      await run([]);
      expect(reads().map((q) => q.get('tool'))).toEqual(['mcp:tracker:search']);
      expect(reads().map((q) => q.get('subject_type'))).not.toContain('agent');
    });

    it('refuses a baseline for a tool an everyone policy governs, before it declares the agent', async () => {
      answer = listing((q) => (q.get('subject_type') === 'role' ? [everyone] : []));
      const { code, err } = await run([]);
      expect(code).toBe(2);
      expect(err.join('\n')).toContain('baseline_exists at action.arguments.policies[0]');
      expect(err.join('\n')).toContain('pol_all');
      expect(requests.map((r) => r.method)).toEqual(['GET']);
      expect(agentRecord().id).toBeNull();
    });

    it('leaves a policy of another subject alone', async () => {
      answer = listing(() => [{ id: 'pol_x', subjects: [{ type: 'role', id: 'member' }] }]);
      expect((await run([])).code).toBe(0);
    });

    it('refuses a tightening for a tool this agent already has a policy for', async () => {
      await run([]);
      requests = [];
      answer = listing((q) => (q.get('subject_type') === 'agent' ? [forAgent] : []));
      const { code, err } = await run([]);
      expect(code).toBe(2);
      expect(err.join('\n')).toContain('policy_conflict at action.arguments.policies[2]');
      expect(requests.some((r) => r.path === '/v1/approvals')).toBe(false);
    });

    it('follows the cursor to the next page', async () => {
      let pages = 0;
      answer = ({ method, path }) => {
        if (method !== 'GET') return { status: 201, body: { data: { id: 'agent_42' } } };
        pages += 1;
        const cursor = new URLSearchParams(path.split('?')[1] ?? '').get('cursor');
        return cursor === null
          ? { status: 200, body: { data: [], meta: { next: 'c2' } } }
          : { status: 200, body: { data: [everyone], meta: { next: null } } };
      };
      expect((await run([])).code).toBe(2);
      expect(pages).toBe(2);
    });

    it('says so and goes on when the list cannot be read, and stops on a 401', async () => {
      answer = ({ method, path }) =>
        method === 'GET'
          ? { status: 403, body: { type: 'https://x.test/problems/forbidden' } }
          : path === '/v1/agents'
            ? { status: 201, body: { data: { id: 'agent_42' } } }
            : { status: 201, body: { data: { id: 'appr_1' } } };
      const unread = await run([]);
      expect(unread.code).toBe(0);
      expect(unread.err.join('\n')).toContain(
        'Could not read the policies that govern mcp:tracker:search (answered 403)'
      );
      answer = ({ method }) =>
        method === 'GET'
          ? { status: 401, body: { type: 'https://x.test/problems/unauthorized' } }
          : { status: 201, body: { data: { id: 'agent_42' } } };
      expect((await run([])).code).toBe(3);
    });

    it('sends nothing on a dry run, so it reads nothing', async () => {
      await run(['--dry-run'], { NC_PROPOSER_TOKEN: undefined });
      expect(requests).toEqual([]);
    });
  });

  it('sends nothing on a dry run, and says it would declare the agent', async () => {
    const { code, out } = await run(['--dry-run'], { NC_PROPOSER_TOKEN: undefined });
    expect(code).toBe(0);
    expect(requests).toEqual([]);
    expect(agentRecord().id).toBeNull();
    expect(out.join('\n')).toContain('would declare the agent "billing-agent"');
  });

  it('refuses a plan that breaks a rule before it sends anything, and names the rule', async () => {
    const plan = structuredClone(FIXTURE_PLAN) as unknown as { policies: Json[] };
    plan.policies[1] = { ...plan.policies[1], mode: 'sometimes' };
    writeFileSync(planFile, JSON.stringify(plan));
    const { code, err } = await run([]);
    expect(code).toBe(2);
    expect(err.join('\n')).toContain(
      'action.arguments.policies[1].policy.config.mode must be one of'
    );
    expect(requests).toEqual([]);
  });

  it('stops without a user token, and on a service principal token, before any request', async () => {
    const none = await run([], { NC_PROPOSER_TOKEN: undefined });
    expect(none.code).toBe(3);
    expect(none.err.join('\n')).toContain('NC_PROPOSER_TOKEN is not set');
    const service = await run([], { NC_PROPOSER_TOKEN: SERVICE_TOKEN });
    expect(service.code).toBe(3);
    expect(service.err.join('\n')).toContain('service principal token');
    const agentKind = `h.${Buffer.from(JSON.stringify({ principal_kind: 'agent' })).toString('base64url')}.s`;
    const agent = await run([], { NC_PROPOSER_TOKEN: agentKind });
    expect(agent.code).toBe(3);
    expect(agent.err.join('\n')).toContain('agent principal token');
    expect(requests).toEqual([]);
  });

  it('exits 3, not 2, when the deployment answers not_a_user', async () => {
    answer = ({ path }) =>
      path === '/v1/approvals'
        ? {
            status: 422,
            body: { type: 'https://x/problems/proposal_refused', code: 'not_a_user' },
          }
        : { status: 201, body: { data: { id: 'agent_42' } } };
    const { code, err } = await run([]);
    expect(code).toBe(3);
    expect(err.join('\n')).toContain('not_a_user');
  });

  it.each([
    ['rejected_duplicate', { rejected_approval_id: 'appr_0' }, 'rejected this same proposal'],
    ['continuation_conflict', {}, 'another continuation'],
  ])('exits 2 and explains a 409 %s', async (code, extra, message) => {
    answer = ({ path }) =>
      path === '/v1/approvals'
        ? { status: 409, body: { type: `https://x/problems/${code}`, ...extra } }
        : { status: 201, body: { data: { id: 'agent_42' } } };
    const result = await run([]);
    expect(result.code).toBe(2);
    expect(result.err.join('\n')).toContain(`Refused (${code})`);
    expect(result.err.join('\n')).toContain(message);
  });

  it('does not read NC_TOKEN, the agent token, in place of the proposer token', async () => {
    const { code } = await run([], { NC_PROPOSER_TOKEN: undefined, NC_TOKEN: USER_TOKEN });
    expect(code).toBe(3);
    expect(requests).toEqual([]);
  });

  it('prints the code and the member of a refusal, exit 2, and keeps the agent id for the next run', async () => {
    answer = ({ path }) =>
      path === '/v1/agents'
        ? { status: 201, body: { data: { id: 'agent_42' } } }
        : {
            status: 422,
            body: {
              type: 'https://x.test/problems/proposal_refused',
              code: 'principal_bound',
              member: 'action.arguments.agent.principal_id',
              detail: 'The service principal is already bound to another agent.',
            },
          };
    const { code, err } = await run([]);
    expect(code).toBe(2);
    expect(err.join('\n')).toContain(
      'Refused (principal_bound) at action.arguments.agent.principal_id: The service principal is already bound'
    );
    expect(agentRecord().id).toBe('agent_42');
  });

  it('separates a deployment that does not apply proposals from a plan it refused', async () => {
    answer = ({ path }) =>
      path === '/v1/agents'
        ? { status: 201, body: { data: { id: 'agent_42' } } }
        : { status: 422, body: { type: 'https://x.test/problems/approval_unroutable' } };
    const { code, err } = await run([]);
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('does not apply policy-set proposals (approval_unroutable)');
  });

  it('maps a rejected token to 3, a forbidden one and a server failure to 1', async () => {
    answer = () => ({ status: 401, body: { type: 'https://x.test/problems/unauthorized' } });
    expect((await run([])).code).toBe(3);
    answer = () => ({ status: 403, body: { type: 'https://x.test/problems/forbidden' } });
    expect((await run([])).code).toBe(1);
    answer = () => ({ status: 503, body: { type: 'https://x.test/problems/service_unavailable' } });
    expect((await run([])).code).toBe(1);
    expect(agentRecord().id).toBeNull();
  });

  it('refuses a missing plan, a missing agent file and an unnamed agent, exit 2', async () => {
    expect((await run(['--plan', join(project, 'nope.json')])).code).toBe(2);
    writeFileSync(agentFile(), JSON.stringify({ name: '', id: null }));
    expect((await run([])).err.join('\n')).toContain('has neither an id nor a name');
    rmSync(agentFile());
    expect((await run([])).err.join('\n')).toContain("run the skill's apply.mjs first");
    expect(await propose.main([], {})).toBe(2);
    expect(requests).toEqual([]);
  });

  it('wires the worker template to stop and say so when the resumer fails fatally, or fails to start', () => {
    // Importing the template would start a worker, so the wiring is read from its source.
    const worker = readFileSync(join(TEMPLATES, 'worker.ts'), 'utf8');
    expect(worker).toMatch(/function fatal[\s\S]*say\('worker_fatal'[\s\S]*process\.exit\(1\)/);
    expect(worker).toMatch(/onFatal: fatal/);
    expect(worker).toMatch(/main\(\)\.catch\(fatal\)/);
  });

  it('builds every TypeScript template as CommonJS: no top-level await, so a project without "type": "module" runs them', () => {
    for (const file of listTemplateFiles(TEMPLATES).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(join(TEMPLATES, file), 'utf8');
      expect(() => transformSync(source, { loader: 'ts', format: 'cjs' }), file).not.toThrow();
    }
    // The check bites: the form the worker used to take does not build as CommonJS.
    expect(() =>
      transformSync('const governance = await Promise.resolve(1);\n', {
        loader: 'ts',
        format: 'cjs',
      })
    ).toThrow(/Top-level await/);
  });

  it('runs as a command: --dry-run prints the proposal and exits 0', () => {
    const result = spawnSync(
      'node',
      [PROPOSE, '--project', project, '--plan', planFile, '--dry-run'],
      {
        encoding: 'utf8',
      }
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'Policy for this agent on mcp:tracker:search: ask (tightening)'
    );
  });

  it('has a mode for every side-effect level: the ask row names external and admin, and the how-to says the same', () => {
    const skill = readFileSync(join(SKILL, 'SKILL.md'), 'utf8');
    const row = skill.split('\n').find((line) => line.includes('`ask`') && line.startsWith('   |'));
    expect(row).toMatch(/every `external` or `admin` tool/);
    const howTo = readFileSync(join(ROOT, 'docs/how-to/govern-a-langgraph-agent.md'), 'utf8');
    expect(howTo.replace(/\s+/g, ' ')).toMatch(
      /`ask` for everything else \(an `external` or `admin` tool/
    );
  });

  it('ships only files the skill describes: two scripts, four templates and SKILL.md', () => {
    expect(readdirSync(join(SKILL, 'scripts')).sort()).toEqual(['apply.mjs', 'propose.mjs']);
    expect(listTemplateFiles(TEMPLATES)).toEqual([
      'agent.json',
      'governance.ts',
      'log.ts',
      'worker.ts',
    ]);
    expect(existsSync(join(SKILL, 'SKILL.md'))).toBe(true);
  });
});
