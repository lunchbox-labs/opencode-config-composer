import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfiguration } from '../src/config-composer/configuration.ts';
import { resolveLegacy } from '../src/config-composer/composition/legacy.ts';
import type { NativeInput, SourceDocument } from '../src/config-composer/composition/types.ts';
import { composePrompts } from '../src/config-composer/prompts.ts';
import { SettingsError, applyDefaults, readSettings } from '../src/config-composer/settings.ts';

function source(value: Record<string, unknown> = {}): SourceDocument {
  const text = JSON.stringify(value);
  return {
    id: '/config/composer.jsonc',
    path: '/config/composer.jsonc',
    text,
    fingerprint: createHash('sha256').update(text).digest('hex'),
    writable: true,
    value,
  };
}

const document = source({
  agent: {
    groups: {
      base: { modelRef: 'preset:balanced', prompt: { prepend: ['Base'] } },
      developers: { model: 'fixture/next', prompt: { append: ['Developer'] } },
      reviewers: { modelRef: 'opencode:small_model', variant: 'low' },
    },
    modelPresets: { balanced: { model: 'fixture/fast', variant: 'high' } },
    prompts: { defaults: { prepend: ['Default'] }, overrides: { 'team/lead': { append: ['Lead'] } } },
  },
});

const native: NativeInput = {
  model: 'fixture/main',
  small_model: 'fixture/small',
  default_agent: 'worker',
  agent: {
    worker: { groups: ['base', 'developers'], prompt: 'Worker' },
    reviewer: { options: { groups: ['base', 'reviewers'] }, variant: 'medium' },
    pinned: { groups: ['base'], model: 'fixture/pinned' },
    'team/lead': { groups: ['base'], prompt: 'Leader' },
  },
};

test('native input has no invented source', () => {
  const result = resolveLegacy(source(), {
    model: 'fixture/main',
    agent: { build: { model: 'fixture/pin' } },
    permission: { bash: 'ask' },
  });
  assert.notEqual(result.provenance['/model'], undefined);
  assert.equal(result.provenance['/model'].sourceId, undefined);
  assert.equal(result.provenance['/model'].operation, 'native');
  assert.equal(result.provenance['/agent/build/model'].sourceId, undefined);
  assert.equal(result.provenance['/permission/bash'].operation, 'native');
  assert.equal(result.sources.length, 1);
});

test('revision reflects content, native input and ordered memberships deterministically', () => {
  const result = resolveLegacy(document, native);
  assert.match(result.revision, /^[a-f0-9]{64}$/);
  assert.equal(result.revision, resolveLegacy(structuredClone(document), structuredClone(native)).revision);
  assert.notEqual(
    result.revision,
    resolveLegacy({ ...document, text: document.text + '\n', fingerprint: 'changed' }, native).revision,
  );
  assert.notEqual(result.revision, resolveLegacy(document, { ...native, model: 'fixture/other' }).revision);
  const reversed = structuredClone(native);
  assert.ok(reversed.agent !== undefined);
  reversed.agent.worker.groups = ['developers', 'base'];
  assert.notEqual(result.revision, resolveLegacy(document, reversed).revision);
});

test('legacy settings retain group order and explicit pins with overwritten reference origins', () => {
  const result = resolveLegacy(document, native);
  assert.deepEqual(result.settings, readSettings(document.value));
  assert.equal(result.model, native.model);
  assert.equal(result.small_model, native.small_model);
  assert.equal(result.default_agent, native.default_agent);
  const agents = structuredClone(native.agent ?? {});
  applyDefaults(agents, result.settings.groups, { modelPresets: result.settings.modelPresets, native });
  assert.equal(agents.worker.model, 'fixture/next');
  assert.equal(agents.worker.variant, 'high');
  assert.equal(agents.reviewer.model, 'fixture/small');
  assert.equal(agents.reviewer.variant, 'medium');
  assert.equal(agents.pinned.model, 'fixture/pinned');
  const origin = result.provenance['/agent/worker/model'];
  assert.equal(origin.pointer, '/agent/groups/developers/model');
  assert.equal(origin.sourceId, document.id);
  assert.equal(origin.overwritten[0].pointer, '/agent/groups/base/modelRef');
  assert.deepEqual(origin.overwritten[0].references, ['/agent/modelPresets/balanced/model']);
  assert.deepEqual(result.provenance['/agent/reviewer/model'].references, ['/small_model']);
  assert.equal(result.provenance['/agent/reviewer/variant'].operation, 'native');
  assert.equal(result.provenance['/agent/pinned/model'].sourceId, undefined);
});

