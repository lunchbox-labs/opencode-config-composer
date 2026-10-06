import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { installPackage } from './install-package.ts';
import type * as Storage from '../src/config-composer/storage.ts';
import { nativeAgentNames } from '../src/config-composer/composition/runtime.ts';

// The native registry is the oracle: neither config debug output nor a copied built-in prompt is used.
test(
  'activated profiles overlay native built-ins and imported custom agents without shadow declarations',
  { timeout: 120_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'composer-canonical-native-'));
    const configRoot = join(root, 'config/opencode');
    const project = join(root, 'project');
    await mkdir(configRoot, { recursive: true });
    await mkdir(join(project, '.opencode'), { recursive: true });
    await mkdir(join(root, 'library/checks'), { recursive: true });
    const installed = await installPackage(configRoot);
    const { loadSnapshot, planChange, savePlan } = (await import(
      pathToFileURL(join(installed.directory, 'dist/config-composer/storage.js')).href
    )) as typeof Storage;
    const projectJson = JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      agent: { 'project-json': { model: 'fixture/project-pin', prompt: 'Native project JSON body.' } },
    });
    const projectMarkdown =
      '---\ndescription: Existing project agent\ngroups: [work]\n---\nNative project Markdown body.';
    await writeFile(join(project, 'opencode.jsonc'), projectJson);
    await mkdir(join(project, '.opencode/agent'));
    await writeFile(
      join(project, '.opencode/agent/project-md.md'),
      '---\nmodel: fixture/discarded\n---\nObsolete duplicate body.',
    );
    await mkdir(join(root, '.opencode/agents'), { recursive: true });
    await writeFile(
      join(root, '.opencode/agents/ancestor.md'),
      '---\ndescription: Ancestor agent outside Git\n---\nAncestor body.',
    );
    await mkdir(join(project, '.opencode/agents'));
    await writeFile(join(project, '.opencode/agents/project-md.md'), projectMarkdown);
    await writeFile(
      join(root, 'library/reviewer.md'),
      '---\ndescription: Synthetic reviewer\nmode: subagent\ngroups: [work]\npermission:\n  edit: deny\n---\nNative custom body.',
    );
    await writeFile(
      join(root, 'library/checks/SKILL.md'),
      '---\nname: checks\ndescription: Synthetic checks\n---\nOn-demand native skill.',
    );
    await writeFile(
      join(root, 'library/definitions.jsonc'),
      JSON.stringify({
        components: {
          agents: { reviewer: { file: './reviewer.md' } },
          skills: { checks: { file: './checks/SKILL.md' } },
          commands: { review: { template: 'Review $ARGUMENTS', agent: 'reviewer' } },
        },
        componentGroups: {
          work: {
            agents: [...nativeAgentNames, 'project-json', 'project-md', 'ancestor'],
            commands: ['review'],
            skills: ['checks'],
            configuration: { model: 'fixture/alpha' },
          },
          later: { agents: ['build'], configuration: { model: 'fixture/beta' } },
        },
        profiles: {
          base: { layers: [{ componentGroup: 'work' }] },
          work: { extends: 'base', layers: [{ componentGroup: 'later' }] },
        },
      }),
    );
    await writeFile(
      join(configRoot, 'config-composer.jsonc'),
      JSON.stringify({ imports: [join(root, 'library/definitions.jsonc')], activeProfiles: [] }),
    );
    await writeFile(
      join(configRoot, 'opencode.json'),
      JSON.stringify({
        plugin: [installed.directory],
        model: 'fixture/alpha',
        enabled_providers: [],
        agent: { plan: { model: 'fixture/pinned' } },
      }),
    );
    await assert.rejects(loadSnapshot(configRoot, project, undefined, project, '/'), /Duplicate native agent identity/);
    await rm(join(project, '.opencode/agent/project-md.md'));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_STATE_HOME: join(root, 'state'),
      XDG_CACHE_HOME: join(root, 'cache'),
      OPENCODE_TEST_HOME: root,
      OPENCODE_DB: join(root, 'db.sqlite'),
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1',
      OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: 'true',
      OPENCODE_CONFIG: '',
      OPENCODE_CONFIG_CONTENT: '',
      OPENCODE_SERVER_PASSWORD: '',
    };
    delete env.OPENCODE_CONFIG_DIR;
    const child = spawn(
      process.env.OPENCODE_BIN ?? 'opencode',
      ['serve', '--hostname', '127.0.0.1', '--port', '0', '--print-logs'],
      { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const exited = once(child, 'exit').catch(() => undefined);
    t.after(async () => {
      child.kill();
      const force = globalThis.setTimeout(() => child.kill('SIGKILL'), 3000);
      force.unref();
      await exited;
      globalThis.clearTimeout(force);
      child.stdout.destroy();
      child.stderr.destroy();
      await rm(root, { recursive: true, force: true });
    });
    let logs = '';
    child.stdout.on('data', (data: Buffer) => {
      logs += data.toString();
    });
    child.stderr.on('data', (data: Buffer) => {
      logs += data.toString();
    });
    let url: string | undefined;
    for (let i = 0; i < 200; i++) {
      url = /http:\/\/127\.0\.0\.1:\d+/.exec(logs)?.[0];
      if (url !== undefined) {
        break;
      }
      if (child.exitCode !== null) {
        throw new Error(logs);
      }
      await setTimeout(100);
    }
    assert.ok(url !== undefined, logs);
    async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
      const response = await fetch(`${url}${path}`, {
        method,
        headers: { 'x-opencode-directory': project, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
      assert.ok(response.ok, `${path}: ${await response.clone().text()}\n${logs.slice(-3000)}`);
      return (await response.json()) as T;
    }
    interface Agent {
      name: string;
      native: boolean;
      prompt?: string | null;
      mode: string;
      hidden?: boolean | null;
      permission: { permission: string; pattern: string; action: string }[];
      options: Record<string, unknown>;
      model?: { providerID: string; modelID: string };
    }
    const baseline = await api<Agent[]>('/agent');
    const conversation = await api<{ id: string; title: string }>('/session', 'POST', {
      title: 'Existing project conversation',
    });
    const snapshot = await loadSnapshot(configRoot, project, undefined, project, '/');
    assert.ok(snapshot.agents.some((agent) => agent.name === 'project-json'));
    assert.ok(snapshot.agents.some((agent) => agent.name === 'project-md'));
    assert.ok(snapshot.agents.some((agent) => agent.name === 'ancestor'));
    assert.equal(snapshot.nativeAgents['project-md'].model, undefined);
    await savePlan(
      planChange(snapshot, { kind: 'membership', agent: 'project-md', groups: ['work', 'editor-created'] }),
    );
    assert.equal(
      (
        (await loadSnapshot(configRoot, project, undefined, project, '/')).config.agent as
          Record<string, unknown> | undefined
      )?.['project-md'],
      undefined,
    );
    assert.equal(await readFile(join(project, 'opencode.jsonc'), 'utf8'), projectJson);
    assert.equal(await readFile(join(project, '.opencode/agents/project-md.md'), 'utf8'), projectMarkdown);
    assert.deepEqual(
      baseline
        .filter((item) => item.native)
        .map((item) => item.name)
        .sort(),
      [...nativeAgentNames].sort(),
      'verify the complete pinned native identity catalog',
    );
    assert.ok(!baseline.some((item) => item.name === 'reviewer'), 'definitions alone do not activate custom agents');
    const local = join(project, '.opencode/config-composer.local.jsonc');
    await writeFile(local, '{"activeProfiles":["work"]}');
    await api('/instance/dispose', 'POST');
    const activated = await api<Agent[]>('/agent');
    for (const before of baseline.filter((item) => item.native)) {
      const after = activated.find((item) => item.name === before.name);
      assert.ok(after !== undefined, before.name);
      assert.equal(after.native, true);
      assert.equal(after.prompt ?? undefined, before.prompt ?? undefined, `preserve ${before.name} native prompt`);
      assert.equal(after.mode, before.mode);
      assert.equal(after.hidden ?? undefined, before.hidden ?? undefined);
      // OpenCode itself grants access to configured native skill directories.
      const skillRule = {
        permission: 'external_directory',
        pattern: `${join(root, 'library/checks')}/*`,
        action: 'allow',
      };
      assert.ok(after.permission.some((rule) => JSON.stringify(rule) === JSON.stringify(skillRule)));
      assert.deepEqual(
        after.permission.filter((rule) => rule.pattern !== skillRule.pattern),
        before.permission,
      );
      assert.deepEqual(after.model, {
        providerID: 'fixture',
        modelID: before.name === 'plan' ? 'pinned' : before.name === 'build' ? 'beta' : 'alpha',
      });
    }
    assert.deepEqual(activated.find((item) => item.name === 'project-json')?.model, {
      providerID: 'fixture',
      modelID: 'project-pin',
    });
    assert.deepEqual(activated.find((item) => item.name === 'project-md')?.model, {
      providerID: 'fixture',
      modelID: 'alpha',
    });
    assert.equal(activated.find((item) => item.name === 'project-md')?.prompt, 'Native project Markdown body.');
    const reviewer = activated.find((item) => item.name === 'reviewer');
    assert.ok(reviewer !== undefined);
    assert.equal(reviewer.mode, 'subagent');
    assert.equal(reviewer.prompt, 'Native custom body.');
    assert.deepEqual(reviewer.model, { providerID: 'fixture', modelID: 'alpha' });
    assert.deepEqual(reviewer.options.groups, ['work']);
    const commands = await api<{ name: string; agent?: string }[]>('/command');
    assert.equal(commands.find((item) => item.name === 'review')?.agent, 'reviewer');
    const skills = await api<{ name: string; location: string }[]>('/skill');
    assert.ok(skills.some((item) => item.name === 'checks' && item.location === join(root, 'library/checks/SKILL.md')));
    await writeFile(local, '{"activeProfiles":[]}');
    await api('/instance/dispose', 'POST');
    const cleared = await api<Agent[]>('/agent');
    assert.deepEqual(cleared, baseline, 'empty local selection restores the exact native registry');
    const retained = await api<{ id: string; title: string }>(`/session/${conversation.id}`);
    assert.equal(retained.id, conversation.id);
    assert.equal(retained.title, conversation.title);
  },
);
