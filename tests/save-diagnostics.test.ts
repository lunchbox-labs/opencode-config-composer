import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { type TestContext, test } from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { record } from '../src/config-composer/settings.ts';
import { packageName } from '../src/config-composer/package-name.ts';
import { type FilePlan, loadSnapshot, planChange, saveFilePlan } from '../src/config-composer/storage.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'save-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'opencode.jsonc'), JSON.stringify({ plugin: [packageName] }));
  await writeFile(join(root, 'config-composer.jsonc'), '{"configurationPresets":{"balanced":{"model":"fixture/a"}}}');
  return root;
}

function details(error: unknown): Record<string, unknown> {
  assert.ok(error instanceof Error);
  assert.ok('details' in error && record(error.details));
  return error.details;
}

for (const duringValidation of [false, true]) {
  test(`stale source reports content and path without disclosing bytes (${duringValidation})`, async (t) => {
    const root = await fixture(t);
    const plan = planChange(await loadSnapshot(root), {
      kind: 'preset',
      name: 'balanced',
      choice: { model: 'fixture/b' },
    });
    const path = plan.edits[0].file.path;
    const external = plan.edits[0].file.text + '\n// PRIVATE_SOURCE_BODY';
    if (!duringValidation) {
      await writeFile(path, external);
    }
    await assert.rejects(
      saveFilePlan(plan, async () => {
        if (duringValidation) {
          await writeFile(path, external);
        }
      }),
      (error: unknown) => {
        const value = details(error);
        assert.equal(value.phase, 'before-writes');
        assert.deepEqual(value.input, { path, category: 'content' });
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(path));
        assert.doesNotMatch(error.message, /PRIVATE_SOURCE_BODY/);
        return true;
      },
    );
    assert.equal(await readFile(path, 'utf8'), external);
  });
}

test('mode-only rejection identifies permissions and retains concurrent mode', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX modes');
    return;
  }
  const root = await fixture(t);
  const path = join(root, 'config-composer.jsonc');
  await chmod(path, 0o664);
  const plan = planChange(await loadSnapshot(root), {
    kind: 'preset',
    name: 'balanced',
    choice: { model: 'fixture/b' },
  });
  await assert.rejects(
    saveFilePlan(plan, () => chmod(path, 0o600)),
    (error: unknown) => {
      assert.deepEqual(details(error).input, { path, category: 'permissions' });
      return true;
    },
  );
  assert.equal((await fs.promises.stat(path)).mode & 0o777, 0o600);
  assert.equal(await readFile(path, 'utf8'), plan.edits[0].file.text);
});

for (const outcome of ['restored', 'external-bytes-preserved', 'restore-failed'] as const) {
  test(`later injected write failure reports ${outcome} and preserves the original failure`, async (t) => {
    const root = await fixture(t);
    const snapshot = await loadSnapshot(root);
    const plan: FilePlan = {
      snapshot,
      description: 'diagnostic fixture',
      edits: snapshot.files.map((file) => ({ file, text: file.text + '\n' })),
    };
    const original = new Error('Injected second write failure');
    const rename = fs.promises.rename;
    let calls = 0;
    t.after(() => {
      fs.promises.rename = rename;
      syncBuiltinESMExports();
    });
    fs.promises.rename = async (from, to) => {
      calls++;
      if (calls === 2) {
        if (outcome === 'external-bytes-preserved') {
          await writeFile(plan.edits[0].file.path, 'PRIVATE_EXTERNAL_BYTES');
        }
        throw original;
      }
      if (calls === 3 && outcome === 'restore-failed') {
        throw new Error('Injected restore failure');
      }
      return rename(from, to);
    };
    syncBuiltinESMExports();
    await assert.rejects(
      saveFilePlan(plan, async () => {}),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.cause, original);
        assert.match(error.message, /Injected second write failure/);
        assert.doesNotMatch(error.message, /PRIVATE_EXTERNAL_BYTES/);
        assert.equal(details(error).phase, 'rollback');
        assert.deepEqual(details(error).outcomes, [{ path: plan.edits[0].file.path, outcome }]);
        return true;
      },
    );
    assert.equal(
      await readFile(plan.edits[0].file.path, 'utf8'),
      outcome === 'restored'
        ? plan.edits[0].file.text
        : outcome === 'external-bytes-preserved'
          ? 'PRIVATE_EXTERNAL_BYTES'
          : plan.edits[0].text,
    );
    assert.equal(await readFile(plan.edits[1].file.path, 'utf8'), plan.edits[1].file.text);
    assert.equal(calls, outcome === 'external-bytes-preserved' ? 2 : 3);
    assert.ok(!(await readdir(root)).some((name) => name.endsWith('.tmp') || name.endsWith('.lock')));
  });
}

