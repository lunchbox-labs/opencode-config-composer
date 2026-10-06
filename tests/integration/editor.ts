import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import type * as Storage from '../../src/config-composer/storage.ts';
import type { nativeHarness } from './harness.ts';

export async function installedEditor(host: Awaited<ReturnType<typeof nativeHarness>>) {
  const storage = (await import(
    pathToFileURL(join(host.installed.directory, 'dist/config-composer/storage.js')).href
  )) as typeof Storage;
  const snapshot = () => storage.loadSnapshot(host.configRoot, host.project);
  const reload = async (previous?: Storage.Snapshot) => {
    const saved = previous ?? (await snapshot());
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
  return { storage, snapshot, reload };
}
