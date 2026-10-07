import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compositionRevision, observeNativeFiles } from '../src/config-composer/composition/revision.ts';
import { loadCompositionSources } from '../src/config-composer/composition/sources.ts';
import { resolveProfileRuntime } from '../src/config-composer/composition/runtime.ts';

test('native file observation accepts directory aliases while guarding exact bytes and directory retargets', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'composer-native-observation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const canonical = join(root, 'canonical');
  const alternate = join(root, 'alternate');
  const alias = join(root, 'alias');
  await mkdir(canonical);
  await mkdir(alternate);
  const text = '{"model":"fixture/alpha"}\n';
  const native = join(canonical, 'opencode.jsonc');
  await writeFile(native, text);
  await writeFile(join(alternate, 'opencode.jsonc'), text);
  // Junctions require no Windows symlink privilege and remain real directory aliases on POSIX.
  await symlink(canonical, alias, 'junction');
  const original = await observeNativeFiles(canonical);
  assert.equal(
    await observeNativeFiles(alias),
    original,
    'a lexical configuration-directory alias must not report unchanged native JSON as edited',
  );
  await writeFile(native, text + '// Saved native JSON edit\n');
  const edited = await observeNativeFiles(alias);
  assert.notEqual(edited, original, 'the guard retains exact native JSON bytes, including comments');
  assert.equal(edited, await observeNativeFiles(canonical));
  await writeFile(native, text);
  assert.equal(await observeNativeFiles(alias), original);
  await rm(alias, { recursive: true, force: true });
  await symlink(alternate, alias, 'junction');
  assert.equal(await readFile(join(alias, 'opencode.jsonc'), 'utf8'), text);
  assert.notEqual(
    await observeNativeFiles(alias),
    original,
    'retargeting the configuration directory changes identity even when native JSON bytes match',
  );
  assert.equal(await observeNativeFiles(canonical), original);
  const missing = join(root, 'missing');
  const absent = await observeNativeFiles(missing);
  assert.equal(await observeNativeFiles(missing), absent, 'missing directories remain observable deterministically');
  await mkdir(missing);
  await writeFile(join(missing, 'opencode.json'), text);
  assert.notEqual(await observeNativeFiles(missing), absent, 'creating native JSON changes the absent fingerprint');
});

test('implicit shared Composer sources attest the same revision through a configuration-directory alias', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'composer-source-observation-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const canonical = join(root, 'physical', 'canonical');
  const alias = join(root, 'alias');
  const project = join(root, 'project');
  await mkdir(canonical, { recursive: true });
  await mkdir(project);
  await symlink(canonical, alias, 'junction');
  const baseFile = join(canonical, 'config-composer.jsonc');
  await writeFile(baseFile, '{"defaults":{"model":"fixture/beta"}}');
  const previous = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = alias;
  t.after(() => {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, 'OPENCODE_CONFIG_DIR');
    } else {
      process.env.OPENCODE_CONFIG_DIR = previous;
    }
  });
  const implicit = await loadCompositionSources({ root: project, baseExplicit: false });
  const explicit = await loadCompositionSources({ root: project, baseFile, baseExplicit: true });
  assert.deepEqual(
    implicit.documents.map(({ id, fingerprint }) => [id, fingerprint]),
    explicit.documents.map(({ id, fingerprint }) => [id, fingerprint]),
  );
  const implicitRuntime = await resolveProfileRuntime(implicit, { model: 'fixture/alpha' });
  const explicitRuntime = await resolveProfileRuntime(explicit, { model: 'fixture/alpha' });
  assert.deepEqual(implicitRuntime, explicitRuntime);
  assert.deepEqual(
    compositionRevision(implicit, implicitRuntime, []),
    compositionRevision(explicit, explicitRuntime, []),
    'a directory alias must not create a different applied revision for identical shared sources',
  );
  const explicitAlias = await loadCompositionSources({
    root: project,
    baseFile: join(alias, 'config-composer.jsonc'),
    baseExplicit: true,
  });
  assert.ok(
    explicitAlias.paths.has(join(alias, 'config-composer.jsonc')),
    'explicit authored source paths remain captured',
  );
  await writeFile(join(root, 'parent.jsonc'), '{"defaults":{"model":"fixture/lexical-parent"}}');
  await writeFile(join(root, 'physical', 'parent.jsonc'), '{"defaults":{"model":"fixture/physical-parent"}}');
  const relativeBase = await loadCompositionSources({ root: project, baseFile: '../parent.jsonc', baseExplicit: true });
  assert.equal(
    relativeBase.scopes[0].value.defaults?.model,
    'fixture/lexical-parent',
    'explicit relative baseFile still resolves against the configured lexical directory parent',
  );
});