test('rollback reports removal of a newly created source', async (t) => {
  const root = await fixture(t);
  const project = join(root, 'project');
  await mkdir(project);
  const snapshot = await loadSnapshot(root, project);
  const path = join(project, '.opencode/config-composer.local.jsonc');
  const plan: FilePlan = {
    snapshot,
    description: 'create',
    edits: [
      { file: { path, text: '{}', mode: 0o600, writeRoot: project }, text: '{}\n', create: true },
      { file: { ...snapshot.configFile, path: join(root, 'missing.jsonc') }, text: '{}' },
    ],
  };
  await assert.rejects(
    saveFilePlan(plan, async () => {}),
    (error: unknown) => {
      assert.deepEqual(details(error).outcomes, [{ path, outcome: 'removed' }]);
      assert.ok(error instanceof Error);
      assert.match(error.message, /ENOENT/);
      return true;
    },
  );
  await assert.rejects(readFile(path), /ENOENT/);
  await assert.rejects(fs.promises.stat(join(project, '.opencode')), /ENOENT/);
});

test('bounded outcomes still roll back every applied file', async (t) => {
  const root = await fixture(t);
  const snapshot = await loadSnapshot(root);
  const edits = [];
  for (let index = 0; index < 12; index++) {
    const path = join(root, `input-${index}.jsonc`);
    await writeFile(path, '{}');
    edits.push({ file: { path, text: '{}', mode: 0o600 }, text: '{}\n' });
  }
  edits.push({ file: { path: join(root, 'missing.jsonc'), text: '{}', mode: 0o600 }, text: '{}\n' });
  await assert.rejects(
    saveFilePlan({ snapshot, edits, description: 'many edits' }, async () => {}),
    (error: unknown) => {
      const value = details(error);
      assert.ok(Array.isArray(value.outcomes));
      assert.equal(value.outcomes.length, 8);
      assert.equal(value.omittedOutcomes, 4);
      assert.ok(error instanceof Error);
      assert.match(error.message, /4 more/);
      return true;
    },
  );
  for (const edit of edits.slice(0, -1)) {
    assert.equal(await readFile(edit.file.path, 'utf8'), '{}');
  }
});

test('composition revision identifies changed bytes and selection identifies its state path', async (t) => {
  const { verifyCompositionInputs } = await import('../src/config-composer/composition/revision.ts');
  const { verifySelection } = await import('../src/config-composer/composition/selection-state.ts');
  const root = await fixture(t);
  const snapshot = await loadSnapshot(root);
  const path = snapshot.settingsFile.path;
  await writeFile(path, snapshot.settingsFile.text + '\n');
  await assert.rejects(verifyCompositionInputs(snapshot.sources, []), (error: unknown) => {
    assert.deepEqual(details(error).input, { path, category: 'content' });
    return true;
  });
  const selection = join(root, 'selection.json');
  await writeFile(selection, JSON.stringify({ version: 1, revision: 1, selection: { mode: 'defaults' } }));
  await assert.rejects(verifySelection({ path: selection, revision: 0 }), (error: unknown) => {
    assert.deepEqual(details(error).input, { path: selection, category: 'selection' });
    return true;
  });
});

test('an existing save lock is a pre-write rejection and remains untouched', async (t) => {
  const root = await fixture(t);
  const plan = planChange(await loadSnapshot(root), {
    kind: 'preset',
    name: 'balanced',
    choice: { model: 'fixture/b' },
  });
  const lock = join(root, '.config-composer.lock');
  await writeFile(lock, 'another-owner');
  await assert.rejects(
    saveFilePlan(plan, async () => {}),
    (error: unknown) => {
      assert.equal(details(error).phase, 'before-writes');
      assert.ok(error instanceof Error);
      assert.match(error.message, /Another settings edit/);
      return true;
    },
  );
  assert.equal(await readFile(lock, 'utf8'), 'another-owner');
  assert.equal(await readFile(plan.edits[0].file.path, 'utf8'), plan.edits[0].file.text);
});

