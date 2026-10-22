import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import descriptor from '../src/config-composer/server.ts';
import { packageName } from '../src/config-composer/package-name.ts';
import {
  loadEditorContext,
  metadataChanged,
  previewSelection,
  saveSelectionGuarded,
} from '../src/config-composer/storage.ts';
import { readRuntimeContext } from '../src/config-composer/composition/runtime-baseline.ts';
import { applySavedComposition } from '../src/config-composer/composition/apply.ts';
import { readSelection } from '../src/config-composer/composition/selection-state.ts';
import type { PluginInput } from '@opencode-ai/plugin';
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'composer-redesign-'));
  const source = join(root, 'config-composer.jsonc');
  const keys = ['OPENCODE_CONFIG_DIR', 'OPENCODE_TEST_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME'];
  const before = keys.map((key) => process.env[key]);
  keys.forEach((key) => (process.env[key] = root));
  t.after(async () => {
    keys.forEach((key, index) => {
      if (before[index] === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = before[index];
      }
    });
    await rm(root, { recursive: true, force: true });
  });
  const document = {
    groups: [{ name: 'workers', members: { agent: ['worker'] }, agent: { temperature: 0.1 } }],
    defaultProfile: 'a',
    profiles: {
      a: {
        agent: { worker: { model: 'p/a', variant: 'high', options: { a: false } } },
        command: { run: { subtask: false } },
      },
      b: { agent: { worker: { model: 'p/b' } } },
    },
  };
  await writeFile(source, JSON.stringify(document));
  const hook = (await descriptor.server({ directory: root, worktree: root } as PluginInput)).config!;
  const base = () => ({
    plugin: [packageName],
    agent: { worker: { model: 'p/native', prompt: 'OPAQUE' } },
    command: { run: { template: 'OPAQUE', subtask: true } },
  });
  let config = base();
  await hook(config);
  let current = true;
  const connection = {
    location: { root, directory: root },
    assertCurrent: () => {
      assert.equal(current, true, 'wrong connection');
    },
    config: () => Promise.resolve(config),
    proveFilesystem: () => Promise.resolve(),
  };
  return {
    root,
    source,
    document,
    hook,
    base,
    connection,
    get config() {
      return config;
    },
    set config(value) {
      config = value;
    },
    disconnect: () => {
      current = false;
    },
  };
}
test('default selection without a state file publishes JSON-safe success and error attestations', async (t) => {
  const f = await fixture(t);
  const success = readRuntimeContext(f.config, f.connection.location);
  assert.deepEqual(JSON.parse(JSON.stringify(success)), success);
  assert.equal(success.selection?.choice, undefined);
  assert.equal(success.selection?.identity, undefined);
  await writeFile(f.source, '{"invalid":true}');
  await assert.rejects(f.hook(f.config), /Unknown key/);
  const failure = readRuntimeContext(f.config, f.connection.location);
  assert.deepEqual(JSON.parse(JSON.stringify(failure)), failure);
  assert.equal(failure.status, 'error');
});
test('selection A B A none default restores native fields for fresh and reused objects', async (t) => {
  const f = await fixture(t);
  for (const choice of ['b', 'a', null, undefined] as const) {
    const context = await loadEditorContext(f.connection);
    const committed = await saveSelectionGuarded(context, await previewSelection(context, choice));
    assert.equal(committed.selection.revision, context.selection.revision + 1);
    assert.notEqual(committed.selection.text, context.selection.text);
    const before = committed.runtime.id;
    await applySavedComposition(committed, committed.runtime, {
      assertCurrent: f.connection.assertCurrent,
      activity: () => Promise.resolve({}),
      dispose: () => Promise.resolve(),
      refresh: async () => {
        await f.hook(f.config);
        return readRuntimeContext(f.config, f.connection.location);
      },
    });
    assert.notEqual(readRuntimeContext(f.config, f.connection.location).id, before);
    assert.equal(f.config.agent.worker.model, choice === 'b' ? 'p/b' : choice === null ? 'p/native' : 'p/a');
    assert.equal(
      (f.config.agent.worker as Record<string, unknown>).variant,
      choice === null || choice === 'b' ? undefined : 'high',
    );
    assert.equal(f.config.command.run.subtask, choice === null || choice === 'b');
  }
  const context = await loadEditorContext(f.connection);
  const nested = f.config.agent.worker;
  await saveSelectionGuarded(context, await previewSelection(context, null));
  f.config = { ...f.base(), agent: { worker: nested } };
  await f.hook(f.config);
  assert.equal(f.config.agent.worker.model, 'p/native');
  assert.equal((f.config.agent.worker as Record<string, unknown>).variant, undefined);
});
test('deleted saved profile publishes recoverable failure without successful revision or partial mutation', async (t) => {
  const f = await fixture(t);
  const context = await loadEditorContext(f.connection);
  await saveSelectionGuarded(context, await previewSelection(context, 'b'));
  await writeFile(f.source, JSON.stringify({ ...f.document, profiles: { a: f.document.profiles.a } }));
  f.config = f.base();
  await assert.rejects(f.hook(f.config), /Saved profile b/);
  const runtime = readRuntimeContext(f.config, f.connection.location);
  assert.equal(runtime.status, 'error');
  assert.equal(runtime.revision, undefined);
  assert.match(runtime.diagnostic!, /Composer not applied/);
  assert.equal(f.config.agent.worker.model, 'p/native');
  const recovery = await loadEditorContext(f.connection);
  assert.equal(recovery.selection.choice, 'b');
  const committed = await saveSelectionGuarded(recovery, await previewSelection(recovery, null));
  await applySavedComposition(committed, recovery.runtime, {
    assertCurrent: () => {},
    activity: () => Promise.resolve({}),
    dispose: () => Promise.resolve(),
    refresh: async () => {
      f.config = f.base();
      await f.hook(f.config);
      return readRuntimeContext(f.config, f.connection.location);
    },
  });
  assert.equal(readRuntimeContext(f.config, f.connection.location).status, 'applied');
});
test('every composition failure replaces old marker and does not claim native fallback', async (t) => {
  const f = await fixture(t);
  await writeFile(f.source, '{"invalid":true}');
  await assert.rejects(f.hook(f.config), /Unknown key/);
  const marker = readRuntimeContext(f.config, f.connection.location);
  assert.equal(marker.status, 'error');
  assert.equal(marker.revision, undefined);
  assert.equal(f.config.agent.worker.model, 'p/a');
  assert.doesNotMatch(marker.diagnostic!, /fallback/);
});
for (const mutation of ['source', 'state', 'metadata', 'json', 'connection'] as const) {
  test(`review guards reject ${mutation} changes across catalog await before writes`, async (t) => {
    const f = await fixture(t);
    const context = await loadEditorContext(f.connection);
    await assert.rejects(
      previewSelection(context, 'b', async () => {
        if (mutation === 'source') {
          await writeFile(f.source, JSON.stringify(f.document) + '\n');
        }
        if (mutation === 'state') {
          const other = await loadEditorContext(f.connection);
          await saveSelectionGuarded(other, await previewSelection(other, null));
        }
        if (mutation === 'metadata') {
          await mkdir(join(f.root, 'agents'));
          await writeFile(join(f.root, 'agents/new.md'), '---\n---\nopaque');
        }
        if (mutation === 'json') {
          await writeFile(join(f.root, 'opencode.json'), '{}');
        }
        if (mutation === 'connection') {
          f.disconnect();
        }
        return [{ id: 'p/b', name: 'B', provider: 'p', variants: {} }];
      }),
      mutation === 'metadata' ? new RegExp(metadataChanged.replaceAll('.', '\\.')) : /changed|connection/i,
    );
    if (mutation !== 'state') {
      await assert.rejects(readFile(context.selection.path), /ENOENT/);
    }
  });
}
test('busy never disposes; idle-time metadata changes never dispose; refresh failure retains committed state', async (t) => {
  const f = await fixture(t);
  const context = await loadEditorContext(f.connection);
  const committed = await saveSelectionGuarded(context, await previewSelection(context, 'b'));
  let disposed = 0;
  const port = {
    assertCurrent: () => {},
    activity: () => Promise.resolve({ one: { type: 'busy' } }),
    dispose: () => {
      disposed++;
      return Promise.resolve();
    },
    refresh: () => Promise.reject(new Error('refresh failed')),
  };
  await assert.rejects(applySavedComposition(committed, context.runtime, port), /still running/);
  assert.equal(disposed, 0);
  await assert.rejects(
    applySavedComposition(committed, context.runtime, {
      ...port,
      activity: async () => {
        await mkdir(join(f.root, 'agents'));
        await writeFile(join(f.root, 'agents/worker.md'), '---\n---\nchanged body');
        return {};
      },
    }),
    /Native agent metadata changed/,
  );
  assert.equal(disposed, 0);
  await rm(join(f.root, 'agents'), { recursive: true });
  await assert.rejects(
    applySavedComposition(committed, context.runtime, { ...port, activity: () => Promise.resolve({}) }),
    /refresh failed/,
  );
  assert.equal(disposed, 1);
  assert.equal((await loadEditorContext(f.connection)).selection.choice, 'b');
});
test('metadata body-only changes and link retargets are guarded', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'agents'));
  const path = join(f.root, 'agents/worker.md');
  await writeFile(path, '---\n---\none');
  f.config = f.base();
  await f.hook(f.config);
  const context = await loadEditorContext(f.connection);
  await writeFile(path, '---\n---\ntwo');
  await assert.rejects(previewSelection(context, null), /Native agent metadata changed/);
  await writeFile(path, '---\n---\none');
  const external = join(f.root, 'worker.md');
  await writeFile(external, '---\n---\none');
  await unlink(path);
  await symlink(external, path);
  await assert.rejects(previewSelection(context, null), /Native agent metadata changed/);
});
test('fresh namespace separates canonical sources and worktrees and ignores old selection', async (t) => {
  const f = await fixture(t);
  const context = await loadEditorContext(f.connection);
  await saveSelectionGuarded(context, await previewSelection(context, null));
  const env = context.runtime.selectionEnvironment;
  const same = await readSelection(env, { root: f.root, baseFile: f.source });
  assert.equal(same.choice, null);
  const other = await readSelection(env, { root: join(f.root, 'other'), baseFile: f.source });
  assert.equal(other.choice, undefined);
  const source = await readSelection(env, { root: f.root, baseFile: join(f.root, 'other.jsonc') });
  assert.equal(source.choice, undefined);
  assert.match(same.path, /v2/);
});
test('invalid native authority fails closed with attested error and no managed mutation', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'agents'));
  await writeFile(join(f.root, 'agents/worker.md'), '---\nmode: wrong\n---\nopaque');
  f.config = f.base();
  await assert.rejects(f.hook(f.config), /invalid native mode/);
  assert.equal(f.config.agent.worker.model, 'p/native');
  await assert.rejects(loadEditorContext(f.connection), /Exact native authority/);
});

test('runtime replacement during idle check rejects before disposal and preview tampering rejects before save', async (t) => {
  const f = await fixture(t);
  const context = await loadEditorContext(f.connection);
  const preview = await previewSelection(context, 'b');
  preview.candidate.agent.worker.model = 'p/tampered';
  await assert.rejects(saveSelectionGuarded(context, preview), /Preview does not match/);
  await assert.rejects(readFile(context.selection.path), /ENOENT/);
  const committed = await saveSelectionGuarded(context, await previewSelection(context, 'b'));
  let disposed = false;
  await assert.rejects(
    applySavedComposition(committed, context.runtime, {
      assertCurrent: () => {},
      activity: async () => {
        await f.hook(f.config);
        return {};
      },
      dispose: () => {
        disposed = true;
        return Promise.resolve();
      },
      refresh: () => Promise.resolve(committed.runtime),
    }),
    /running instance changed/,
  );
  assert.equal(disposed, false);
});
