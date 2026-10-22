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
      f.editor.reload(committed, {
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
      f.editor.reload(committed, { refresh: () => Promise.reject(new Error('injected refresh failure')) }),
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
    await f.editor.reload(await f.editor.select('a'));
    await f.write(f.paths.shared, { profiles: { b: {} } });
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
    await f.editor.reload(await f.editor.select(null));
    assert.equal((await f.editor.runtime()).status, 'applied');
    for (const document of [
      { agent: { build: { mode: 'subagent' }, plan: { mode: 'subagent' }, worker: { mode: 'subagent' } } },
      { command: { review: { agent: 'missing' } } },
    ]) {
      await f.write(f.paths.shared, document);
      await f.host.api('/instance/dispose', {});
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
  test(`installed ${boundary} rejects a source change during the last runtime read`, { timeout: 240000 }, async (t) => {
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
    if (committed === undefined) {
      await assert.rejects(f.editor.storage.saveSelectionGuarded(context, preview), /Composition source changed/);
      await assert.rejects(readFile(context.selection.path), /ENOENT/);
    } else {
      let disposed = false;
      await assert.rejects(
        f.editor.reload(committed, {
          dispose: () => {
            disposed = true;
            return Promise.resolve();
          },
        }),
        /Composition source changed/,
      );
      assert.equal(disposed, false);
      assert.equal(await readFile(committed.selection.path, 'utf8'), committed.selection.text);
    }
    assert.equal(calls, 2);
  });
}

test(
  'installed reload adopts Composer, Markdown and project JSON with fresh attestation and keeps another directory loaded',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'fresh-native-reload');
    await mkdir(join(f.host.configRoot, 'agents'));
    await mkdir(join(f.host.configRoot, 'commands'));
    const agent = join(f.host.configRoot, 'agents/worker.md');
    const command = join(f.host.configRoot, 'commands/reload-proof.md');
    await writeFile(agent, '---\nmodel: fixture/alpha\n---\nBODY_OLD');
    await writeFile(command, '---\ndescription: COMMAND_OLD\n---\nCOMMAND_BODY_OLD');
    await f.host.start();
    const previous = await f.editor.runtime();
    const other = join(f.host.root, 'other');
    await mkdir(other);
    const otherConfig = async () => {
      const result = await fetch(`${f.host.url}/config`, { headers: { 'x-opencode-directory': other } });
      assert.ok(result.ok);
      return (await result.json()) as { plugin: [string, { __configComposerRuntime: { id: string } }][] };
    };
    const otherID = (await otherConfig()).plugin.find(
      (entry) => Array.isArray(entry) && Object.hasOwn(entry[1], '__configComposerRuntime'),
    )?.[1].__configComposerRuntime.id;
    assert.ok(otherID !== undefined && otherID !== '');
    const native = await readFile(f.paths.native, 'utf8');
    await writeFile(agent, '---\nmodel: fixture/beta\ntemperature: 0\n---\nBODY_NEW');
    await writeFile(command, '---\ndescription: COMMAND_NEW\n---\nCOMMAND_BODY_NEW');
    await f.write(f.paths.shared, { agent: { worker: { temperature: 0.9 }, helper: { top_p: 0.8 } } });
    const project = join(f.host.project, 'opencode.json');
    await f.write(project, { $schema: 'https://opencode.ai/config.json', small_model: 'fixture/beta' });
    const before = await Promise.all([agent, command, project, f.paths.shared].map((path) => readFile(path, 'utf8')));
    await f.editor.reloadConfiguration();
    const current = await f.editor.runtime();
    assert.notEqual(current.id, previous.id);
    assert.equal(current.candidate?.small_model, 'fixture/beta');
    assert.equal(current.candidate.agent.worker.model, 'fixture/beta');
    assert.equal(current.candidate.agent.worker.temperature, 0);
    assert.equal(current.candidate.agent.helper.top_p, 0.8);
    const config = await f.host.api<{ agent: { worker: { prompt: string } } }>('/config');
    assert.match(config.agent.worker.prompt, /BODY_NEW/);
    const commands = await f.host.api<{ name: string; template: string; description?: string }[]>('/command');
    assert.match(commands.find((entry) => entry.name === 'reload-proof')!.template, /COMMAND_BODY_NEW/);
    assert.equal(commands.find((entry) => entry.name === 'reload-proof')!.description, 'COMMAND_NEW');
    assert.equal(
      (await otherConfig()).plugin.find(
        (entry) => Array.isArray(entry) && Object.hasOwn(entry[1], '__configComposerRuntime'),
      )?.[1].__configComposerRuntime.id,
      otherID,
    );
    assert.deepEqual(
      await Promise.all([agent, command, project, f.paths.shared].map((path) => readFile(path, 'utf8'))),
      before,
    );
    assert.equal(await readFile(f.paths.native, 'utf8'), native);
    assert.equal(f.host.requests.length, 0);
  },
);
test(
  'installed reload refuses cached global JSON with zero disposal after external rebootstrap',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'global-cache-reload');
    await f.host.start();
    await f.editor.runtime();
    await f.write(f.paths.native, { ...f.native, username: 'external-global-change' });
    await f.host.api('/instance/dispose', {});
    const current = await f.editor.context();
    assert.notEqual(current.disk.globalJson, current.runtime.globalJsonBaseline);
    let disposed = 0;
    await assert.rejects(
      f.editor.reloadConfiguration(current, {
        dispose: async () => {
          disposed++;
        },
      }),
      /Restart the OpenCode server/,
    );
    assert.equal(disposed, 0);
    await assert.rejects(f.editor.select(null), /Restart the OpenCode server/);
    assert.equal((await f.editor.runtime()).id, current.runtime.id);
  },
);

test(
  'installed command alias additions, removal and retargeting stay pending until scoped reload',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'command-alias-reload');
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
    const previous = await f.editor.runtime();
    await link(shared, two);
    const added = await f.editor.context();
    assert.notEqual(added.disk.commands, previous.observation.commands);
    await assert.rejects(f.editor.storage.previewSelection(added, null), /Native command Markdown changed/);
    await f.editor.reloadConfiguration(added);
    const list = () => f.host.api<{ name: string; template: string }[]>('/command');
    assert.ok((await list()).some((command) => command.name === 'one/run'));
    assert.ok((await list()).some((command) => command.name === 'two/run'));
    await rm(one, { recursive: true });
    await f.editor.reloadConfiguration();
    assert.equal(
      (await list()).some((command) => command.name === 'one/run'),
      false,
    );
    assert.ok((await list()).some((command) => command.name === 'two/run'));
    await rm(two, { recursive: true });
    await link(alternate, two);
    await f.editor.reloadConfiguration();
    assert.match((await list()).find((command) => command.name === 'two/run')!.template, /ALIAS_BODY_RETARGETED/);
    assert.equal(await readFile(join(shared, 'run.md'), 'utf8'), body);
    assert.equal(f.host.requests.length, 0);
  },
);
