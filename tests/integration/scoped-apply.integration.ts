import assert from 'node:assert/strict';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { compositionFixture } from './composition-fixture.ts';
test(
  'installed guarded save rejects changed native inventories and JSON, and busy or failed apply retains pending state',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'guarded-apply');
    await f.write(f.paths.shared, { profiles: { a: { agent: { worker: { model: 'fixture/beta' } } } } });
    await f.host.start();
    const context = await f.editor.context();
    const preview = await f.editor.storage.previewSelection(context, 'a');
    await mkdir(join(f.host.configRoot, 'agents'));
    await writeFile(join(f.host.configRoot, 'agents/worker.md'), '---\n---\nnew opaque body');
    await assert.rejects(f.editor.storage.saveSelectionGuarded(context, preview), /Native agent metadata changed/);
    await assert.rejects(readFile(context.selection.path), /ENOENT/);
    await f.host.stop();
    await f.host.start();
    const committed = await f.editor.select('a');
    let disposed = 0;
    await assert.rejects(
      f.editor.applySelection(committed, {
        activity: () => Promise.resolve({ active: { type: 'busy' } }),
        dispose: () => {
          disposed++;
          return Promise.resolve();
        },
      }),
      /still running/,
    );
    assert.equal(disposed, 0);
    await assert.rejects(
      f.editor.applySelection(committed, { refresh: () => Promise.reject(new Error('injected refresh failure')) }),
      /refresh failure/,
    );
    assert.equal((await f.editor.context()).selection.choice, 'a');
    const current = await f.editor.context();
    const chosen = await f.editor.storage.previewSelection(current, null);
    await writeFile(f.paths.native, (await readFile(f.paths.native, 'utf8')) + '\n');
    await assert.rejects(f.editor.storage.saveSelectionGuarded(current, chosen), /Native global JSON changed/);
  },
);
test(
  'native swallowed hook failures remain recoverable and validate builtin/default/disabled targets',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'recoverable-native');
    await f.write(f.paths.shared, { profiles: { a: { agent: { worker: { model: 'fixture/beta' } } } } });
    await f.host.start();
    await f.editor.applySelection(await f.editor.select('a'));
    const saved = await f.editor.context();
    await writeFile(
      saved.selection.path,
      JSON.stringify({ version: 2, revision: saved.selection.revision + 1, selection: { choice: 'missing' } }),
    );
    await f.host.api('/instance/dispose', {});
    const failed = await f.editor.runtime();
    assert.equal(failed.status, 'error');
    assert.equal(failed.revision, undefined);
    assert.match(failed.diagnostic!, /Composer not applied/);
    assert.ok(
      (await f.host.api<{ name: string }[]>('/skill')).some((skill) => skill.name === 'config-composer-explain'),
    );
    assert.equal(
      (await f.host.api<{ agent: { worker: { model?: string } } }>('/config')).agent.worker.model,
      undefined,
    );
    await f.editor.applySelection(await f.editor.select(null));
    assert.equal((await f.editor.runtime()).status, 'applied');
    for (const document of [
      { agent: { build: { mode: 'subagent' }, plan: { mode: 'subagent' }, worker: { mode: 'subagent' } } },
      { command: { review: { agent: 'missing' } } },
    ]) {
      await f.host.stop();
      await f.write(f.paths.shared, document);
      await f.host.start();
      assert.equal((await f.editor.runtime()).status, 'error');
    }
    await f.write(f.paths.shared, { command: { review: { agent: 'helper' } } });
    await f.host.stop();
    await f.write(f.paths.native, {
      ...f.native,
      agent: { ...f.native.agent, helper: { ...f.native.agent.helper, disable: true } },
    });
    await f.host.start();
    assert.match((await f.editor.runtime()).diagnostic!, /disabled/);
  },
);

