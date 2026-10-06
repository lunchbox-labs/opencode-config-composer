import assert from 'node:assert/strict';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type TestContext, test } from 'node:test';
import { nativeHarness } from './harness.ts';
import { installedEditor } from './editor.ts';

async function fixture(t: TestContext, name: string) {
  const host = await nativeHarness(t, name);
  const model = { name: 'Synthetic regression model', limit: { context: 8192, output: 256 } };
  const config = {
    plugin: [host.installed.directory],
    model: 'fixture/alpha',
    enabled_providers: ['fixture'],
    provider: {
      fixture: {
        npm: '@ai-sdk/openai-compatible',
        options: { baseURL: host.providerURL, apiKey: 'synthetic-test-key' },
        models: { alpha: model, beta: model },
      },
    },
  };
  const configPath = join(host.configRoot, 'opencode.jsonc');
  await writeFile(configPath, JSON.stringify(config));
  const send = async (agent = 'build') => {
    const session = await host.api<{ id: string }>('/session', { title: 'Native regression' });
    const message = await host.api<{ info: { error?: unknown }; parts: { text?: string }[] }>(
      `/session/${session.id}/message`,
      { agent, parts: [{ type: 'text', text: 'Reply with verified.' }] },
    );
    assert.equal(message.info.error, undefined);
    assert.ok(message.parts.some((part) => part.text === 'verified'));
    return host.requests.at(-1)!;
  };
  return { host, config, configPath, send, ...(await installedEditor(host)) };
}

test(
  'project-only composition opens and reloads without an optional shared default',
  { timeout: 120_000 },
  async (t) => {
    const { host, snapshot, reload, send } = await fixture(t, 'project-only-editor');
    await mkdir(join(host.project, '.opencode'), { recursive: true });
    const projectSettings = join(host.project, '.opencode/config-composer.jsonc');
    await writeFile(
      projectSettings,
      JSON.stringify({
        componentGroups: { work: { agents: ['build'], configuration: { model: 'fixture/beta' } } },
        profiles: { work: { layers: [{ componentGroup: 'work' }] } },
        activeProfiles: ['work'],
      }),
    );
    await host.start();
    assert.equal((await send()).model, 'beta', 'runtime accepts the project-only configuration');
    const saved = await snapshot();
    assert.deepEqual(saved.sources.activeProfiles, ['work']);
    await reload(saved);
    assert.equal((await send()).model, 'beta');
    await assert.rejects(readFile(join(host.configRoot, 'config-composer.jsonc')), { code: 'ENOENT' });
  },
);

test(
  'reload rejects an imported directory alias retarget before changing the active configuration',
  { timeout: 120_000 },
  async (t) => {
    const { host, configPath, snapshot, reload, send } = await fixture(t, 'retargeted-import');
    const first = join(host.root, 'first library');
    const second = join(host.root, 'second library');
    const alias = join(host.configRoot, 'library');
    for (const directory of [first, second]) {
      await mkdir(directory);
    }
    const definitions = (model: string) =>
      JSON.stringify({
        componentGroups: { work: { agents: ['build'], configuration: { model } } },
        profiles: { work: { layers: [{ componentGroup: 'work' }] } },
      });
    await writeFile(join(first, 'definitions.jsonc'), definitions('fixture/alpha'));
    await writeFile(join(second, 'definitions.jsonc'), definitions('fixture/beta'));
    const link = (target: string) => symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await link(first);
    await writeFile(
      join(host.configRoot, 'config-composer.jsonc'),
      JSON.stringify({
        imports: ['./library/definitions.jsonc'],
        activeProfiles: ['work'],
      }),
    );
    await host.start();
    assert.equal((await send()).model, 'alpha');
    const saved = await snapshot();
    const configBefore = await readFile(configPath, 'utf8');
    await rm(alias, { recursive: true, force: true });
    await link(second);
    await assert.rejects(reload(saved), /changed|identity|reopen/i);
    assert.equal(await readFile(configPath, 'utf8'), configBefore, 'preflight rejects before writing a reload token');
    assert.equal((await send()).model, 'alpha', 'rejected reload leaves the active instance intact');
    await reload(await snapshot());
    assert.equal((await send()).model, 'beta');
    assert.equal(await readFile(join(first, 'definitions.jsonc'), 'utf8'), definitions('fixture/alpha'));
  },
);

test(
  'same-object hook replay preserves external agent edits while replacing generated prompt and model',
  { timeout: 120_000 },
  async (t) => {
    const { host, config, configPath, send } = await fixture(t, 'generated-agent-replay');
    const definitions = join(host.configRoot, 'definitions.jsonc');
    const component = join(host.configRoot, 'reviewer.md');
    const marker = join(host.root, 'replayed.json');
    const writeDefinitions = (model: string) =>
      JSON.stringify({
        components: { agents: { reviewer: { file: './reviewer.md' } } },
        componentGroups: { work: { agents: ['reviewer'], configuration: { model } } },
        profiles: { work: { layers: [{ componentGroup: 'work' }] } },
      });
    await writeFile(definitions, writeDefinitions('fixture/alpha'));
    await writeFile(component, '---\nmode: primary\ndescription: Original component\n---\nGENERATED_PROMPT_A');
    await writeFile(
      join(host.configRoot, 'config-composer.jsonc'),
      JSON.stringify({
        imports: ['./definitions.jsonc'],
        activeProfiles: ['work'],
      }),
    );
    const wrapper = join(host.configRoot, 'replay.mjs');
    // The pinned host creates new hooks on public reload and swallows hook errors.
    // Replay the installed hook inside the host to retain its real ownership state.
    // This fixture controls sequencing only; every implementation hook is delegated.
    await writeFile(
      wrapper,
      `
import composer from ${JSON.stringify(pathToFileURL(join(host.installed.directory, 'dist/server.js')).href)};
import { writeFile } from 'node:fs/promises';
export default {
  id: 'composer-native-replay',
  server: async (input) => {
    const hooks = await composer.server(input);
    return { ...hooks, config: async (config) => {
      await hooks.config(config);
      const original = config.agent.reviewer;
      original.description = 'External description';
      await writeFile(${JSON.stringify(component)}, '---\\nmode: primary\\ndescription: Updated component\\n---\\nGENERATED_PROMPT_B');
      await writeFile(${JSON.stringify(definitions)}, ${JSON.stringify(writeDefinitions('fixture/beta'))});
      await hooks.config(config);
      await writeFile(${JSON.stringify(marker)}, JSON.stringify({ completed: true }));
    } };
  }
};
`,
    );
    await writeFile(configPath, JSON.stringify({ ...config, plugin: [pathToFileURL(wrapper).href] }));
    await host.start();
    const agent = (
      await host.api<{ name: string; description: string; prompt: string; model: { modelID: string } }[]>('/agent')
    ).find((item) => item.name === 'reviewer');
    assert.ok(agent !== undefined);
    assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), { completed: true });
    assert.equal(agent.description, 'External description');
    assert.equal(agent.model.modelID, 'beta');
    assert.equal(agent.prompt, 'GENERATED_PROMPT_B');
    const request = await send('reviewer');
    assert.equal(request.model, 'beta');
    const messages = JSON.stringify(request.messages);
    assert.equal(messages.split('GENERATED_PROMPT_B').length - 1, 1);
    assert.ok(!messages.includes('GENERATED_PROMPT_A'));
  },
);
