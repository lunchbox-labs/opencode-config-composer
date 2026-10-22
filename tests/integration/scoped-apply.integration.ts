import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { compositionFixture } from './composition-fixture.ts';
test('installed source alias cannot rewrite a loaded native command Markdown body', { timeout: 240000 }, async (t) => {
  const f = await compositionFixture(t, 'native-command-alias');
  await mkdir(join(f.host.configRoot, 'commands'));
  const native = join(f.host.configRoot, 'commands/alias-proof.md');
  const before = '{"model":"fixture/alpha"}';
  await writeFile(native, before);
  await unlink(f.paths.shared);
  await symlink(native, f.paths.shared);
  await f.host.start();
  const commands = await f.host.api<{ name: string; template: string }[]>('/command');
  assert.equal(commands.find((command) => command.name === 'alias-proof')?.template, before);
  const context = await f.editor.context();
  await assert.rejects(
    async () =>
      f.editor.storage.saveDocumentGuarded(
        context,
        await f.editor.storage.previewDocument(context, '{"model":"fixture/beta"}'),
      ),
    /Native.*read-only/,
  );
  assert.equal(await readFile(native, 'utf8'), before);
  assert.equal(f.host.requests.length, 0);
});
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
    await assert.rejects(
      f.editor.storage.saveSelectionGuarded(context, preview),
      /Native agent metadata changed\. Restart OpenCode, then review again\./,
    );
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
    await assert.rejects(f.editor.storage.saveSelectionGuarded(current, chosen), /Native JSON configuration changed/);
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
