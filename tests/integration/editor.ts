import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import type * as Storage from '../../src/config-composer/storage.ts';
import type * as Baseline from '../../src/config-composer/composition/runtime-baseline.ts';
import type { nativeHarness } from './harness.ts';

export async function installedEditor(host: Awaited<ReturnType<typeof nativeHarness>>) {
  const storage = (await import(
    pathToFileURL(join(host.installed.directory, 'dist/config-composer/storage.js')).href
  )) as typeof Storage;
  const { readRuntimeBaseline } = (await import(
    pathToFileURL(join(host.installed.directory, 'dist/config-composer/composition/runtime-baseline.js')).href
  )) as typeof Baseline;
  const runtime = async () => {
    const path = await host.api<{ directory: string; worktree: string }>('/path');
    const root = path.worktree !== '' && path.worktree !== '/' ? path.worktree : path.directory;
    const location = { root: resolve(root), directory: resolve(path.directory) };
    const baseline = readRuntimeBaseline(await host.api('/config'), location, host.configRoot);
    return { path, location, baseline };
  };
  const snapshot = async (reloading = false) => {
    if (host.pid === undefined) {
      return storage.loadSnapshot(host.configRoot, host.project);
    }
    const { path, location, baseline } = await runtime();
    return storage.loadSnapshot(
      host.configRoot,
      location.root,
      reloading ? { model: baseline.model, small_model: baseline.small_model } : baseline,
      path.directory,
      path.worktree,
    );
  };
  const reload = async (previous?: Storage.Snapshot) => {
    await host.prepareConfigurationDependencies();
    const saved = previous ?? (await snapshot(true));
    let token: string | undefined;
    await storage.reloadConfiguration(saved, async (plugins) => {
      token = (plugins[saved.pluginIndex] as [string, { reloadToken: string }])[1].reloadToken;
      await host.api('/global/config', { plugin: plugins }, 'PATCH');
    });
    assert.ok(token !== undefined);
    for (let attempt = 0; attempt < 200; attempt++) {
      const current = await host.api<{ plugin?: unknown[] }>('/config');
      if (JSON.stringify(current.plugin).includes(token)) {
        await host.api('/agent');
        return;
      }
      await setTimeout(50);
    }
    assert.fail('Reload token did not become visible in the native instance');
  };
  return { storage, snapshot, reload, runtime };
}
