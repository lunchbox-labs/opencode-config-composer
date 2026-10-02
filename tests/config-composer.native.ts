import {
  type PermissionPolicy,
  composePermissions,
  explainPermission,
} from '../src/config-composer/composition/permissions.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { installPackage } from './install-package.ts';
import { applyEdits, modify, parse } from 'jsonc-parser';

// Real V1 configuration loading, provider dispatch, and cache invalidation; only the remote model is synthetic.
test(
  'OpenCode composes ordered groups and prompts from dedicated settings and dispatches changes after reload',
  { timeout: 120_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'opencode-config-composer-native-'));
    const runtime: { child?: ChildProcess; exited?: Promise<unknown> } = {};
    t.after(async () => {
      runtime.child?.kill();
      const forceStop = globalThis.setTimeout(() => runtime.child?.kill('SIGKILL'), 3000);
      forceStop.unref();
      await runtime.exited;
      globalThis.clearTimeout(forceStop);
      runtime.child?.stdout?.destroy();
      runtime.child?.stderr?.destroy();
      await rm(root, { recursive: true, force: true });
    });
    const configRoot = join(root, 'config', 'opencode');
    const project = join(root, 'project');
    await mkdir(join(configRoot, 'agents'), { recursive: true });
    await mkdir(join(configRoot, 'shared-prompts'));
    await mkdir(join(configRoot, 'skills/included-skill'), { recursive: true });
    await mkdir(project);
    const installed = await installPackage(configRoot);

    const requests: Record<string, unknown>[] = [];
    const provider = createServer((request, response) => {
      const reply = async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          assert.ok(Buffer.isBuffer(chunk));
          chunks.push(chunk);
        }
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString());
        assert.ok(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed));
        const body = parsed as Record<string, unknown>;
        requests.push(body);
        const skillRequested = JSON.stringify(body.messages).includes('Load included-skill now.');
        const toolReturned =
          Array.isArray(body.messages) &&
          body.messages.some(
            (message: unknown) =>
              message !== null && typeof message === 'object' && 'role' in message && message.role === 'tool',
          );
        const callSkill = skillRequested && !toolReturned;
        const base = { id: 'synthetic-response', model: body.model, created: 1 };
        const streaming = Boolean(body.stream);
        if (streaming) {
          response.writeHead(200, { 'Content-Type': 'text/event-stream' });
          response.write(
            `data: ${JSON.stringify({
              ...base,
              object: 'chat.completion.chunk',
              choices: [
                {
                  index: 0,
                  delta: callSkill
                    ? {
                        role: 'assistant',
                        tool_calls: [
                          {
                            index: 0,
                            id: 'fixture-skill',
                            type: 'function',
                            function: { name: 'skill', arguments: JSON.stringify({ name: 'included-skill' }) },
                          },
                        ],
                      }
                    : { role: 'assistant', content: 'verified' },
                  finish_reason: null,
                },
              ],
            })}\n\n`,
          );
          response.end(
            `data: ${JSON.stringify({
              ...base,
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: {}, finish_reason: callSkill ? 'tool_calls' : 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            })}\n\ndata: [DONE]\n\n`,
          );
        } else {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(
            JSON.stringify({
              ...base,
              object: 'chat.completion',
              choices: [{ index: 0, message: { role: 'assistant', content: 'verified' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
          );
        }
      };
      reply().catch((error: unknown) => {
        response.statusCode = 500;
        response.end(String(error));
      });
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    t.after(() => {
      provider.closeAllConnections();
      provider.close();
    });
    const address = provider.address();
    assert.ok(address !== null && typeof address !== 'string');
    const model = {
      name: 'Synthetic model',
      limit: { context: 8192, output: 256 },
      variants: { low: { reasoningEffort: 'low' }, high: { reasoningEffort: 'high' } },
    };
    const permissionCases: { name: string; layers: PermissionPolicy[]; action: 'allow' | 'deny' }[] = [
      {
        name: 'later-allow',
        layers: [{ skill: { 'included-*': 'deny' } }, { skill: { '*': 'allow' } }],
        action: 'allow',
      },
      {
        name: 'later-deny',
        layers: [{ skill: { '*': 'allow' } }, { skill: { 'included-*': 'deny' } }],
        action: 'deny',
      },
      { name: 'outer-allow', layers: [{ skill: 'deny' }, { '*': 'allow' }], action: 'allow' },
      {
        name: 'retained-deny',
        layers: [{ skill: { 'included-*': 'deny' }, '*': 'allow' }, { skill: { 'other-*': 'allow' } }],
        action: 'deny',
      },
      {
        name: 'reinsert-allow',
        layers: [{ skill: { 'included-*': 'deny', '*': 'deny' } }, { skill: { 'included-*': 'allow' } }],
        action: 'allow',
      },
      { name: 'replace-allow', layers: [{ skill: 'deny' }, { skill: { 'included-*': 'allow' } }], action: 'allow' },
    ];
    const config = {
      plugin: [installed.directory],
      permission: { skill: { 'included-*': 'deny' } } satisfies PermissionPolicy,
      model: 'fixture/alpha',
      small_model: 'fixture/alpha',
      default_agent: 'worker',
      enabled_providers: ['fixture'],
      provider: {
        fixture: {
          name: 'Fixture',
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'synthetic-test-key' },
          models: { alpha: model, beta: model },
        },
      },
      agent: {
        ...Object.fromEntries(
          permissionCases.map(({ name, layers }) => [
            name,
            { mode: 'primary', groups: layers.map((_, index) => `${name}-${index}`) },
          ]),
        ),
        pinned: { mode: 'subagent', groups: ['base', 'developers'], model: 'fixture/alpha', variant: 'high' },
        'main-follower': { mode: 'primary', groups: ['primary'], prompt: 'Reply briefly.' },
        'small-follower': { mode: 'primary', groups: ['small'], prompt: 'Reply briefly.' },
        compaction: { groups: ['base'] },
      },
    };
    const composer = {
      sourceDirectories: { shared: './shared-prompts', 'agent-prompts': './shared-prompts' },
      agent: {
        permission: {
          skill: { '*': 'allow' },
          task: { '*': 'allow' },
          webfetch: 'allow',
          question: 'ask',
          todowrite: 'allow',
          websearch: 'deny',
          doom_loop: 'ask',
        } satisfies PermissionPolicy,
        overrides: { build: { permission: { skill: { '*': 'allow' } } } },
        modelPresets: { balanced: { model: 'fixture/alpha', variant: 'low' } },
        prompts: { defaults: { append: ['{{include:@shared/default.md}}'] } },
        groups: {
          ...Object.fromEntries(
            permissionCases.flatMap(({ name, layers }) =>
              layers.map((permission, index) => [`${name}-${index}`, { permission }]),
            ),
          ),
          base: { model: 'fixture/beta', variant: 'high' },
          developers: { modelRef: 'preset:balanced', prompt: { append: ['GROUP_GUIDANCE'] } },
          primary: { modelRef: 'opencode:model', variant: 'low' },
          small: { modelRef: 'opencode:small_model', variant: 'low' },
        },
      },
      command: {},
      skill: {},
    };
    await writeFile(
      join(configRoot, 'config-composer.jsonc'),
      `// Dedicated settings\n${JSON.stringify(composer, null, 2)}\n`,
    );
    await writeFile(join(configRoot, 'shared-prompts/default.md'), 'GLOBAL_GUIDANCE');
    await writeFile(join(configRoot, 'shared-prompts/worker.md'), 'INITIAL_WORKER_GUIDANCE');
    await writeFile(join(configRoot, 'shared-prompts/skill.md'), 'SKILL_GUIDANCE {{include:@shared/skill-inner.md}}');
    await writeFile(join(configRoot, 'shared-prompts/skill-inner.md'), 'NESTED_SKILL_GUIDANCE');
    await writeFile(
      join(configRoot, 'skills/included-skill/SKILL.md'),
      '---\nname: included-skill\ndescription: Synthetic skill for native composition.\n---\n' +
        'SKILL_BODY_BEFORE\n{{include:@agent-prompts/skill.md}}\nSKILL_BODY_AFTER\n',
    );
    await writeFile(join(configRoot, 'skills/included-skill/notes.txt'), 'Companion resource');
    await writeFile(
      join(configRoot, 'opencode.jsonc'),
      `// Native integration fixture\n${JSON.stringify(config, null, 2)}\n`,
    );
    await writeFile(
      join(configRoot, 'agents/worker.md'),
      '---\nmode: primary\ngroups: [base, developers]\n---\nReply briefly.\n{{include:@shared/worker.md}}\n',
    );
    await writeFile(join(configRoot, 'tui.jsonc'), JSON.stringify({ plugin: [installed.directory] }));
    await writeFile(
      join(project, 'opencode.json'),
      JSON.stringify({ model: 'fixture/beta', small_model: 'fixture/beta' }),
    );
    const nativeBytes = await readFile(join(configRoot, 'opencode.jsonc'), 'utf8');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_STATE_HOME: join(root, 'state'),
      XDG_CACHE_HOME: join(root, 'cache'),
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1',
      OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: 'true',
      OPENCODE_TEST_HOME: root,
      OPENCODE_CONFIG: '',
      OPENCODE_CONFIG_CONTENT: '',
      OPENCODE_SERVER_PASSWORD: '',
      OPENCODE_DB: join(root, 'db.sqlite'),
    };
    delete env.OPENCODE_CONFIG_DIR;
    delete env.OPENCODE_DISABLE_PROJECT_CONFIG;
    const child = spawn(
      process.env.OPENCODE_BIN ?? 'opencode',
      ['serve', '--hostname', '127.0.0.1', '--port', '0', '--print-logs'],
      { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    runtime.child = child;
    runtime.exited = once(child, 'exit').catch(() => undefined);
    let output = '';
    let launchError: Error | undefined;
    child.on('error', (error) => {
      launchError = error;
    });
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString();
    });
    child.stderr.on('data', (data: Buffer) => {
      output += data.toString();
    });
    let baseURL: string | undefined;
    for (let attempt = 0; attempt < 200; attempt++) {
      if (launchError !== undefined) {
        throw launchError;
      }
      baseURL = /http:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0];
      if (baseURL !== undefined) {
        break;
      }
      if (child.exitCode !== null) {
        throw new Error(`OpenCode exited: ${output}`);
      }
      await setTimeout(100);
    }
    assert.ok(baseURL !== undefined && baseURL.length > 0, `OpenCode did not start: ${output}`);
    const api = async <T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> => {
      const response = await fetch(`${baseURL}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'x-opencode-directory': project },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      }).catch((error: unknown) => {
        throw new Error(`${path}: ${String(error)}\n${output.slice(-6000)}`);
      });
      assert.ok(response.ok, `${path}: ${await response.clone().text()}`);
      const data: unknown = await response.json();
      return data as T;
    };
    interface Agent {
      name: string;
      model: { providerID: string; modelID: string };
      variant?: string;
      options: Record<string, unknown>;
      prompt?: string | null;
      permission: { permission: string; pattern: string; action: string }[];
    }
    interface Message {
      info: { modelID: string; error?: unknown };
      parts: {
        type: string;
        text?: string;
        tool?: string;
        state?: {
          status: string;
          error?: string;
          title?: string;
          output?: string;
          metadata?: { name?: string; dir?: string; truncated?: boolean };
        };
      }[];
    }
    const agents = await api<Agent[]>('/agent');
    const effective = await api<{
      permission: PermissionPolicy;
      agent: Record<string, { permission?: PermissionPolicy; prompt?: string }>;
    }>('/config');
    assert.equal(explainPermission(effective.permission, 'skill', 'included-skill').action, 'allow');
    assert.equal(effective.permission.webfetch, 'allow');
    assert.equal(effective.permission.question, 'ask');
    assert.equal(effective.permission.todowrite, 'allow');
    assert.equal(effective.permission.websearch, 'deny');
    assert.equal(effective.permission.doom_loop, 'ask');
    assert.equal(effective.agent.build.prompt, undefined, 'permission-only built-in override does not invent a prompt');
    assert.ok(
      agents
        .find((agent) => agent.name === 'build')
        ?.permission.some((rule) => rule.permission === 'task' && rule.action === 'allow') === true,
      'enabled delegation inherits Composer defaults',
    );
    for (const fixture of permissionCases) {
      const policy = composePermissions([config.permission, composer.agent.permission, ...fixture.layers]);
      // /config's response schema enumerates known keys first; /agent exposes
      // the ordered rules actually used by native permission evaluation.
      assert.deepEqual(effective.agent[fixture.name].permission, policy);
      const emitted = Object.entries(policy).flatMap(([permission, value]) =>
        Object.entries(typeof value === 'string' ? { '*': value } : value).map(([pattern, action]) => ({
          permission,
          pattern,
          action,
        })),
      );
      const actual = agents.find((agent) => agent.name === fixture.name)?.permission;
      assert.ok(actual !== undefined);
      assert.deepEqual(
        actual.filter((rule) => rule.permission !== 'external_directory').slice(-emitted.length),
        emitted,
      );
      assert.equal(explainPermission(policy, 'skill', 'included-skill').action, fixture.action);
      const session = await api<{ id: string }>('/session', { title: `Permission ${fixture.name}` });
      const result = await api<Message>(`/session/${session.id}/message`, {
        agent: fixture.name,
        parts: [{ type: 'text', text: 'Load included-skill now.' }],
      });
      assert.equal(result.info.error, undefined, JSON.stringify(result.info.error));
      const messages = await api<Message[]>(`/session/${session.id}/message`);
      const tool = messages.flatMap((message) => message.parts).find((part) => part.tool === 'skill');
      assert.equal(
        tool?.state?.status,
        fixture.action === 'allow' ? 'completed' : 'error',
        `native evaluator: ${fixture.name}`,
      );
      if (fixture.action === 'deny') {
        assert.match(tool.state.error ?? '', /rule which prevents you from using this specific tool call/);
      }
    }
    assert.equal(await readFile(join(configRoot, 'opencode.jsonc'), 'utf8'), nativeBytes);
    for (const name of ['plan', 'build']) {
      const rules = agents.find((agent) => agent.name === name)?.permission;
      assert.ok(rules !== undefined);
      assert.equal(
        rules.findLast((rule) => rule.permission === 'skill')?.action,
        'allow',
        `${name} inherits the global policy`,
      );
      assert.equal(
        agents.find((agent) => agent.name === name)?.prompt ?? undefined,
        undefined,
        `${name} has no synthesized prompt`,
      );
    }
    const worker = agents.find((agent) => agent.name === 'worker');
    assert.ok(worker !== undefined);
    assert.deepEqual(worker.model, { providerID: 'fixture', modelID: 'alpha' });
    assert.equal(worker.variant, 'low');
    assert.deepEqual(worker.options.groups, ['base', 'developers']);
    assert.match(worker.prompt ?? '', /INITIAL_WORKER_GUIDANCE/);
    assert.match(worker.prompt ?? '', /GROUP_GUIDANCE/);
    assert.match(worker.prompt ?? '', /GLOBAL_GUIDANCE/);
    const compactionPrompt = agents.find((agent) => agent.name === 'compaction')?.prompt;
    assert.ok(typeof compactionPrompt === 'string' && compactionPrompt.length > 0);
    assert.ok(!compactionPrompt.includes('GLOBAL_GUIDANCE'), 'preserve the promptless built-in configuration');
    for (const name of ['main-follower', 'small-follower']) {
      assert.equal(
        agents.find((agent) => agent.name === name)?.model.modelID,
        'beta',
        'use project defaults, not global file values',
      );
    }
    const providers = await api<{ providers: { id: string; models: Record<string, unknown> }[] }>('/config/providers');
    assert.ok(Boolean(providers.providers.find((item) => item.id === 'fixture')?.models.beta));
    const request = async (agent = 'worker') => {
      const session = await api<{ id: string }>('/session', { title: 'Synthetic integration check' });
      const result = await api<Message>(`/session/${session.id}/message`, {
        agent,
        parts: [{ type: 'text', text: 'Reply with verified.' }],
      });
      assert.equal(result.info.error, undefined, JSON.stringify(result.info.error));
      assert.ok(result.parts.some((part) => part.type === 'text' && part.text === 'verified'));
      return result;
    };
    assert.equal((await request()).info.modelID, 'alpha');
    const beforeReload = requests.find((body) => JSON.stringify(body).includes('INITIAL_WORKER_GUIDANCE'));
    assert.ok(beforeReload !== undefined, 'send expanded prompt text to the provider');
    assert.ok(!JSON.stringify(beforeReload).includes('{{include:'), 'never send unresolved directives');
    const nativeConfig = await api<{ references?: Record<string, unknown> }>('/config');
    assert.equal(nativeConfig.references?.['agent-prompts'], undefined, 'sources are not native prompt references');
    const skillSession = await api<{ id: string }>('/session', { title: 'Native skill composition check' });
    const skillResult = await api<Message>(`/session/${skillSession.id}/message`, {
      agent: 'worker',
      parts: [{ type: 'text', text: 'Load included-skill now.' }],
    });
    assert.equal(skillResult.info.error, undefined, JSON.stringify(skillResult.info.error));
    assert.ok(skillResult.parts.some((part) => part.type === 'text' && part.text === 'verified'));
    const skillMessages = await api<Message[]>(`/session/${skillSession.id}/message`);
    const skillPart = skillMessages.flatMap((message) => message.parts).find((part) => part.tool === 'skill');
    assert.equal(skillPart?.state?.status, 'completed', 'run the native skill tool before returning to the model');
    assert.equal(skillPart.state.title, 'Loaded skill: included-skill');
    assert.deepEqual(skillPart.state.metadata, {
      name: 'included-skill',
      dir: join(configRoot, 'skills/included-skill'),
      truncated: false,
    });
    const skillOutput = skillPart.state.output;
    assert.ok(typeof skillOutput === 'string');
    assert.ok(skillOutput.startsWith('<skill_content name="included-skill">\n# Skill: included-skill\n\n'));
    assert.ok(skillOutput.includes('SKILL_BODY_BEFORE\nSKILL_GUIDANCE NESTED_SKILL_GUIDANCE\nSKILL_BODY_AFTER'));
    assert.ok(skillOutput.includes('Base directory for this skill:'));
    assert.ok(skillOutput.includes('<skill_files>'));
    assert.ok(skillOutput.includes(join(configRoot, 'skills/included-skill/notes.txt')));
    assert.ok(skillOutput.endsWith('</skill_content>'));
    assert.ok(!skillOutput.includes('{{include:'), 'expand directives in the native skill result');
    assert.ok(!skillOutput.includes('GLOBAL_GUIDANCE'), 'agent prompt defaults do not wrap skill output');
    const skillRequest = requests.find((body) => JSON.stringify(body.messages).includes('<skill_content'));
    assert.ok(skillRequest !== undefined && Array.isArray(skillRequest.messages));
    const toolMessage = skillRequest.messages.find(
      (message: unknown) =>
        message !== null && typeof message === 'object' && 'role' in message && message.role === 'tool',
    ) as { content?: unknown } | undefined;
    assert.equal(toolMessage?.content, skillOutput, 'the next provider request receives the native expanded result');
    assert.ok(!JSON.stringify(skillRequest).includes('{{include:'), 'never send raw skill directives to the provider');
    assert.equal((await request('main-follower')).info.modelID, 'beta');
    assert.equal((await request('small-follower')).info.modelID, 'beta');
    const settingsPath = join(configRoot, 'config-composer.jsonc');
    const settingsBefore = await readFile(settingsPath, 'utf8');
    await writeFile(
      settingsPath,
      applyEdits(
        settingsBefore,
        modify(
          settingsBefore,
          ['agent', 'modelPresets', 'balanced'],
          {
            model: 'fixture/beta',
            variant: 'high',
          },
          {},
        ),
      ),
    );
    const savedSettings = parse(await readFile(settingsPath, 'utf8')) as typeof composer;
    assert.deepEqual(savedSettings.agent.groups.developers, composer.agent.groups.developers);
    await writeFile(join(configRoot, 'shared-prompts/worker.md'), 'RELOADED_WORKER_GUIDANCE');
    const reload = () =>
      api(
        '/global/config',
        {
          plugin: [[installed.directory, { reloadToken: randomUUID() }]],
        },
        'PATCH',
      );
    await reload();
    let refreshed = agents;
    for (let attempt = 0; attempt < 100; attempt++) {
      refreshed = await api<Agent[]>('/agent');
      if (refreshed.find((agent) => agent.name === 'worker')?.model.modelID === 'beta') {
        break;
      }
      await setTimeout(100);
    }
    assert.equal(refreshed.find((agent) => agent.name === 'worker')?.model.modelID, 'beta');
    assert.equal(refreshed.find((agent) => agent.name === 'worker')?.variant, 'high');
    assert.equal(refreshed.find((agent) => agent.name === 'pinned')?.model.modelID, 'alpha');
    assert.match(refreshed.find((agent) => agent.name === 'worker')?.prompt ?? '', /RELOADED_WORKER_GUIDANCE/);
    assert.equal(
      refreshed.find((agent) => agent.name === 'worker')?.prompt?.includes('INITIAL_WORKER_GUIDANCE'),
      false,
    );
    assert.equal((await request()).info.modelID, 'beta');
    const reloadedRequest = requests.find((body) => JSON.stringify(body).includes('RELOADED_WORKER_GUIDANCE'));
    assert.ok(reloadedRequest !== undefined, 'reread fragments after token reload');
    assert.ok(!JSON.stringify(reloadedRequest).includes('INITIAL_WORKER_GUIDANCE'));
    await writeFile(
      join(project, 'opencode.json'),
      JSON.stringify({ model: 'fixture/alpha', small_model: 'fixture/alpha' }),
    );
    await reload();
    refreshed = await api<Agent[]>('/agent');
    for (const name of ['main-follower', 'small-follower']) {
      assert.equal(refreshed.find((agent) => agent.name === name)?.model.modelID, 'alpha');
      assert.equal((await request(name)).info.modelID, 'alpha');
    }
    assert.equal(refreshed.find((agent) => agent.name === 'worker')?.model.modelID, 'beta');
    assert.ok(requests.some((body) => body.model === 'alpha'));
    assert.ok(requests.some((body) => body.model === 'beta'));
    assert.ok(
      requests.every(
        (body) =>
          !/agent_group|modelRef|modelPresets|configFile|promptSources|sourceDirectories/.test(JSON.stringify(body)),
      ),
    );
    assert.match(await readFile(join(configRoot, 'opencode.jsonc'), 'utf8'), /^\/\/ Native integration fixture/);
    assert.match(await readFile(join(configRoot, 'config-composer.jsonc'), 'utf8'), /^\/\/ Dedicated settings/);
  },
);
