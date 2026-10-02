import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { loadCompositionSources } from '../src/config-composer/composition/sources.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'composer-sources-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (name: string, value: unknown) => {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value));
    return path;
  };
  return { root, put, context: { root, baseFile: join(root, 'missing.jsonc'), baseExplicit: false } };
}

test('shared parents replay per active chain', async (t) => {
  const { put, context } = await fixture(t);
  const baseId = await put('profiles/base.jsonc', { composition: { sourceDirectories: { shared: './snippets' } } });
  const aId = await put('profiles/a.jsonc', { extends: './base.jsonc', composition: {} });
  const bId = await put('profiles/b.jsonc', { extends: './base.jsonc', composition: {} });
  const project = await put('.opencode/config-composer.jsonc', {
    activeProfiles: ['../profiles/a.jsonc', '../profiles/b.jsonc'],
  });
  const loaded = await loadCompositionSources(context);
  assert.deepEqual(loaded.orderedProfileIds, [baseId, aId, baseId, bId]);
  assert.equal(loaded.documents.length, 4);
  assert.equal(loaded.project?.path, project);
  const base = loaded.documents.find((item) => item.id === baseId)!;
  assert.deepEqual(base.value, { composition: { sourceDirectories: { shared: './snippets' } } });
  assert.equal(base.path, baseId); // P06 resolves source paths against this declaring file.
  assert.equal(base.fingerprint, createHash('sha256').update(base.text).digest('hex'));
  assert.ok(Object.isFrozen(base));
  assert.ok(Object.isFrozen(base.value.composition));
});

test('local list replaces committed list, absent inherits, empty selects none', async (t) => {
  const { put, context } = await fixture(t);
  const a = await put('a.jsonc', { composition: {} });
  const b = await put('b.jsonc', { composition: {} });
  await put('.opencode/config-composer.jsonc', { activeProfiles: ['../a.jsonc'] });
  await put('.opencode/config-composer.local.jsonc', { activeProfiles: ['../b.jsonc'] });
  assert.deepEqual((await loadCompositionSources(context)).orderedProfileIds, [b]);
  await put('.opencode/config-composer.local.jsonc', {});
  assert.deepEqual((await loadCompositionSources(context)).orderedProfileIds, [a]);
  await put('.opencode/config-composer.local.jsonc', { activeProfiles: [] });
  assert.deepEqual((await loadCompositionSources(context)).orderedProfileIds, []);
  await put('.opencode/config-composer.jsonc', { activeProfiles: ['../nonexistent.jsonc'] });
  assert.deepEqual((await loadCompositionSources(context)).orderedProfileIds, []);
});

test('uses the adapter supplied root for worktrees and non-Git directories', async (t) => {
  const { root, put, context } = await fixture(t);
  await put('.opencode/config-composer.jsonc', {});
  await put('nested/.opencode/config-composer.local.jsonc', {});
  assert.equal((await loadCompositionSources(context)).project?.path, join(root, '.opencode/config-composer.jsonc'));
  const nested = await loadCompositionSources({ ...context, root: join(root, 'nested') });
  assert.equal(nested.project, undefined);
  assert.equal(nested.local?.path, join(root, 'nested/.opencode/config-composer.local.jsonc'));
});

test('optional missing base needs project composition; explicit missing base errors', async (t) => {
  const { put, context } = await fixture(t);
  await assert.rejects(loadCompositionSources(context), /configuration|source/i);
  await put('.opencode/config-composer.jsonc', {});
  assert.equal((await loadCompositionSources(context)).base, undefined);
  await assert.rejects(loadCompositionSources({ ...context, baseExplicit: true }), /configuration|source/i);
  const baseFile = await put('base.jsonc', { activeProfiles: ['ignored.jsonc'], agent: {} });
  const loaded = await loadCompositionSources({ ...context, baseFile });
  assert.equal(loaded.base?.path, baseFile);
  assert.deepEqual(loaded.orderedProfileIds, []);
});

test('base-only legacy documents are available without profiles', async (t) => {
  const { put, context } = await fixture(t);
  const baseFile = await put('base.jsonc', { agent: {} });
  const loaded = await loadCompositionSources({ ...context, baseFile, baseExplicit: true });
  assert.deepEqual(loaded.documents, [loaded.base]);
  assert.deepEqual(loaded.orderedProfileIds, []);
});

test('canonical aliases reject cycles and duplicate active identities', async (t) => {
  const { root, put, context } = await fixture(t);
  const profile = await put('a.jsonc', { extends: './alias.jsonc', composition: {} });
  await symlink(profile, join(root, 'alias.jsonc'));
  await put('.opencode/config-composer.jsonc', { activeProfiles: ['../a.jsonc'] });
  await assert.rejects(loadCompositionSources(context), /cycle/i);
  await put('a.jsonc', { composition: {} });
  await put('.opencode/config-composer.jsonc', { activeProfiles: ['../a.jsonc', '../alias.jsonc'] });
  await assert.rejects(loadCompositionSources(context), /duplicate/i);
  await put('.opencode/config-composer.jsonc', { activeProfiles: ['../alias.jsonc'] });
  const loaded = await loadCompositionSources(context);
  const alias = loaded.documents.find((item) => item.id === profile)!;
  assert.equal(alias.id, await realpath(profile));
  assert.equal(alias.writable, false);
});

