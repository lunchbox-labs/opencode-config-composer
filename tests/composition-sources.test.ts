import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { loadCompositionSources } from '../src/config-composer/composition/sources.ts';
import { CompositionValidationError } from '../src/config-composer/composition/document.ts';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'composer-sources-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const baseFile = join(root, 'shared/config-composer.jsonc');
  const project = join(root, 'project');
  await mkdir(join(root, 'shared/profiles'), { recursive: true });
  await mkdir(join(project, '.opencode'), { recursive: true });
  await writeFile(
    baseFile,
    JSON.stringify({
      imports: ['./profiles/work.jsonc'],
      componentGroups: { review: { agents: ['build'] }, coding: { agents: ['plan'] } },
      configurationPresets: { model: { model: 'fixture/alpha' } },
      activeProfiles: ['review'],
    }),
  );
  await writeFile(
    join(root, 'shared/profiles/work.jsonc'),
    JSON.stringify({
      components: { prompts: { scope: { file: './scope.md' } } },
      profiles: {
        base: { layers: [{ componentGroup: 'review' }] },
        review: { extends: 'base', layers: [{ configurationPreset: 'model', target: { agents: ['build'] } }] },
        coding: { extends: 'base', layers: [{ componentGroup: 'coding' }] },
      },
    }),
  );
  return { root, baseFile, project, context: { root: project, baseFile, baseExplicit: true } };
}

test('explicit imports assemble named registries with declaring-file paths and immutable source origins', async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.baseFile, 'utf8');
  const result = await loadCompositionSources(f.context);
  assert.deepEqual(result.activeProfiles, ['review']);
  assert.deepEqual(
    result.orderedProfiles.map((profile) => profile.name),
    ['base', 'review'],
  );
  assert.equal(result.registry.components?.prompts?.scope.file, join(f.root, 'shared/profiles/scope.md'));
  const origin = result.provenance['/components/prompts/scope/file'];
  assert.equal(origin.sourceId, join(f.root, 'shared/profiles/work.jsonc'));
  assert.equal(origin.pointer, '/components/prompts/scope/file');
  assert.equal(result.documents.length, 2);
  assert.equal(Object.isFrozen(result.documents[0].value), true);
  assert.equal(Object.isFrozen(result.documents[0].value.componentGroups?.review), true);
  assert.equal(await readFile(f.baseFile, 'utf8'), before);
});

test('project and local active lists replace, absent inherits, and empty disables profile replay', async (t) => {
  const f = await fixture(t);
  const project = join(f.project, '.opencode/config-composer.jsonc');
  const local = join(f.project, '.opencode/config-composer.local.jsonc');
  await writeFile(project, JSON.stringify({ activeProfiles: ['coding', 'review'] }));
  await writeFile(local, '{}');
  assert.deepEqual(
    (await loadCompositionSources(f.context)).orderedProfiles.map((p) => p.name),
    ['base', 'coding', 'base', 'review'],
  );
  await writeFile(local, '{"activeProfiles":["review"]}');
  assert.deepEqual((await loadCompositionSources(f.context)).activeProfiles, ['review']);
  await writeFile(local, '{"activeProfiles":[]}');
  assert.deepEqual((await loadCompositionSources(f.context)).orderedProfiles, []);
});

test('unimported profile directory files are never discovered', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'shared/profiles/unimported.jsonc'), '{invalid');
  assert.equal((await loadCompositionSources(f.context)).documents.length, 2);
});

test('duplicate registry names report both declaring sources', async (t) => {
  const f = await fixture(t);
  const path = join(f.project, '.opencode/config-composer.jsonc');
  await writeFile(path, '{"configurationPresets":{"model":{"model":"fixture/beta"}}}');
  await assert.rejects(loadCompositionSources(f.context), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(f.baseFile));
    assert.ok(error.message.includes(path));
    assert.match(error.message, /configurationPresets\/model/);
    return true;
  });
});

