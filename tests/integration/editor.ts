import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type * as Storage from '../../src/config-composer/storage.ts';
import type * as Baseline from '../../src/config-composer/composition/runtime-baseline.ts';
import type * as Apply from '../../src/config-composer/composition/apply.ts';
import type { nativeHarness } from './harness.ts';

export async function installedEditor(host: Awaited<ReturnType<typeof nativeHarness>>) {
  const storage = (await import(
    pathToFileURL(join(host.installed.directory, 'dist/config-composer/storage.js')).href
  )) as typeof Storage;
  const { readRuntimeBaseline, readRuntimeRevision } = (await import(
    pathToFileURL(join(host.installed.directory, 'dist/config-composer/composition/runtime-baseline.js')).href
  )) as typeof Baseline;
  const { applySavedComposition } = (await import(
    pathToFileURL(join(host.installed.directory, 'dist/config-composer/composition/apply.js')).href
  )) as typeof Apply;
  const runtime = async () => {
    const path = await host.api<{ directory: string; worktree: string }>('/path');
    const root = path.worktree !== '' && path.worktree !== '/' ? path.worktree : path.directory;
    const location = { root: resolve(root), directory: resolve(path.directory) };
    const config = await host.api('/config');
    const baseline = readRuntimeBaseline(config, location, host.configRoot);
    const applied = readRuntimeRevision(config, location, host.configRoot);
    return { path, location, baseline, applied };
  };
  const snapshot = async () => {
    if (host.pid === undefined) {
      return storage.loadSnapshot(host.configRoot, host.project);
    }
    const { path, location, baseline } = await runtime();
    return storage.loadSnapshot(host.configRoot, location.root, baseline, path.directory, path.worktree);
  };
  const reload = async (previous?: Storage.Snapshot) => {
    await host.prepareConfigurationDependencies();
    const saved = previous ?? (await snapshot());
    const { location } = await runtime();
    const applied = readRuntimeRevision(await host.api('/config'), location, host.configRoot);
    return applySavedComposition(saved, applied, {
      assertCurrent: () => assert.ok(host.pid !== undefined, 'the native host remains connected'),
      activity: () => host.api('/session/status'),
      dispose: async () => assert.equal(await host.api('/instance/dispose', {}), true),
      refresh: async () => {
        const config = await host.api('/config');
        await Promise.all([host.api('/config/providers'), host.api('/agent')]);
        return readRuntimeRevision(config, location, host.configRoot);
      },
    });
  };
  return { storage, snapshot, reload, runtime };
}
