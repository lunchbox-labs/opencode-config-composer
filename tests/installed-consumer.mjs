import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const name = process.argv[2];
const rootModule = await import(name);
const serverModule = await import(`${name}/server`);
const tuiModule = await import(`${name}/tui`);
const schemaUrl = import.meta.resolve(`${name}/schema.json`);
assert.ok(schemaUrl.endsWith('/schema.json'));
// Lazy UI modules must resolve within the emitted package, even though plain Node
// does not initialize the host's shared Solid/OpenTUI renderer.
const dist = new URL('./dist/', schemaUrl);
let lazyModules = 0;
for (const file of await readdir(dist, { recursive: true })) {
  if (!file.endsWith('.js')) {
    continue;
  }
  const url = new URL(file.replaceAll('\\', '/'), dist);
  const source = await readFile(url, 'utf8');
  for (const match of source.matchAll(/import\(['"](\.\.?\/[^'"]+)['"]\)/g)) {
    assert.equal((await stat(new URL(match[1], url))).isFile(), true);
    lazyModules++;
  }
}
assert.ok(lazyModules > 0);

const { default: schema } = await import(`${name}/schema.json`, { with: { type: 'json' } });
assert.equal(schema.type, 'object');
assert.ok(schema.properties.groups);
assert.ok(schema.properties.agent);
assert.equal(schema.properties.components, undefined);
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
for (const [index, options] of [{ groups: {} }, { modelPresets: {} }].entries()) {
  const location = join(process.cwd(), `invalid-options-${index}`);
  const hooks = await server.server({ directory: location, worktree: location }, options);
  await assert.rejects(hooks.config({}), /only configFile/);
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
    groups: { workers: { agent: { temperature: 0 } } },
    profiles: { work: { agent: { worker: { model: 'fixture/model' } } } },
    defaultProfile: 'work',
  }),
);
process.env.OPENCODE_CONFIG_DIR = root;
process.env.OPENCODE_TEST_HOME = root;
const hooks = await server.server({ directory: root, worktree: root }, { configFile: 'settings/composer.jsonc' });
const config = { agent: { worker: { groups: ['workers'], prompt: 'PACKAGED_NATIVE_BODY' } } };
await hooks.config(config);
assert.equal(config.agent.worker.model, 'fixture/model');
assert.equal(config.agent.worker.temperature, 0);
assert.equal(config.agent.worker.prompt, 'PACKAGED_NATIVE_BODY');

// Each server start checks the packaged skills it registers and names the damaged file.
const skill = fileURLToPath(new URL('./skills/config-composer-create/SKILL.md', schemaUrl));
const reference = fileURLToPath(new URL('./skills/config-composer-explain/references/schema.md', schemaUrl));
const skillText = await readFile(skill, 'utf8');
const referenceText = await readFile(reference, 'utf8');
for (const [damaged, damage] of [
  // A parser that let either duplicate win would accept this identity.
  [skill, () => writeFile(skill, skillText.replace(/^description:/m, 'description: Duplicate.\n$&'))],
  [skill, () => writeFile(skill, skillText.replace(/^description: /m, '$&"unterminated '))],
  [reference, () => rm(reference)],
]) {
  await damage();
  const location = join(process.cwd(), 'damaged-skills');
  await assert.rejects(server.server({ directory: location, worktree: location }, {}), (error) => {
    const expected = `Could not load bundled skill resource ${damaged}. Reinstall Config Composer with its packaged skills.`;
    assert.ok(error.message.startsWith(expected), error.message);
    return true;
  });
  await writeFile(skill, skillText);
  await writeFile(reference, referenceText);
}

// Registration/rendering needs the host shared Solid/OpenTUI runtime. Packed native
// terminal tests exercise it; plain Node must still import both descriptors safely.
assert.equal(typeof tui.tui, 'function');
console.log('installed package verified');