test('import cycles and duplicate canonical identities fail through aliases', async (t) => {
  const f = await fixture(t);
  await symlink(f.baseFile, join(f.root, 'shared/profiles/alias.jsonc'));
  await writeFile(join(f.root, 'shared/profiles/work.jsonc'), '{"imports":["./alias.jsonc"]}');
  await assert.rejects(loadCompositionSources(f.context), /cycle/);
  await writeFile(join(f.root, 'shared/profiles/work.jsonc'), '{}');
  await symlink(join(f.root, 'shared/profiles/work.jsonc'), join(f.root, 'shared/profiles/duplicate.jsonc'));
  await writeFile(f.baseFile, '{"imports":["./profiles/work.jsonc","./profiles/duplicate.jsonc"]}');
  await assert.rejects(loadCompositionSources(f.context), /Duplicate.*import/);
});

test('imports reject activation and scoped defaults instead of applying them implicitly', async (t) => {
  const f = await fixture(t);
  for (const text of ['{"activeProfiles":[]}', '{"defaults":{}}', '{"overrides":{}}']) {
    await writeFile(join(f.root, 'shared/profiles/work.jsonc'), text);
    await assert.rejects(loadCompositionSources(f.context), /import.*definitions|Imported.*definitions/);
  }
});

test('profile ancestry and layer references validate after assembly', async (t) => {
  const f = await fixture(t);
  for (const [profiles, pattern] of [
    [{ review: { extends: 'missing' } }, /missing/],
    [{ review: { extends: 'other' }, other: { extends: 'review' } }, /cycle/],
    [{ review: { layers: [{ componentGroup: 'missing' }] } }, /missing/],
    [{ review: { layers: [{ configurationPreset: 'missing', target: { agents: ['build'] } }] } }, /missing/],
  ] as const) {
    await writeFile(join(f.root, 'shared/profiles/work.jsonc'), JSON.stringify({ profiles }));
    await assert.rejects(loadCompositionSources(f.context), pattern);
  }
});

test('missing optional scopes are allowed, but explicit missing and invalid UTF-8 imports fail', async (t) => {
  const f = await fixture(t);
  await assert.rejects(loadCompositionSources({ ...f.context, baseFile: join(f.root, 'missing.jsonc') }), /read/);
  await writeFile(join(f.root, 'shared/profiles/work.jsonc'), Buffer.from([0xff]));
  await assert.rejects(loadCompositionSources(f.context), /UTF-8/);
});

test('a base document located at the project path contributes only once', async (t) => {
  const f = await fixture(t);
  const path = join(f.project, '.opencode/config-composer.jsonc');
  await writeFile(path, '{"profiles":{"empty":{}},"activeProfiles":["empty"]}');
  const result = await loadCompositionSources({ ...f.context, baseFile: path });
  assert.equal(result.documents.length, 1);
  assert.equal(result.scopes.length, 1);
});

test('import aliases keep declaring-directory paths and are never advertised writable', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'shared/aliases'));
  await symlink(join(f.root, 'shared/profiles/work.jsonc'), join(f.root, 'shared/aliases/work.jsonc'));
  await writeFile(
    f.baseFile,
    '{"imports":["./aliases/work.jsonc"],"componentGroups":{"review":{},"coding":{}},"configurationPresets":{"model":{"model":"fixture/alpha"}}}',
  );
  const loaded = await loadCompositionSources(f.context);
  assert.equal(loaded.registry.components?.prompts?.scope.file, join(f.root, 'shared/aliases/scope.md'));
  assert.equal(loaded.documents.find((source) => source.id.endsWith('/profiles/work.jsonc'))?.writable, false);
});

test('source loading enforces import-depth and aggregate text limits', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 33; i++) {
    await writeFile(
      join(f.root, `shared/profiles/p${i}.jsonc`),
      JSON.stringify(i === 32 ? {} : { imports: [`./p${i + 1}.jsonc`] }),
    );
  }
  await writeFile(f.baseFile, '{"imports":["./profiles/p0.jsonc"]}');
  await assert.rejects(loadCompositionSources(f.context), /32 documents/);
  for (let i = 0; i < 9; i++) {
    await writeFile(
      join(f.root, `shared/profiles/p${i}.jsonc`),
      JSON.stringify({ components: { prompts: { [`prompt${i}`]: { text: 'a'.repeat(950_000) } } } }),
    );
  }
  await writeFile(
    f.baseFile,
    JSON.stringify({ imports: Array.from({ length: 9 }, (_, i) => `./profiles/p${i}.jsonc`) }),
  );
  await assert.rejects(loadCompositionSources(f.context), /8 MiB/);
});

