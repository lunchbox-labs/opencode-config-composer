import assert from 'node:assert/strict';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { compositionFixture } from './composition-fixture.ts';

test(
  'installed scope editor creates sources and applies ordered activation without losing conversations',
  { timeout: 240_000 },
  async (t) => {
    const f = await compositionFixture(t, 'scope-activation');
    await f.host.start();
    const original = await f.send();
    const session = original.session.id;
    // OpenCode remembers a session's last model when no agent model is configured.
    // Fresh dispatch establishes defaults; the original conversation is retained below.
    const expectModel = async (model: string) => assert.equal((await f.send()).captured.model, model);
    const absent = async (path: string) => assert.equal(await stat(path).catch(() => undefined), undefined, path);
    const select = async (scope: 'shared' | 'project' | 'local', profiles?: string[]) => {
      await f.saveScope(scope, { operation: 'selection', profiles });
      await f.editor.reload();
    };

    await t.test('empty installation previews first-source creation without writing or activating it', async () => {
      const snapshot = await f.editor.snapshot();
      assert.equal(snapshot.sources.documents.length, 0);
      const plan = f.activation.planScope(snapshot, 'shared', { operation: 'create' });
      const preview = await f.editor.storage.previewFilePlan(plan);
      assert.deepEqual(preview.sources.activeProfiles, []);
      await Promise.all(Object.values(f.paths).map(absent));
      await f.saveScope('shared', { operation: 'create' });
      assert.deepEqual(await f.document(f.paths.shared), {});
      await absent(f.paths.project);
      await absent(f.paths.local);
      await f.editor.reload();
      await expectModel('alpha');
    });

    await t.test('definitions remain inactive until selected and save waits for reload', async () => {
      for (const [name, model] of [
        ['work', 'beta'],
        ['focus', 'alpha'],
      ] as const) {
        await f.saveDefinition({
          operation: 'create',
          registry: 'componentGroups',
          name,
          sourceId: f.paths.shared,
          value: { agents: ['worker'], configuration: { model: `fixture/${model}` } },
        });
        await f.saveDefinition({
          operation: 'create',
          registry: 'profiles',
          name,
          sourceId: f.paths.shared,
          value: { layers: [{ componentGroup: name }] },
        });
      }
      await f.editor.reload();
      assert.deepEqual((await f.editor.snapshot()).sources.activeProfiles, []);
      await expectModel('alpha');
      await f.saveScope('shared', { operation: 'selection', profiles: ['work'] });
      await expectModel('alpha');
      await f.editor.reload();
      await expectModel('beta');
    });

    await t.test(
      'a native source added during asynchronous validation aborts before creating a local selection',
      async () => {
        const late = join(f.host.project, '.opencode/agents/late.md');
        const plan = f.activation.planScope(await f.editor.snapshot(), 'local', {
          operation: 'selection',
          profiles: ['work'],
        });
        let added = false;
        try {
          await assert.rejects(
            f.editor.storage.saveFilePlan(plan, async () => {
              await f.editor.storage.previewFilePlan(plan);
              await mkdir(dirname(late), { recursive: true });
              await writeFile(late, '---\ngroups: [work]\n---\nLATE_NATIVE_AGENT\n');
              added = true;
            }),
            /source list changed|sources changed|Native agent inputs differ/,
          );
          assert.equal(added, true, 'rejection happens after the validation callback adds the source');
          await absent(f.paths.local);
          assert.deepEqual((await f.document(f.paths.shared)).activeProfiles, ['work']);
          await expectModel('beta');
        } finally {
          await rm(late, { force: true });
        }
      },
    );

    await t.test(
      'project replacement, local ordering, explicit empty and inheritance affect actual dispatch',
      async () => {
        await select('project', ['focus']);
        await expectModel('alpha');
        await select('local', ['focus', 'work']);
        await expectModel('beta');
        assert.deepEqual((await f.document(f.paths.local)).activeProfiles, ['focus', 'work']);
        await select('local', ['work', 'focus']);
        await expectModel('alpha');
        await select('local', []);
        await expectModel('alpha');
        assert.deepEqual((await f.editor.snapshot()).sources.activeProfiles, []);
        await select('local');
        assert.equal(Object.hasOwn(await f.document(f.paths.local), 'activeProfiles'), false);
        assert.deepEqual((await f.editor.snapshot()).sources.activeProfiles, ['focus']);
        await select('project');
        await expectModel('beta');
        assert.deepEqual((await f.editor.snapshot()).sources.activeProfiles, ['work']);
        await select('local', []);
        await expectModel('alpha');
        const scopes = f.activation.scopeDestinations(await f.editor.snapshot());
        assert.equal(scopes.find((scope) => scope.scope === 'shared')?.maskedBy, 'local');
      },
    );

    await t.test('invalid selection and concurrent first-source creation preserve all existing bytes', async () => {
      const before = await Promise.all(Object.values(f.paths).map((path) => readFile(path, 'utf8')));
      await assert.rejects(
        f.saveScope('local', { operation: 'selection', profiles: ['missing'] }),
        /Unknown.*profile|profile.*not found/i,
      );
      assert.deepEqual(await Promise.all(Object.values(f.paths).map((path) => readFile(path, 'utf8'))), before);
      await rm(f.paths.local);
      const plan = f.activation.planScope(await f.editor.snapshot(), 'local', { operation: 'create' });
      const concurrent = '// Concurrent author\n{"activeProfiles":[]}\n';
      await writeFile(f.paths.local, concurrent);
      await assert.rejects(
        f.editor.storage.saveFilePlan(plan, async () => {
          await f.editor.storage.previewFilePlan(plan);
        }),
        /changed|exists|Reopen/,
      );
      assert.equal(await readFile(f.paths.local, 'utf8'), concurrent);
      const history = await f.history(session);
      assert.ok(history.some((message) => message.info.id === original.message.info.id));
      assert.equal(
        (await f.host.api<{ id: string; title: string }>(`/session/${session}`)).title,
        'Acceptance conversation',
      );
    });
  },
);
