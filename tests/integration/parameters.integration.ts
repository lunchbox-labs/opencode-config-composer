import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compositionFixture } from './composition-fixture.ts';
import { contentEditor } from './content-editor.ts';
import type { ParameterField } from '../../src/config-composer/composition/parameter-authoring.ts';

test(
  'installed parameter editor validates the native catalog and persists typed changes, inherited resets and fresh dispatch',
  { timeout: 180_000 },
  async (t) => {
    const f = await compositionFixture(t, 'parameter-authoring');
    const definitions = join(f.host.configRoot, 'definitions/models.jsonc');
    await mkdir(join(f.host.configRoot, 'definitions'));
    await f.write(definitions, {
      configurationPresets: {
        parent: {
          model: 'fixture/alpha',
          parameters: { temperature: 0.2, topP: 0.9, options: { reasoningEffort: 'low' } },
        },
        active: { modelRef: 'preset:parent' },
      },
    });
    await f.write(f.paths.shared, {
      imports: ['./definitions/models.jsonc'],
      componentGroups: { work: { agents: ['worker'] } },
      profiles: {
        work: {
          layers: [{ componentGroup: 'work' }, { configurationPreset: 'active', target: { agents: ['worker'] } }],
        },
      },
      activeProfiles: ['work'],
    });
    await f.host.start();
    const e = await contentEditor(f);
    const original = await f.send();
    assert.equal(original.captured.temperature, 0.2);
    assert.equal(original.captured.top_p, 0.9);
    assert.equal(original.captured.reasoning_effort, 'low');
    const shared = await readFile(f.paths.shared, 'utf8');
    const native = await readFile(join(f.host.configRoot, 'opencode.jsonc'), 'utf8');
    const edit = async (field: ParameterField, text: string, save = true) => {
      const { snapshot, selected } = await e.target(definitions, 'Preset: active');
      const plan = e.planParameter(snapshot, selected, field, text);
      const catalog = await e.catalog();
      e.parameterReview(snapshot, selected, await f.editor.storage.previewFilePlan(plan), catalog);
      if (save) {
        await f.editor.storage.saveFilePlan(plan, async () => {
          e.parameterReview(snapshot, selected, await f.editor.storage.previewFilePlan(plan), catalog);
        });
      }
      return plan;
    };
    const unchanged = await readFile(definitions, 'utf8');
    for (const [field, value, message] of [
      ['temperature', 'Infinity', /finite|temperature/i],
      ['topP', '1.1', /topP|range|finite/i],
      ['topK', '1.2', /integer/i],
      ['options', '{"x":1,"x":2}', /duplicate/i],
      ['options', '{"reasoningEffort":false}', /string/i],
      ['topK', '3', /does not support/],
      ['maxOutputTokens', '257', /output limit/],
    ] as const) {
      await assert.rejects(edit(field, value), message);
      assert.equal(await readFile(definitions, 'utf8'), unchanged);
    }
    await edit('temperature', '0.7', false);
    assert.equal(await readFile(definitions, 'utf8'), unchanged, 'an unconfirmed proposal never writes');
    for (const [field, text] of [
      ['temperature', '0.45'],
      ['topP', '0.7'],
      ['maxOutputTokens', '128'],
      ['options', '{"reasoningEffort":"medium"}'],
    ] as const) {
      await edit(field, text);
    }
    assert.equal((await f.send(original.session.id)).captured.temperature, 0.2, 'save awaits explicit reload');
    await f.editor.reload();
    const next = (await f.send(original.session.id)).captured;
    assert.equal(next.temperature, 0.45);
    assert.equal(next.top_p, 0.7);
    assert.equal(next.max_tokens, 128);
    assert.equal(next.reasoning_effort, 'medium');
    await edit('temperature', '');
    await f.editor.reload();
    const inherited = (await f.send(original.session.id)).captured;
    assert.equal(inherited.temperature, 0.2);
    assert.equal(inherited.top_p, 0.7, 'single-field removal retains siblings');
    await edit('reset', '');
    await f.editor.reload();
    const reset = (await f.send(original.session.id)).captured;
    assert.equal(reset.temperature, 0.2);
    assert.equal(reset.top_p, 0.9);
    assert.equal(reset.reasoning_effort, 'low', 'removed options do not survive reload');
    assert.notEqual(reset.max_tokens, 128);
    const stale = await edit('temperature', '0.6', false);
    const concurrent = `${await readFile(definitions, 'utf8')}\n// concurrent edit\n`;
    await writeFile(definitions, concurrent);
    await assert.rejects(e.save(stale), /changed/);
    assert.equal(await readFile(definitions, 'utf8'), concurrent);
    assert.match(concurrent, /Preserve fixture comments/);
    assert.equal(await readFile(f.paths.shared, 'utf8'), shared);
    // Reload changes the plugin token; all other native fields remain byte-for-byte equivalent.
    const beforeNative = JSON.parse(native) as Record<string, unknown>;
    const afterNative = JSON.parse(await readFile(join(f.host.configRoot, 'opencode.jsonc'), 'utf8')) as Record<
      string,
      unknown
    >;
    delete beforeNative.plugin;
    delete afterNative.plugin;
    assert.deepEqual(afterNative, beforeNative);
    assert.ok((await f.history(original.session.id)).some((message) => message.info.id === original.message.info.id));
  },
);