test('allows 32 chain levels and rejects 33', async (t) => {
  const { put, context } = await fixture(t);
  for (let i = 0; i < 33; i++) {
    await put(`p${i}.jsonc`, { ...(i > 0 ? { extends: `./p${i - 1}.jsonc` } : {}), composition: {} });
  }
  await put('.opencode/config-composer.jsonc', { activeProfiles: ['../p31.jsonc'] });
  assert.equal((await loadCompositionSources(context)).orderedProfileIds.length, 32);
  await put('.opencode/config-composer.jsonc', { activeProfiles: ['../p32.jsonc'] });
  await assert.rejects(loadCompositionSources(context), /32|depth/i);
});

test('allows 64 active profiles and rejects 65', async (t) => {
  const { put, context } = await fixture(t);
  const activeProfiles: string[] = [];
  for (let i = 0; i < 65; i++) {
    await put(`p${i}.jsonc`, { composition: {} });
    activeProfiles.push(`../p${i}.jsonc`);
  }
  await put('.opencode/config-composer.jsonc', { activeProfiles: activeProfiles.slice(0, 64) });
  assert.equal((await loadCompositionSources(context)).orderedProfileIds.length, 64);
  await put('.opencode/config-composer.jsonc', { activeProfiles });
  await assert.rejects(loadCompositionSources(context), /64/);
});

test('limits total unique text to 8 MiB without charging replay twice', async (t) => {
  const { root, put, context } = await fixture(t);
  await put('parent.jsonc', { composition: {} });
  const text = JSON.stringify({ composition: {} });
  await writeFile(join(root, 'parent.jsonc'), text.padEnd(1024 * 1024));
  const activeProfiles: string[] = [];
  for (let i = 0; i < 8; i++) {
    const path = await put(`p${i}.jsonc`, { extends: './parent.jsonc', composition: {} });
    const content = JSON.stringify({ extends: './parent.jsonc', composition: {} });
    await writeFile(path, content.padEnd(1024 * 1024));
    activeProfiles.push(`../p${i}.jsonc`);
  }
  await put('.opencode/config-composer.jsonc', { activeProfiles: activeProfiles.slice(0, 6) });
  assert.equal((await loadCompositionSources(context)).orderedProfileIds.length, 12);
  await put('.opencode/config-composer.jsonc', { activeProfiles });
  await assert.rejects(loadCompositionSources(context), /8 MiB/);
});

test('rejects oversized, malformed, unsafe, non-UTF8 and non-file sources', async (t) => {
  const { root, put, context } = await fixture(t);
  await put('.opencode/config-composer.jsonc', { activeProfiles: ['../bad.jsonc'] });
  const path = join(root, 'bad.jsonc');
  for (const text of [
    ' '.repeat(1024 * 1024 + 1),
    '{',
    '{"composition":{},"composition":{}}',
    '{"composition":{"__proto__":{}}}',
    Buffer.from([0xff]),
  ]) {
    await writeFile(path, text);
    await assert.rejects(loadCompositionSources(context));
  }
  await rm(path);
  await mkdir(path);
  await assert.rejects(loadCompositionSources(context), /regular file/);
});

test('validates activation and single parent metadata and missing parents', async (t) => {
  const { put, context } = await fixture(t);
  for (const activeProfiles of [null, 'a.jsonc', [1], [''], ['https://example.com/a.jsonc']]) {
    await put('.opencode/config-composer.jsonc', { activeProfiles });
    await assert.rejects(loadCompositionSources(context));
  }
  await put('.opencode/config-composer.jsonc', { activeProfiles: ['../a.jsonc'] });
  for (const value of [
    { extends: ['b.jsonc'], composition: {} },
    { extends: 'missing.jsonc', composition: {} },
    { composition: [] },
    { composition: {}, extra: true },
    { composition: { activeProfiles: [] } },
  ]) {
    await put('a.jsonc', value);
    await assert.rejects(loadCompositionSources(context));
  }
});

test('keeps read-only file metadata and accepts commented JSONC', async (t) => {
  const { root, put, context } = await fixture(t);
  const path = await put('.opencode/config-composer.jsonc', {});
  await writeFile(path, '{ // comment\n "activeProfiles": [],\n}');
  await chmod(path, 0o444);
  const loaded = await loadCompositionSources(context);
  assert.equal(loaded.project?.writable, false);
  assert.equal(loaded.project.path, join(root, '.opencode/config-composer.jsonc'));
});

test('shared canonical profiles resolve parents from each occurrence alias directory', async (t) => {
  const { root, put, context } = await fixture(t);
  const shared = await put('shared.jsonc', { extends: './parent.jsonc', composition: {} });
  const leftParent = await put('left/parent.jsonc', { composition: {} });
  const rightParent = await put('right/parent.jsonc', { composition: {} });
  await symlink(shared, join(root, 'left/alias.jsonc'));
  await symlink(shared, join(root, 'right/alias.jsonc'));
  const left = await put('left/active.jsonc', { extends: './alias.jsonc', composition: {} });
  const right = await put('right/active.jsonc', { extends: './alias.jsonc', composition: {} });
  for (const reversed of [false, true]) {
    await put('.opencode/config-composer.jsonc', {
      activeProfiles: reversed ? [right, left] : [left, right],
    });
    const loaded = await loadCompositionSources(context);
    assert.deepEqual(
      loaded.orderedProfileIds,
      reversed
        ? [rightParent, shared, right, leftParent, shared, left]
        : [leftParent, shared, left, rightParent, shared, right],
    );
    assert.equal(loaded.documents.filter((source) => source.id === shared).length, 1);
    assert.equal(loaded.documents.length, 6);
  }
});
