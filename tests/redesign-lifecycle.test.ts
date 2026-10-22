import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import descriptor from '../src/config-composer/server.ts';
import { packageName } from '../src/config-composer/package-name.ts';
import {
  loadConfigurationContext,
  metadataChanged,
  previewSelection,
  saveSelectionGuarded,
} from '../src/config-composer/storage.ts';
import { readRuntimeContext } from '../src/config-composer/composition/runtime-baseline.ts';
import { applySavedComposition } from '../src/config-composer/composition/apply.ts';
import { readSelection, saveSelection } from '../src/config-composer/composition/selection-state.ts';
import { observeNative } from '../src/config-composer/composition/revision.ts';
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
    const context = await loadConfigurationContext(f.connection);
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
  const context = await loadConfigurationContext(f.connection);
  const nested = f.config.agent.worker;
  await saveSelectionGuarded(context, await previewSelection(context, null));
  f.config = { ...f.base(), agent: { worker: nested } };
  await f.hook(f.config);
  assert.equal(f.config.agent.worker.model, 'p/native');
  assert.equal((f.config.agent.worker as Record<string, unknown>).variant, undefined);
});
test('native enumeration order permits guarded recomposition without changing source or permission precedence', async (t) => {
  const f = await fixture(t);
  const projectAgent = join(f.root, '.opencode/agents/worker.md');
  const customAgent = join(f.root, 'agents/worker.md');
  await mkdir(join(f.root, '.opencode/agents'), { recursive: true });
  await mkdir(join(f.root, 'agents'));
  await writeFile(projectAgent, '---\nmodel: p/project\n---\nproject body');
  await writeFile(
    customAgent,
    '---\nmodel: p/pinned\npermission:\n  edit:\n    "*.md": deny\n    "*": allow\n  read: ask\n---\ncustom body',
  );
  await writeFile(join(f.root, '.opencode/agents/helper.md'), '---\n---\nhelper body');
  const original = fs.promises.readdir;
  let reverse = false;
  const mock = t.mock.method(fs.promises, 'readdir', async (...args: Parameters<typeof fs.promises.readdir>) => {
    const entries = await original(...args);
    return reverse ? entries.reverse() : entries;
  });
  syncBuiltinESMExports();
  t.after(() => {
    mock.mock.restore();
    syncBuiltinESMExports();
  });
  f.config = f.base();
  Object.assign(f.config.agent, { helper: { prompt: 'helper body' } });
  await f.hook(f.config);
  const before = readRuntimeContext(f.config, f.connection.location);
  reverse = true;
  const observed = await observeNative(before.observation.context);
  assert.deepEqual(Object.keys(observed.authority), Object.keys(before.observation.authority).reverse());
  assert.deepEqual(observed.authority, before.observation.authority);
  assert.equal(observed.metadata, before.observation.metadata);
  assert.deepEqual(
    observed.authority.worker.sources.map((source) => source.path),
    [projectAgent, customAgent],
  );
  for (const choice of ['b', null, 'a'] as const) {
    const context = await loadConfigurationContext(f.connection);
    const committed = await saveSelectionGuarded(context, await previewSelection(context, choice));
    await applySavedComposition(committed, committed.runtime, {
      assertCurrent: f.connection.assertCurrent,
      activity: () => Promise.resolve({}),
      dispose: () => Promise.resolve(),
      refresh: async () => {
        await f.hook(f.config);
        return readRuntimeContext(f.config, f.connection.location);
      },
    });
    assert.equal(f.config.agent.worker.model, 'p/pinned');
    const permission = (f.config.agent.worker as Record<string, unknown>).permission as Record<string, unknown>;
    assert.deepEqual(Object.keys(permission), ['edit', 'read']);
    assert.deepEqual(Object.keys(permission.edit as object), ['*.md', '*']);
    assert.deepEqual(permission, { edit: { '*.md': 'deny', '*': 'allow' }, read: 'ask' });
    reverse = !reverse;
  }
});
test('deleted saved profile publishes recoverable failure without successful revision or partial mutation', async (t) => {
  const f = await fixture(t);
  const context = await loadConfigurationContext(f.connection);
  await saveSelectionGuarded(context, await previewSelection(context, 'b'));
  await writeFile(f.source, JSON.stringify({ ...f.document, profiles: { a: f.document.profiles.a } }));
  f.config = f.base();
  await assert.rejects(f.hook(f.config), /Saved profile b/);
  const runtime = readRuntimeContext(f.config, f.connection.location);
  assert.equal(runtime.status, 'error');
  assert.equal(runtime.revision, undefined);
  assert.match(runtime.diagnostic!, /Composer not applied/);
  assert.equal(f.config.agent.worker.model, 'p/native');
  const recovery = await loadConfigurationContext(f.connection);
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
    const context = await loadConfigurationContext(f.connection);
    await assert.rejects(
      previewSelection(context, 'b', async () => {
        if (mutation === 'source') {
          await writeFile(f.source, JSON.stringify(f.document) + '\n');
        }
        if (mutation === 'state') {
          const other = await loadConfigurationContext(f.connection);
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
  const context = await loadConfigurationContext(f.connection);
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
  assert.equal((await loadConfigurationContext(f.connection)).selection.choice, 'b');
});
test('metadata body-only changes and link retargets are guarded', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'agents'));
  const path = join(f.root, 'agents/worker.md');
  await writeFile(path, '---\n---\none');
  f.config = f.base();
  await f.hook(f.config);
  const context = await loadConfigurationContext(f.connection);
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
  const context = await loadConfigurationContext(f.connection);
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
  await assert.rejects(loadConfigurationContext(f.connection), /Exact native authority/);
});

test('runtime replacement during idle check rejects before disposal and preview tampering rejects before save', async (t) => {
  const f = await fixture(t);
  const context = await loadConfigurationContext(f.connection);
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

for (const boundary of ['save', 'dispose'] as const) {
  for (const mutation of ['source', 'metadata', 'json'] as const) {
    test(`${boundary} rejects ${mutation} changes during the final runtime-config await`, async (t) => {
      const f = await fixture(t);
      const context = await loadConfigurationContext(f.connection);
      const preview = await previewSelection(context, 'a');
      const committed = boundary === 'dispose' ? await saveSelectionGuarded(context, preview) : undefined;
      let calls = 0;
      f.connection.config = async () => {
        if (++calls === 2) {
          if (mutation === 'source') {
            await writeFile(f.source, JSON.stringify({ profiles: { b: f.document.profiles.b } }));
          } else if (mutation === 'metadata') {
            await mkdir(join(f.root, 'agents'));
            await writeFile(join(f.root, 'agents/worker.md'), '---\n---\nnew native body');
          } else {
            await writeFile(join(f.root, 'opencode.json'), '{}');
          }
        }
        return f.config;
      };
      const diagnostic =
        mutation === 'source'
          ? /Composition source changed/
          : mutation === 'metadata'
            ? /Native agent metadata changed/
            : /Native JSON configuration changed/;
      if (committed === undefined) {
        await assert.rejects(saveSelectionGuarded(context, preview), diagnostic);
        await assert.rejects(readFile(context.selection.path), /ENOENT/);
      } else {
        let disposed = false;
        await assert.rejects(
          applySavedComposition(committed, committed.runtime, {
            assertCurrent: () => {},
            activity: () => Promise.resolve({}),
            dispose: () => {
              disposed = true;
              return Promise.resolve();
            },
            refresh: () => Promise.reject(new Error('unreachable refresh after stale inputs')),
          }),
          diagnostic,
        );
        assert.equal(disposed, false);
        assert.equal(await readFile(committed.selection.path, 'utf8'), committed.selection.text);
      }
      assert.equal(calls, 2, 'the mutation was injected in the last runtime verification');
    });
  }
}

test("committed reload never adopts another normal writer's selection", async (t) => {
  const f = await fixture(t);
  const context = await loadConfigurationContext(f.connection);
  const preview = await previewSelection(context, 'a');
  let calls = 0;
  let otherSaved = false;
  f.connection.config = async () => {
    if (++calls === 3) {
      const other = await readSelection(context.runtime.selectionEnvironment, {
        root: f.root,
        baseFile: f.source,
      });
      await saveSelection(other, 'b', () => Promise.resolve());
      otherSaved = true;
    }
    return f.config;
  };
  await assert.rejects(saveSelectionGuarded(context, preview), /Selection saved and pending.*changed/);
  assert.equal(otherSaved, true, 'the second writer used the ordinary locked state API');
  const current = await readSelection(context.runtime.selectionEnvironment, { root: f.root, baseFile: f.source });
  assert.equal(current.choice, 'b');
  assert.equal(current.revision, 2);
  assert.equal(f.config.agent.worker.model, 'p/a', 'the other selection was never applied by this editor');
});

test('committed reload preserves the reviewed source instead of adopting a changed definition', async (t) => {
  const f = await fixture(t);
  const context = await loadConfigurationContext(f.connection);
  const preview = await previewSelection(context, 'a');
  let calls = 0;
  f.connection.config = async () => {
    if (++calls === 3) {
      await writeFile(f.source, JSON.stringify({ profiles: { a: { agent: { worker: { model: 'p/unreviewed' } } } } }));
    }
    return f.config;
  };
  await assert.rejects(saveSelectionGuarded(context, preview), /Selection saved and pending.*changed/);
  const current = await readSelection(context.runtime.selectionEnvironment, { root: f.root, baseFile: f.source });
  assert.equal(current.choice, 'a');
  assert.equal(current.revision, 1);
  assert.equal(f.config.agent.worker.model, 'p/a');
});

test('external native edits reload from a fresh baseline without writing their bytes', async (t) => {
  const f = await fixture(t);
  const { reloadSavedConfiguration } = await import('../src/config-composer/composition/apply.ts');
  await writeFile(join(f.root, 'opencode.json'), '{"small_model":"p/new"}');
  const context = await loadConfigurationContext(f.connection);
  const previous = context.runtime.id;
  const revision = await reloadSavedConfiguration(context, {
    assertCurrent: f.connection.assertCurrent,
    activity: async () => ({}),
    dispose: async () => {},
    refresh: async () => {
      f.config = Object.assign(f.base(), { small_model: 'p/new' });
      await f.hook(f.config);
      return readRuntimeContext(f.config, f.connection.location);
    },
  });
  assert.notEqual(readRuntimeContext(f.config, f.connection.location).id, previous);
  assert.deepEqual(revision, readRuntimeContext(f.config, f.connection.location).revision);
  assert.equal(await readFile(join(f.root, 'opencode.json'), 'utf8'), '{"small_model":"p/new"}');
});
test('global JSON change refuses reload with zero disposal even after another native rebootstrap', async (t) => {
  const f = await fixture(t);
  const { reloadSavedConfiguration } = await import('../src/config-composer/composition/apply.ts');
  await mkdir(join(f.root, 'opencode'), { recursive: true });
  await writeFile(join(f.root, 'opencode/opencode.json'), '{}');
  await f.hook(f.config);
  const context = await loadConfigurationContext(f.connection);
  let disposed = 0;
  await assert.rejects(
    reloadSavedConfiguration(context, {
      assertCurrent: f.connection.assertCurrent,
      activity: async () => ({}),
      dispose: async () => {
        disposed++;
      },
      refresh: async () => context.runtime,
    }),
    /Restart the OpenCode server/,
  );
  assert.equal(disposed, 0);
});
for (const mutation of ['source', 'state', 'native', 'connection', 'busy'] as const) {
  test(`reload rejects ${mutation} during activity await before disposal`, async (t) => {
    const f = await fixture(t);
    const { reloadSavedConfiguration } = await import('../src/config-composer/composition/apply.ts');
    const context = await loadConfigurationContext(f.connection);
    let disposed = 0;
    await assert.rejects(
      reloadSavedConfiguration(context, {
        assertCurrent: f.connection.assertCurrent,
        activity: async (): Promise<Record<string, { type: string }>> => {
          if (mutation === 'source') {
            await writeFile(f.source, '{}');
          }
          if (mutation === 'state') {
            await saveSelection(context.selection, null, async () => {});
          }
          if (mutation === 'native') {
            await writeFile(join(f.root, 'opencode.json'), '{}');
          }
          if (mutation === 'connection') {
            f.disconnect();
          }
          return mutation === 'busy' ? { active: { type: 'busy' } } : {};
        },
        dispose: async () => {
          disposed++;
        },
        refresh: async () => context.runtime,
      }),
      /changed|connection|still running|selection edit/i,
    );
    assert.equal(disposed, 0);
  });
}
test('profile apply also refuses a cached-global mismatch after rebootstrap', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'opencode/opencode.json'), '{}');
  await f.hook(f.config);
  const context = await loadConfigurationContext(f.connection);
  await assert.rejects(previewSelection(context, 'b'), /Restart the OpenCode server/);
});
for (const mutation of ['source', 'state', 'native', 'connection'] as const) {
  test(`reload refuses ${mutation} changes after new registration`, async (t) => {
    const f = await fixture(t);
    const { reloadSavedConfiguration } = await import('../src/config-composer/composition/apply.ts');
    const context = await loadConfigurationContext(f.connection);
    await assert.rejects(
      reloadSavedConfiguration(context, {
        assertCurrent: f.connection.assertCurrent,
        activity: async () => ({}),
        dispose: async () => {},
        refresh: async () => {
          await f.hook(f.config);
          const marker = readRuntimeContext(f.config, f.connection.location);
          if (mutation === 'source') {
            await writeFile(f.source, '{}');
          }
          if (mutation === 'state') {
            await writeFile(context.selection.path, '{}');
          }
          if (mutation === 'native') {
            await writeFile(join(f.root, 'opencode.json'), '{}');
          }
          if (mutation === 'connection') {
            f.disconnect();
          }
          return marker;
        },
      }),
      /changed|connection|selection/i,
    );
  });
}
test('reload waits through old and missing markers but propagates actual host errors', async (t) => {
  const f = await fixture(t);
  const { reloadSavedConfiguration } = await import('../src/config-composer/composition/apply.ts');
  const { SettingsError } = await import('../src/config-composer/settings.ts');
  const context = await loadConfigurationContext(f.connection);
  let calls = 0;
  const port = {
    assertCurrent: f.connection.assertCurrent,
    activity: async () => ({}),
    dispose: async () => {},
    refresh: async () => {
      if (++calls === 1) {
        return context.runtime;
      }
      if (calls === 2) {
        throw new SettingsError('No runtime marker. Exact native authority is unavailable.');
      }
      await f.hook(f.config);
      return readRuntimeContext(f.config, f.connection.location);
    },
  };
  await reloadSavedConfiguration(context, port);
  assert.equal(calls, 3);
  const next = await loadConfigurationContext(f.connection);
  await assert.rejects(
    reloadSavedConfiguration(next, {
      ...port,
      refresh: async () => {
        throw new Error('actual host read error');
      },
    }),
    /actual host read error/,
  );
});
test('saved selection apply waits for bootstrap instead of rejecting an old registration', async (t) => {
  const f = await fixture(t);
  const context = await loadConfigurationContext(f.connection);
  const saved = await saveSelectionGuarded(context, await previewSelection(context, 'b'));
  let samples = 0;
  await applySavedComposition(saved, context.runtime, {
    assertCurrent: f.connection.assertCurrent,
    activity: async () => ({}),
    dispose: async () => {},
    refresh: async () => {
      if (++samples === 1) {
        return context.runtime;
      }
      await f.hook(f.config);
      return readRuntimeContext(f.config, f.connection.location);
    },
  });
  assert.equal(samples, 2);
});
test('native host normalization after reload remains unconfirmed and preserves changed bytes', async (t) => {
  const f = await fixture(t);
  const { reloadSavedConfiguration } = await import('../src/config-composer/composition/apply.ts');
  const path = join(f.root, 'opencode.json');
  await writeFile(path, '{}');
  const context = await loadConfigurationContext(f.connection);
  const normalized = '{"$schema":"https://opencode.ai/config.json"}';
  await assert.rejects(
    reloadSavedConfiguration(context, {
      assertCurrent: f.connection.assertCurrent,
      activity: async () => ({}),
      dispose: async () => {},
      refresh: async () => {
        await writeFile(path, normalized);
        await f.hook(f.config);
        return readRuntimeContext(f.config, f.connection.location);
      },
    }),
    /Native inputs changed during reload/,
  );
  assert.equal(await readFile(path, 'utf8'), normalized);
});
test('global cache change during idle check remains restart-required with zero disposal', async (t) => {
  const f = await fixture(t);
  const { reloadSavedConfiguration } = await import('../src/config-composer/composition/apply.ts');
  const { RestartRequiredError } = await import('../src/config-composer/settings.ts');
  const context = await loadConfigurationContext(f.connection);
  let disposed = 0;
  await assert.rejects(
    reloadSavedConfiguration(context, {
      assertCurrent: f.connection.assertCurrent,
      activity: async () => {
        await writeFile(join(f.root, 'opencode/opencode.json'), '{}');
        return {};
      },
      dispose: async () => {
        disposed++;
      },
      refresh: async () => context.runtime,
    }),
    (error: unknown) =>
      typeof RestartRequiredError === 'function' &&
      error instanceof RestartRequiredError &&
      error.message.includes('Restart the OpenCode server'),
  );
  assert.equal(disposed, 0);
});