for (const boundary of ['save', 'dispose'] as const) {
  test(
    `installed ${boundary} keeps loaded definitions after a source change during the last runtime read`,
    { timeout: 240000 },
    async (t) => {
      const f = await compositionFixture(t, `runtime-read-${boundary}`);
      await f.write(f.paths.shared, { profiles: { a: { agent: { worker: { model: 'fixture/beta' } } } } });
      await f.host.start();
      const context = await f.editor.context();
      const preview = await f.editor.storage.previewSelection(context, 'a');
      const committed =
        boundary === 'dispose' ? await f.editor.storage.saveSelectionGuarded(context, preview) : undefined;
      const connection = (committed ?? context).connection;
      const readRuntime = connection.config.bind(connection);
      let calls = 0;
      connection.config = async () => {
        const response = await readRuntime();
        if (++calls === 2) {
          await f.write(f.paths.shared, { profiles: { b: {} } });
        }
        return response;
      };
      const saved = committed ?? (await f.editor.storage.saveSelectionGuarded(context, preview));
      await f.editor.applySelection(saved);
      const current = await f.editor.runtime();
      assert.equal(current.definitionId, context.runtime.definitionId);
      assert.deepEqual(current.source, context.source);
      assert.equal(current.candidate?.agent.worker.model, 'fixture/beta');
      assert.equal(current.selection?.choice, 'a');
      assert.ok(calls >= 2);
    },
  );
}

test(
  'installed profile cycles keep startup definitions and source identity until server restart',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'startup-definitions');
    const loaded = {
      defaultProfile: 'a',
      profiles: {
        a: { agent: { worker: { model: 'fixture/alpha', temperature: 0.1 } } },
        b: { agent: { worker: { model: 'fixture/beta' } } },
      },
    };
    const originalDirectory = join(f.host.root, 'original-definitions');
    const alternateDirectory = join(f.host.root, 'alternate-definitions');
    const alias = join(f.host.root, 'loaded-definitions');
    await Promise.all([originalDirectory, alternateDirectory].map((path) => mkdir(path)));
    const source = join(alias, 'config-composer.jsonc');
    const link = (target: string) => symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await f.write(join(originalDirectory, 'config-composer.jsonc'), loaded);
    await link(originalDirectory);
    await f.write(f.paths.native, { ...f.native, plugin: [[f.host.installed.directory, { configFile: source }]] });
    await f.host.start();
    const initial = await f.editor.context();
    const alternate = join(alternateDirectory, 'config-composer.jsonc');
    await f.write(alternate, {
      defaultProfile: 'b',
      profiles: { a: {}, b: { agent: { worker: { temperature: 0.9 } } } },
    });
    // Retargeting cannot redirect either definitions or the external state namespace.
    await rm(alias, { recursive: true });
    await link(alternateDirectory);
    for (const choice of ['b', 'a', null, undefined] as const) {
      await f.editor.applySelection(await f.editor.select(choice));
      const current = await f.editor.context();
      assert.equal(current.runtime.definitionId, initial.runtime.definitionId);
      assert.deepEqual(current.source, initial.source);
      assert.equal(current.selection.path, initial.selection.path);
      assert.equal(
        current.runtime.candidate?.agent.worker.model,
        choice === 'b' ? 'fixture/beta' : choice === null ? undefined : 'fixture/alpha',
      );
      assert.equal(
        current.runtime.candidate?.agent.worker.temperature,
        choice === 'a' || choice === undefined ? 0.1 : undefined,
      );
    }
    await writeFile(alternate, '{ invalid');
    await f.editor.applySelection(await f.editor.select('b'));
    assert.deepEqual((await f.editor.context()).source, initial.source);
    await f.write(alternate, {
      defaultProfile: 'b',
      profiles: { a: {}, b: { agent: { worker: { temperature: 0.9 } } } },
    });
    await f.host.stop();
    await f.host.start();
    const fresh = await f.editor.context();
    assert.notEqual(fresh.runtime.definitionId, initial.runtime.definitionId);
    assert.equal(fresh.source.canonicalPath, alternate);
    assert.notEqual(fresh.selection.path, initial.selection.path);
    assert.equal(fresh.runtime.candidate?.agent.worker.temperature, 0.9);
    assert.equal(f.host.requests.length, 0);
  },
);

