import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { nativeHarness } from './integration/harness.ts';
import { applyEdits, modify, parse } from 'jsonc-parser';

// Real V1 configuration loading, provider dispatch, and cache invalidation; only the remote model is synthetic.
test(
  'OpenCode composes ordered groups and prompts from dedicated settings and dispatches changes after reload',
  { timeout: 120_000 },
  async (t) => {
    const harness = await nativeHarness(t, 'composition');
    const { configRoot, project, installed, requests, api } = harness;
    await mkdir(join(configRoot, 'agents'), { recursive: true });
    await mkdir(join(configRoot, 'shared-prompts'));
    await mkdir(join(configRoot, 'skills/included-skill'), { recursive: true });
    const model = {
      name: 'Synthetic model',
      limit: { context: 8192, output: 256 },
      variants: { low: { reasoningEffort: 'low' }, high: { reasoningEffort: 'high' } },
    };
    const config = {
      plugin: [installed.directory],
      model: 'fixture/alpha',
      small_model: 'fixture/alpha',
      default_agent: 'worker',
      enabled_providers: ['fixture'],
      provider: {
        fixture: {
          name: 'Fixture',
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: harness.providerURL, apiKey: 'synthetic-test-key' },
          models: { alpha: model, beta: model },
        },
      },
      agent: {
        pinned: { mode: 'subagent', groups: ['base', 'developers'], model: 'fixture/alpha', variant: 'high' },
        'main-follower': { mode: 'primary', groups: ['primary'], prompt: 'Reply briefly.' },
        'small-follower': { mode: 'primary', groups: ['small'], prompt: 'Reply briefly.' },
        compaction: { groups: ['base'] },
      },
    };
    const composer = {
      sourceDirectories: { shared: './shared-prompts', 'agent-prompts': './shared-prompts' },
      agent: {
        modelPresets: { balanced: { model: 'fixture/alpha', variant: 'low' } },
        prompts: { defaults: { append: ['{{include:@shared/default.md}}'] } },
        groups: {
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
    await harness.start();
    interface Agent {
      name: string;
      model: { providerID: string; modelID: string };
      variant?: string;
      options: Record<string, unknown>;
      prompt?: string;
    }
    interface Message {
      info: { modelID: string; error?: unknown };
      parts: {
        type: string;
        text?: string;
        tool?: string;
        state?: {
          status: string;
          title?: string;
          output?: string;
          metadata?: { name?: string; dir?: string; truncated?: boolean };
        };
      }[];
    }
    const agents = await api<Agent[]>('/agent');
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
    assert.equal(beforeReload.model, 'alpha');
    assert.equal(beforeReload.reasoning_effort, 'low');
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
    assert.equal(reloadedRequest.model, 'beta');
    assert.equal(reloadedRequest.reasoning_effort, 'high');
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
    // Overlay only Composer settings; native JSONC, project config and Markdown stay byte-identical.
    const nativePaths = [
      join(configRoot, 'opencode.jsonc'),
      join(project, 'opencode.json'),
      join(configRoot, 'agents/worker.md'),
    ];
    const readNative = () => Promise.all(nativePaths.map((path) => readFile(path, 'utf8')));
    let nativeBytes: string[];
    const overlaySettings = await readFile(settingsPath, 'utf8');
    await writeFile(settingsPath, applyEdits(overlaySettings, modify(overlaySettings, ['model'], 'fixture/beta', {})));
    // Use the existing token reload to invalidate the host's cached global configuration.
    await reload();
    nativeBytes = await readNative();
    let effective = await api<{ model: string; small_model: string }>('/config');
    assert.equal(effective.model, 'fixture/beta');
    assert.equal(effective.small_model, 'fixture/alpha');
    assert.equal((await api<Agent[]>('/agent')).find((agent) => agent.name === 'main-follower')?.model.modelID, 'beta');
    assert.equal((await request('main-follower')).info.modelID, 'beta');
    assert.equal((await request('small-follower')).info.modelID, 'alpha');
    assert.deepEqual(await readNative(), nativeBytes);
    const mainOnly = await readFile(settingsPath, 'utf8');
    await writeFile(settingsPath, applyEdits(mainOnly, modify(mainOnly, ['small_model'], 'fixture/beta', {})));
    // Use the existing token reload to invalidate the host's cached global configuration.
    await reload();
    nativeBytes = await readNative();
    effective = await api('/config');
    assert.equal(effective.small_model, 'fixture/beta');
    assert.equal((await request('small-follower')).info.modelID, 'beta');
    const overlayAgents = await api<Agent[]>('/agent');
    assert.equal(overlayAgents.find((agent) => agent.name === 'pinned')?.model.modelID, 'alpha');
    const selectedSession = await api<{ id: string }>('/session', { title: 'Explicit session model' });
    const selected = await api<Message>(`/session/${selectedSession.id}/message`, {
      agent: 'main-follower',
      model: { providerID: 'fixture', modelID: 'alpha' },
      parts: [{ type: 'text', text: 'Reply with verified.' }],
    });
    assert.equal(selected.info.error, undefined);
    assert.equal(selected.info.modelID, 'alpha');
    assert.deepEqual(await readNative(), nativeBytes);
    await writeFile(settingsPath, overlaySettings);
    // Use the existing token reload to invalidate the host's cached global configuration.
    await reload();
    nativeBytes = await readNative();
    effective = await api('/config');
    assert.equal(effective.model, 'fixture/alpha');
    assert.equal(effective.small_model, 'fixture/alpha');
    assert.equal((await request('main-follower')).info.modelID, 'alpha');
    assert.equal((await request('small-follower')).info.modelID, 'alpha');
    assert.deepEqual(await readNative(), nativeBytes);
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
