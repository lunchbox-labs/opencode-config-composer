import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { compositionFixture } from './composition-fixture.ts';

test(
  'installed registry authoring preserves references, native baselines and applied sessions',
  { timeout: 240_000 },
  async (t) => {
    const f = await compositionFixture(t, 'registry-authoring');
    const library = join(f.host.configRoot, 'library.jsonc');
    const agent = join(f.host.configRoot, 'fixtures/writer.md');
    await mkdir(join(f.host.configRoot, 'fixtures'), { recursive: true });
    await writeFile(agent, '---\ndescription: Keep this description\ngroups: [work]\n---\nKEEP_AGENT_BODY\n');
    await f.write(library, {
      configurationPresets: { steady: { model: 'fixture/beta' } },
      componentGroups: { work: { agents: ['worker'], configuration: { modelRef: 'preset:steady' } } },
    });
    await f.write(f.paths.shared, {
      imports: ['./library.jsonc'],
      components: { agents: { writer: { file: './fixtures/writer.md' } } },
      profiles: {
        work: { layers: [{ componentGroup: 'work' }], overrides: { model: 'fixture/alpha' } },
        child: { extends: 'work' },
      },
      activeProfiles: ['child'],
    });
    await f.host.start({ configContent: { model: 'fixture/beta' } });
    const original = await f.send();
    assert.equal(original.captured.model, 'beta');

    await t.test('preset, group and profile renames rewrite declaring files and all references', async () => {
      await f.saveDefinition({
        registry: 'configurationPresets',
        name: 'steady',
        operation: 'rename',
        nextName: 'balanced',
      });
      assert.equal((await f.document(library)).componentGroups?.work.configuration?.modelRef, 'preset:balanced');
      await f.saveDefinition({ registry: 'componentGroups', name: 'work', operation: 'rename', nextName: 'team' });
      assert.deepEqual((await f.document(f.paths.shared)).profiles?.work.layers, [{ componentGroup: 'team' }]);
      assert.match(await readFile(agent, 'utf8'), /groups: \[\s*team\s*\]/);
      assert.match(await readFile(agent, 'utf8'), /KEEP_AGENT_BODY/);
      await f.saveDefinition({ registry: 'profiles', name: 'work', operation: 'rename', nextName: 'base' });
      assert.equal((await f.document(f.paths.shared)).profiles?.child.extends, 'base');
      await f.saveDefinition({ registry: 'profiles', name: 'child', operation: 'rename', nextName: 'selected' });
      assert.deepEqual((await f.document(f.paths.shared)).activeProfiles, ['selected']);
      assert.match(await readFile(library, 'utf8'), /Preserve fixture comments/);
      await f.editor.reload();
      assert.equal((await f.send(original.session.id)).captured.model, 'beta');
    });

    await t.test(
      'membership and preset edits change requests only after apply; removing overrides restores the true native baseline',
      async () => {
        await f.saveDefinition({
          registry: 'configurationPresets',
          name: 'balanced',
          operation: 'patch',
          path: ['model'],
          value: 'fixture/alpha',
        });
        assert.equal((await f.send(original.session.id)).captured.model, 'beta');
        await f.editor.reload();
        assert.equal((await f.send(original.session.id)).captured.model, 'alpha');
        await f.saveDefinition({
          registry: 'componentGroups',
          name: 'team',
          operation: 'patch',
          path: ['agents'],
          value: [],
        });
        await f.saveDefinition({
          registry: 'profiles',
          name: 'base',
          operation: 'patch',
          path: ['overrides'],
          value: undefined,
        });
        const preview = await f.editor.snapshot();
        assert.equal(preview.resolved.model, 'fixture/beta');
        await f.editor.reload();
        assert.equal((await f.send()).captured.model, 'beta');
        for (const path of [library, f.paths.shared, agent]) {
          assert.doesNotMatch(await readFile(path, 'utf8'), /runtimeBaseline|appliedGlobals|appliedAgents/);
        }
      },
    );

    await t.test(
      'unused definitions support create, patch and delete without activation; referenced deletion is atomic',
      async () => {
        for (const registry of ['componentGroups', 'configurationPresets', 'profiles'] as const) {
          const value = registry === 'configurationPresets' ? { model: 'fixture/alpha' } : {};
          await f.saveDefinition({ registry, name: 'unused', operation: 'create', sourceId: library, value });
          assert.notEqual((await f.document(library))[registry]?.unused, undefined);
          await f.saveDefinition({ registry, name: 'unused', operation: 'delete' });
          assert.equal((await f.document(library))[registry]?.unused, undefined);
        }
        const before = await Promise.all([library, f.paths.shared, agent].map((path) => readFile(path, 'utf8')));
        await assert.rejects(
          f.saveDefinition({ registry: 'configurationPresets', name: 'balanced', operation: 'delete' }),
          /referenced|reference/i,
        );
        await assert.rejects(
          f.saveDefinition({ registry: 'profiles', name: 'base', operation: 'delete' }),
          /referenced|reference/i,
        );
        assert.deepEqual(
          await Promise.all([library, f.paths.shared, agent].map((path) => readFile(path, 'utf8'))),
          before,
        );
        assert.deepEqual((await f.editor.snapshot()).sources.activeProfiles, ['selected']);
      },
    );

    await t.test('read-only native references and stale snapshots reject before changing definitions', async () => {
      const native = join(f.host.project, '.opencode/agents/project-reader.md');
      await mkdir(join(f.host.project, '.opencode/agents'), { recursive: true });
      await writeFile(native, '---\ngroups: [team]\n---\nREAD_ONLY_PROJECT_BODY\n');
      await assert.rejects(f.editor.reload(), /Native agent inputs differ/);
      await f.host.stop();
      await f.host.start({ configContent: { model: 'fixture/beta' } });
      const before = await readFile(library, 'utf8');
      await assert.rejects(
        f.saveDefinition({ registry: 'componentGroups', name: 'team', operation: 'rename', nextName: 'renamed' }),
        /read.only/i,
      );
      assert.equal(await readFile(library, 'utf8'), before);
      assert.match(await readFile(native, 'utf8'), /groups: \[team\]/);
      const plan = f.authoring.planDefinition(await f.editor.snapshot(), {
        registry: 'configurationPresets',
        name: 'balanced',
        operation: 'patch',
        path: ['model'],
        value: 'fixture/beta',
      });
      await writeFile(library, `${before}\n// Concurrent edit\n`);
      await assert.rejects(
        f.editor.storage.saveFilePlan(plan, async () => {
          await f.editor.storage.previewFilePlan(plan);
        }),
        /changed|Reopen/,
      );
      assert.equal(await readFile(library, 'utf8'), `${before}\n// Concurrent edit\n`);
      assert.ok((await f.history(original.session.id)).some((message) => message.info.id === original.message.info.id));
    });
  },
);