test('new agent and changed native environment report only observed identifiers', async (t) => {
  const { observedNativeVariables } = await import('../src/config-composer/composition/native-variables.ts');
  const root = await fixture(t);
  const plan = planChange(await loadSnapshot(root), {
    kind: 'preset',
    name: 'balanced',
    choice: { model: 'fixture/b' },
  });
  const path = join(root, 'agents/new.md');
  await mkdir(join(root, 'agents'));
  await writeFile(path, '---\ndescription: New\n---\nPRIVATE_BODY');
  await assert.rejects(
    saveFilePlan(plan, async () => {}),
    (error: unknown) => {
      assert.deepEqual(details(error).input, { path, category: 'source-list' });
      return true;
    },
  );
  assert.throws(
    () =>
      observedNativeVariables({
        environment: new Map([['COMPOSER_TEST_MISSING_ENV_129', 'PRIVATE_VALUE']]),
        files: new Map(),
        documents: new Map(),
      }),
    (error: unknown) => {
      assert.deepEqual(details(error).input, { path: 'env:COMPOSER_TEST_MISSING_ENV_129', category: 'environment' });
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /PRIVATE_VALUE/);
      return true;
    },
  );
});

test('long diagnostic identifiers and messages are bounded and neutralize terminal controls', async () => {
  const { changedInput, saveFailure } = await import('../src/config-composer/save-diagnostics.ts');
  const path = '/input/\u001b[31m' + 'x'.repeat(2000);
  const original = changedInput('Settings changed.', path, 'identity');
  const error = saveFailure(original, [{ path, outcome: 'restore-failed' }], 1);
  assert.equal(error.cause, original);
  assert.ok(error.message.length < 1500);
  assert.equal(error.message.includes('\u001b'), false);
  assert.equal(error.details.input?.path.length, 320);
  assert.equal(error.details.outcomes?.[0].path.length, 320);
});

for (const replacement of ['symlink', 'missing'] as const) {
  test(`a ${replacement} native source reports its observed path`, async (t) => {
    const root = await fixture(t);
    const plan = planChange(await loadSnapshot(root), {
      kind: 'preset',
      name: 'balanced',
      choice: { model: 'fixture/b' },
    });
    const path = plan.snapshot.configFile.path;
    await rm(path);
    if (replacement === 'symlink') {
      const target = join(root, 'replacement.jsonc');
      await writeFile(target, plan.snapshot.configFile.text);
      await fs.promises.symlink(target, path);
    }
    await assert.rejects(
      saveFilePlan(plan, async () => {}),
      (error: unknown) => {
        assert.deepEqual(details(error).input, { path, category: replacement === 'symlink' ? 'identity' : 'missing' });
        return true;
      },
    );
    assert.equal(await readFile(plan.edits[0].file.path, 'utf8'), plan.edits[0].file.text);
  });
}

test('a removed captured alias reports the requested path and original read failure', async (t) => {
  const root = await fixture(t);
  const plan = planChange(await loadSnapshot(root), {
    kind: 'preset',
    name: 'balanced',
    choice: { model: 'fixture/b' },
  });
  const path = join(root, 'alias.jsonc');
  await fs.promises.symlink(plan.snapshot.configFile.path, path);
  plan.reads = [{ ...plan.snapshot.configFile, path, canonicalPath: plan.snapshot.configFile.path, writable: false }];
  await rm(path);
  await assert.rejects(
    saveFilePlan(plan, async () => {}),
    (error: unknown) => {
      assert.deepEqual(details(error).input, { path, category: 'missing' });
      assert.ok(error instanceof Error && error.cause instanceof Error);
      assert.ok(error.cause.cause instanceof Error);
      assert.match(error.cause.cause.message, /ENOENT/);
      return true;
    },
  );
});