test('unreadable imports and unknown profile references retain the declaring source and pointer', async (t) => {
  const f = await fixture(t);
  const imported = join(f.root, 'shared/profiles/work.jsonc');
  const at = (sourceId: string, pointer: string) => (error: unknown) => {
    assert.ok(error instanceof CompositionValidationError);
    assert.equal(error.diagnostic.sourceId, sourceId);
    assert.equal(error.diagnostic.pointer, pointer);
    return true;
  };
  await writeFile(imported, Buffer.from([0xff]));
  await assert.rejects(loadCompositionSources(f.context), at(f.baseFile, '/imports/0'));
  await rm(imported);
  await assert.rejects(loadCompositionSources(f.context), at(f.baseFile, '/imports/0'));
  await writeFile(imported, '{"profiles":{"review":{"extends":"missing"}}}');
  await assert.rejects(loadCompositionSources(f.context), at(imported, '/profiles/review/extends'));
  await writeFile(imported, '{}');
  await assert.rejects(loadCompositionSources(f.context), at(f.baseFile, '/activeProfiles/0'));
});

test('a base file naming local scope retains local precedence after canonical deduplication', async (t) => {
  const f = await fixture(t);
  const project = join(f.project, '.opencode/config-composer.jsonc');
  const local = join(f.project, '.opencode/config-composer.local.jsonc');
  await writeFile(project, '{"profiles":{"project":{}},"activeProfiles":["project"]}');
  for (const selection of [[], ['local']]) {
    await writeFile(local, JSON.stringify({ profiles: { local: {} }, activeProfiles: selection }));
    const result = await loadCompositionSources({ ...f.context, baseFile: local });
    assert.deepEqual(result.activeProfiles, selection);
    assert.deepEqual(
      result.scopes.map((scope) => scope.id),
      [project, local],
    );
    assert.equal(result.documents.length, 2);
  }
});

test('definition origins are deeply frozen and repeated profile occurrences own their replay metadata', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.project, '.opencode/config-composer.jsonc'), '{"activeProfiles":["review","coding"]}');
  const result = await loadCompositionSources(f.context);
  const definition = result.provenance['/profiles/base'];
  assert.ok(Object.isFrozen(result.provenance));
  assert.ok(Object.isFrozen(definition));
  assert.ok(Object.isFrozen(definition.references));
  assert.ok(Object.isFrozen(definition.overwritten));
  assert.throws(() => {
    definition.sourceId = 'changed';
  }, TypeError);
  const first = result.orderedProfiles[0].origin;
  const repeated = result.orderedProfiles[2].origin;
  first.sourceId = 'replay annotation';
  first.references.push('replay reference');
  first.overwritten.push({ ...first, references: [], overwritten: [] });
  assert.equal(repeated.sourceId, definition.sourceId);
  assert.deepEqual(repeated.references, []);
  assert.deepEqual(repeated.overwritten, []);
  assert.deepEqual(definition.references, []);
});

test('cycle and repeated-import diagnostics identify the declaring import field', async (t) => {
  const f = await fixture(t);
  const imported = join(f.root, 'shared/profiles/work.jsonc');
  const at = (sourceId: string, pointer: string) => (error: unknown) => {
    assert.ok(error instanceof CompositionValidationError);
    assert.equal(error.diagnostic.sourceId, sourceId);
    assert.equal(error.diagnostic.pointer, pointer);
    return true;
  };
  await writeFile(f.baseFile, '{"imports":["./profiles/work.jsonc"]}');
  await writeFile(imported, '{"imports":["../config-composer.jsonc"]}');
  await assert.rejects(loadCompositionSources(f.context), at(imported, '/imports/0'));
  await writeFile(imported, '{}');
  await writeFile(f.baseFile, '{"imports":["./profiles/work.jsonc","./profiles/../profiles/work.jsonc"]}');
  await assert.rejects(loadCompositionSources(f.context), at(f.baseFile, '/imports/1'));
});