test(
  'installed native drift blocks profile application while malformed files leave inspection readable',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'native-drift');
    await mkdir(join(f.host.configRoot, 'agents'));
    await mkdir(join(f.host.configRoot, 'commands'));
    const agent = join(f.host.configRoot, 'agents/worker.md');
    const command = join(f.host.configRoot, 'commands/run.md');
    await writeFile(agent, '---\nmodel: fixture/alpha\n---\nBODY_OLD');
    await writeFile(command, '---\ndescription: COMMAND_OLD\n---\nCOMMAND_BODY_OLD');
    await f.host.start();
    const initial = await f.editor.context();
    await writeFile(agent, '---\nmode: [wrong]\n---\nBODY_NEW');
    await writeFile(command, '---\ndescription: COMMAND_NEW\n---\nCOMMAND_BODY_NEW');
    await f.write(f.paths.shared, { agent: { helper: { temperature: 0.9 } } });
    const inspected = await f.editor.context();
    assert.deepEqual(inspected.source, initial.source);
    assert.deepEqual(inspected.runtime, initial.runtime);
    let disposed = 0;
    await assert.rejects(
      f.editor.applySelection(inspected, {
        dispose: async () => {
          disposed++;
        },
      }),
      /Restart the OpenCode server process/,
    );
    assert.equal(disposed, 0);
    assert.equal((await f.editor.runtime()).id, initial.runtime.id);
  },
);

test(
  'installed profile application refuses cached global JSON after external rebootstrap',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'global-cache-apply');
    await f.host.start();
    const initial = await f.editor.runtime();
    await f.write(f.paths.native, { ...f.native, username: 'external-global-change' });
    await f.host.api('/instance/dispose', {});
    const current = await f.editor.context();
    assert.equal(current.runtime.globalJsonBaseline, initial.globalJsonBaseline);
    assert.notEqual(current.runtime.observation.globalJson, current.runtime.globalJsonBaseline);
    let disposed = 0;
    await assert.rejects(
      f.editor.applySelection(current, {
        dispose: async () => {
          disposed++;
        },
      }),
      /Restart the OpenCode server/,
    );
    assert.equal(disposed, 0);
    await assert.rejects(f.editor.select(null), /Restart the OpenCode server/);
  },
);

test(
  'installed command alias additions, removal and retargeting require restart before profile apply',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'command-alias-apply');
    const commands = join(f.host.configRoot, 'commands');
    const shared = join(f.host.root, 'shared-commands');
    const alternate = join(f.host.root, 'alternate-commands');
    await Promise.all([commands, shared, alternate].map((path) => mkdir(path)));
    const body = '---\ndescription: ALIAS_COMMAND\n---\nALIAS_BODY';
    await writeFile(join(shared, 'run.md'), body);
    await writeFile(join(alternate, 'run.md'), body + '_RETARGETED');
    const one = join(commands, 'one');
    const two = join(commands, 'two');
    const link = (target: string, path: string) =>
      symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');
    await link(shared, one);
    await f.host.start();
    await f.editor.runtime();
    const list = () => f.host.api<{ name: string; template: string }[]>('/command');
    for (const mutate of [
      () => link(shared, two),
      () => rm(one, { recursive: true }),
      async () => {
        await rm(two, { recursive: true });
        await link(alternate, two);
      },
    ]) {
      await mutate();
      const context = await f.editor.context();
      let disposed = 0;
      await assert.rejects(
        f.editor.applySelection(context, {
          dispose: async () => {
            disposed++;
          },
        }),
        /Native command Markdown changed.*Restart/,
      );
      assert.equal(disposed, 0);
      await f.host.stop();
      await f.host.start();
      await f.editor.runtime();
    }
    assert.equal(
      (await list()).some((entry) => entry.name === 'one/run'),
      false,
    );
    assert.match((await list()).find((entry) => entry.name === 'two/run')!.template, /ALIAS_BODY_RETARGETED/);
    assert.equal(await readFile(join(shared, 'run.md'), 'utf8'), body);
  },
);
