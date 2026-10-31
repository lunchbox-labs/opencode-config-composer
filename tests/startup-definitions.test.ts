import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import type { PluginInput } from '@opencode-ai/plugin';
import descriptor from '../src/config-composer/server.ts';
import { packageName } from '../src/config-composer/package-name.ts';
import { readRuntimeContext } from '../src/config-composer/composition/runtime-baseline.ts';
import {
  selectionLifetime,
  selectionLocator,
  selectionStateDirectory,
} from '../src/config-composer/composition/selection-state.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'composer-startup-'));
  const keys = ['OPENCODE_CONFIG_DIR', 'OPENCODE_TEST_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME'];
  const before = keys.map((key) => process.env[key]);
  keys.forEach((key) => (process.env[key] = root));
  t.after(async () => {
    keys.forEach((key, index) => {
      if (before[index] === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = before[index];
      }
    });
    await rm(root, { recursive: true, force: true });
  });
  const source = join(root, 'config-composer.jsonc');
  const input = { directory: root, worktree: root } as PluginInput;
  const load = async (options = {}) => {
    const config = { plugin: [packageName] };
    await (
      await descriptor.server(input, options)
    ).config!(config);
    return readRuntimeContext(config, { root, directory: root });
  };
  return { root, source, input, load };
}

for (const mutation of ['agent edit', 'agent addition', 'agent deletion', 'JSON edit', 'command edit'] as const) {
  test(`startup rejects a native ${mutation} during composition before applying managed fields`, async (t) => {
    const f = await fixture(t);
    await writeFile(
      f.source,
      JSON.stringify({
        model: 'p/composed',
        groups: { workers: { agent: { temperature: 0.1 } } },
        command: { run: { model: 'p/composed' } },
      }),
    );
    const agent = join(f.root, 'agents/worker.md');
    const json = join(f.root, 'opencode.json');
    const command = join(f.root, 'commands/run.md');
    await mkdir(join(f.root, 'agents'));
    await mkdir(join(f.root, 'commands'));
    await writeFile(agent, '---\nmodel: p/pinned\n---\nNative agent.');
    await writeFile(json, '{"model":"p/native"}');
    await writeFile(command, 'Native command.');
    const hooks = await descriptor.server(f.input);
    const locator = await selectionLocator(
      { stateDirectory: selectionStateDirectory(), lifetime: selectionLifetime() },
      { root: f.root, baseFile: f.source },
    );
    const original = fs.promises.lstat;
    let changed = false;
    // Selection is read after native observation, providing a deterministic edit
    // during composition while keeping native discovery and file reads real.
    const mocked = t.mock.method(fs.promises, 'lstat', async (...args: Parameters<typeof fs.promises.lstat>) => {
      if (!changed && String(args[0]) === locator.path) {
        changed = true;
        if (mutation === 'agent edit') {
          await writeFile(agent, '---\nmodel: p/changed\n---\nNative agent.');
        } else if (mutation === 'agent addition') {
          await writeFile(join(f.root, 'agents/helper.md'), '---\nmodel: p/helper\n---\nNew agent.');
        } else if (mutation === 'agent deletion') {
          await unlink(agent);
        } else if (mutation === 'JSON edit') {
          await writeFile(json, '{"model":"p/changed"}');
        } else {
          await writeFile(command, 'Changed native command.');
        }
      }
      return original(...args);
    });
    syncBuiltinESMExports();
    t.after(() => {
      mocked.mock.restore();
      syncBuiltinESMExports();
    });
    const config = {
      plugin: [packageName],
      model: 'p/native',
      agent: { worker: { groups: ['workers'], model: 'p/pinned', temperature: 0.8 } },
      command: { run: { template: 'Native command.' } },
    };
    await assert.rejects(hooks.config!(config), /Native inputs changed/);
    assert.equal(config.model, 'p/native');
    assert.deepEqual(config.agent.worker, { model: 'p/pinned', temperature: 0.8 });
    assert.deepEqual(config.command.run, { template: 'Native command.' });
    const runtime = readRuntimeContext(config, { root: f.root, directory: f.root });
    assert.equal(runtime.status, 'error');
    assert.match(runtime.diagnostic!, /Composer not applied.*Native inputs changed/);
    assert.equal(runtime.candidate, undefined);
  });
}

