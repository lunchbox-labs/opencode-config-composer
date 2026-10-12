import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const name = process.argv[2];
const rootModule = await import(name);
const serverModule = await import(`${name}/server`);
const tuiModule = await import(`${name}/tui`);
const schemaUrl = import.meta.resolve(`${name}/schema.json`);
assert.ok(schemaUrl.endsWith('/schema.json'));
const { default: schema } = await import(`${name}/schema.json`, { with: { type: 'json' } });
assert.equal(schema.type, 'object');
assert.ok(schema.properties.components);
assert.equal(schema.properties.agent, undefined);
assert.equal(typeof schema.description, 'string');
for (const module of [rootModule, serverModule, tuiModule]) {
  assert.deepEqual(Object.keys(module), ['default']);
}
const server = rootModule.default;
assert.equal(serverModule.default, server);
const tui = tuiModule.default;
assert.equal(server.id, 'config-composer');
assert.equal(tui.id, server.id);
assert.equal(server.tui, undefined);
assert.equal(tui.server, undefined);
for (const options of [{ groups: {} }, { modelPresets: {} }]) {
  await assert.rejects(server.server({}, options), /only configFile/);
}
for (const path of [
  'settings',
  'configuration',
  'package.json',
  'dist/config-composer/storage.js',
  'dist/config-composer/server.js',
  'src/config-composer/settings.ts',
  'dist/tui/navigation.js',
]) {
  await assert.rejects(import(`${name}/${path}`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
}

const root = join(process.cwd(), 'configuration');
await mkdir(join(root, 'settings'), { recursive: true });
await writeFile(
  join(root, 'settings', 'composer.jsonc'),
  JSON.stringify({
    componentGroups: { workers: { configuration: { model: 'fixture/model' } } },
    profiles: { work: { layers: [{ componentGroup: 'workers' }] } },
    activeProfiles: ['work'],
  }),
);
process.env.OPENCODE_CONFIG_DIR = root;
const hooks = await server.server({}, { configFile: 'settings/composer.jsonc' });
const config = { agent: { worker: { groups: ['workers'], prompt: 'PACKAGED_NATIVE_BODY' } } };
await hooks.config(config);
await assert.rejects(hooks.config({ agent: { worker: { agent_group: 'workers' } } }), /agent_group is not supported/);
assert.equal(config.agent.worker.model, 'fixture/model');
assert.equal(config.agent.worker.prompt, 'PACKAGED_NATIVE_BODY');

await writeFile(
  join(root, 'config-composer.jsonc'),
  JSON.stringify({
    componentGroups: { workers: { configuration: { model: 'fixture/default' } } },
    profiles: { work: { layers: [{ componentGroup: 'workers' }] } },
    activeProfiles: ['work'],
  }),
);
for (const options of [undefined, {}, { reloadToken: 'fresh' }]) {
  const defaults = await server.server({}, options);
  const configured = { agent: { worker: { groups: ['workers'] } } };
  await defaults.config(configured);
  assert.equal(configured.agent.worker.model, 'fixture/default');
}

const commands = [];
let dispose;
await tui.tui({
  state: { path: { directory: root, worktree: root } },
  client: { config: { get: async () => ({ error: 'offline fixture' }) } },
  ui: { toast: () => {} },
  event: { on: () => () => {} },
  lifecycle: {
    signal: new AbortController().signal,
    onDispose: (callback) => {
      dispose = callback;
    },
  },
  keymap: {
    registerLayer: (layer) => {
      commands.push(...layer.commands);
      return () => {};
    },
  },
});
assert.deepEqual(
  commands.map((command) => command.slashName),
  ['compose-configs', 'agent-models', 'reload-configs', 'agent-groups'],
);
assert.ok(commands.every((command) => !command.slashAliases?.includes('compose')));
assert.equal(typeof dispose, 'function');
console.log('installed package verified');