test('repeated prompt composition retains baseline text, inheritance and escaped origin paths', async () => {
  const before = structuredClone(native);
  const first = resolveLegacy(document, native);
  const second = resolveLegacy(document, native);
  const expected = {
    worker: 'Default\n\nBase\n\nWorker\n\nDeveloper',
    'team/lead': 'Default\n\nBase\n\nLeader\n\nLead',
  };
  assert.deepEqual(await composePrompts(native.agent ?? {}, first.settings), expected);
  assert.deepEqual(await composePrompts(native.agent ?? {}, second.settings), expected);
  assert.deepEqual(native, before);
  const origin = first.provenance['/agent/team~1lead/prompt'];
  assert.equal(origin.operation, 'merge');
  assert.ok(origin.references.includes('/agent/prompts/overrides/team~1lead/append/0'));
  assert.ok(origin.references.includes('/agent/groups/base/prompt/prepend/0'));
  assert.equal(origin.overwritten[0].operation, 'native');
});

test('disabled agents and pinned agents preserve legacy validation boundaries', () => {
  assert.doesNotThrow(() => resolveLegacy(source(), { agent: { off: { disable: true, groups: ['missing'] } } }));
  assert.throws(() => resolveLegacy(source(), { agent: { on: { groups: ['missing'] } } }), SettingsError);
  const missing = source({ agent: { groups: { base: { modelRef: 'opencode:small_model' } } } });
  assert.doesNotThrow(() => resolveLegacy(missing, { agent: { pinned: { groups: ['base'], model: 'fixture/pin' } } }));
});

test('validated loader exposes source identity without changing files or relative prompt behavior', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'composition-contracts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'config-composer.jsonc');
  const text = '// preserved\n{"sourceDirectories":{"shared":"./references"},"agent":{}}\n';
  await writeFile(path, text);
  const loaded = await loadConfiguration({}, root);
  assert.notEqual(loaded.source, undefined);
  assert.equal(loaded.source.id, path);
  assert.equal(loaded.source.path, path);
  assert.equal(loaded.source.text, text);
  assert.equal(loaded.source.fingerprint, createHash('sha256').update(text).digest('hex'));
  assert.equal(loaded.source.writable, true);
  assert.deepEqual(resolveLegacy(loaded.source, {}).settings, loaded.settings);
  assert.equal(loaded.settings.promptSources.shared, join(root, 'references'));
  assert.equal(await readFile(path, 'utf8'), text);
});

test('definition provenance cannot mask native agents named groups or prompts', () => {
  const result = resolveLegacy(document, {
    agent: { groups: { model: 'fixture/native' }, prompts: { prompt: 'Native' } },
  });
  assert.equal(result.provenance['/agent/groups'].operation, 'native');
  assert.equal(result.provenance['/agent/prompts'].sourceId, undefined);
  assert.equal(result.provenance['/settings/groups/base/modelRef'].pointer, '/agent/groups/base/modelRef');
  assert.equal(result.provenance['/settings/groups/base/modelRef'].sourceId, document.id);
});

test('native variant without a group has no fabricated overwrite', () => {
  const result = resolveLegacy(source(), { agent: { worker: { variant: 'high' } } });
  assert.deepEqual(result.provenance['/agent/worker/variant'].overwritten, []);
});

test('implicit empty settings do not claim an authored source location', () => {
  const result = resolveLegacy(source(), {});
  assert.deepEqual(result.provenance, {});
});

test('prompt inheritance exclusions retain only the contributing reference paths', async () => {
  const custom = source({
    agent: {
      groups: { base: { prompt: { prepend: ['Group'] } } },
      prompts: {
        defaults: { prepend: ['Default'] },
        overrides: { worker: { inheritDefaults: false, inheritGroups: false, append: ['Own'] } },
      },
    },
  });
  const agents = { worker: { groups: ['base'], prompt: 'Body' } };
  const result = resolveLegacy(custom, { agent: agents });
  assert.deepEqual(await composePrompts(agents, result.settings), { worker: 'Body\n\nOwn' });
  assert.deepEqual(result.provenance['/agent/worker/prompt'].references, [
    '/agent/worker/prompt',
    '/agent/prompts/overrides/worker/append/0',
  ]);
});

test('unresolved native agent defaults do not invent an effective agent model', () => {
  const result = resolveLegacy(source(), { model: 'fixture/main', small_model: 'fixture/small', agent: { title: {} } });
  assert.equal(Object.hasOwn(result.provenance, '/agent/title/model'), false);
  assert.equal(result.provenance['/model'].operation, 'native');
});