for (const failure of ['invalid', 'explicit missing', 'invalid options'] as const) {
  test(`first ${failure} startup failure remains sticky after correction`, async (t) => {
    const f = await fixture(t);
    if (failure === 'invalid') {
      await writeFile(f.source, '{"invalid":true}');
    }
    const options = failure === 'invalid options' ? { unsupported: true } : { configFile: f.source };
    const diagnostic =
      failure === 'invalid' ? /Unknown key/ : failure === 'invalid options' ? /only configFile/ : /does not exist/;
    await assert.rejects(f.load(options), diagnostic);
    await writeFile(f.source, '{"model":"p/fixed"}');
    await assert.rejects(f.load(), diagnostic);
    const config = { plugin: [packageName] };
    await assert.rejects((await descriptor.server(f.input)).config!(config), diagnostic);
    assert.throws(() => readRuntimeContext(config, { root: f.root, directory: f.root }), diagnostic);
  });
}

test('missing implicit source stays empty; a fresh process observes the new document', async (t) => {
  const f = await fixture(t);
  const before = await f.load();
  await writeFile(f.source, '{"model":"p/new"}');
  const after = await f.load();
  assert.deepEqual(after.source, before.source);
  assert.deepEqual(after.source.document, { groups: {}, profiles: {} });
  assert.equal(after.definitionId, before.definitionId);
  const module = new URL('../src/config-composer/server.ts', import.meta.url).href;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--experimental-strip-types',
      '--input-type=module',
      '-e',
      `
    import descriptor from ${JSON.stringify(module)};
    const config = {plugin:[${JSON.stringify(packageName)}]};
    await (await descriptor.server({directory:process.env.OPENCODE_CONFIG_DIR,worktree:process.env.OPENCODE_CONFIG_DIR})).config(config);
    console.log(JSON.stringify(config));
  `,
    ],
    { env: { ...process.env } },
  );
  const fresh = readRuntimeContext(JSON.parse(stdout), { root: f.root, directory: f.root });
  assert.equal(fresh.source.document.model, 'p/new');
  assert.notEqual(fresh.definitionId, before.definitionId);
});

test('concurrent first registrations and duplicate module loads share one capture, while independent locations load independently', async (t) => {
  const f = await fixture(t);
  await writeFile(f.source, '{"model":"p/first"}');
  const original = fs.promises.open;
  let reads = 0;
  const mocked = t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof fs.promises.open>) => {
    if (String(args[0]) === f.source) {
      reads++;
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  const [a, b] = await Promise.all([f.load(), f.load()]);
  assert.equal(reads, 1);
  assert.equal(a.definitionId, b.definitionId);
  assert.notEqual(a.id, b.id);
  // A consumer mutating its clone cannot mutate the process capture.
  a.source.document.model = 'p/tampered';
  await writeFile(f.source, '{"model":"p/second"}');
  const duplicate = (await import(
    new URL('../src/config-composer/server.ts?duplicate-startup-test', import.meta.url).href
  )) as { default: typeof descriptor };
  const config = { plugin: [packageName] };
  await (
    await duplicate.default.server(f.input, { configFile: 'ignored' })
  ).config!(config);
  const reused = readRuntimeContext(config, { root: f.root, directory: f.root });
  assert.equal(reused.definitionId, b.definitionId);
  assert.equal(reused.source.document.model, 'p/first');
  assert.equal(reads, 1);
  const other = join(f.root, 'other');
  await mkdir(other);
  const otherConfig = { plugin: [packageName] };
  await (
    await descriptor.server({ directory: other, worktree: f.root } as PluginInput)
  ).config!(otherConfig);
  const independent = readRuntimeContext(otherConfig, { root: f.root, directory: other });
  assert.notEqual(independent.definitionId, reused.definitionId);
  assert.equal(independent.source.document.model, 'p/second');
  assert.equal(reads, 2);
});

test('loaded definition and locator transport reject malformed attestation', async (t) => {
  const f = await fixture(t);
  const hooks = await descriptor.server(f.input);
  const config = { plugin: [packageName] };
  await hooks.config!(config);
  for (const patch of [
    { definitionId: '' },
    { source: { fingerprint: 'bad' } },
    { selectionLocator: { root: f.root, path: '../state', baseFile: f.source } },
  ]) {
    const altered = structuredClone(config) as unknown as {
      plugin: [string, { __configComposerRuntime: Record<string, unknown> }][];
    };
    Object.assign(altered.plugin[0][1].__configComposerRuntime, patch);
    assert.throws(() => readRuntimeContext(altered, { root: f.root, directory: f.root }), /Invalid server attestation/);
  }
});
