import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type * as Storage from '../../src/config-composer/storage.ts';
import type * as Baseline from '../../src/config-composer/composition/runtime-baseline.ts';
import type * as Apply from '../../src/config-composer/composition/apply.ts';
import type { Selection } from '../../src/config-composer/composition/document-types.ts';
import type { nativeHarness } from './harness.ts';
export async function installedEditor(host: Awaited<ReturnType<typeof nativeHarness>>) {
  const storage = (await import(
    pathToFileURL(join(host.installed.directory, 'dist/config-composer/storage.js')).href
  )) as typeof Storage;
  const baseline = (await import(
    pathToFileURL(join(host.installed.directory, 'dist/config-composer/composition/runtime-baseline.js')).href
  )) as typeof Baseline;
  const apply = (await import(
    pathToFileURL(join(host.installed.directory, 'dist/config-composer/composition/apply.js')).href
  )) as typeof Apply;
  const connection = async (): Promise<Storage.EditorConnection> => {
    const path = await host.api<{ directory: string; worktree: string }>('/path');
    const location = {
      root: resolve(path.worktree !== '' && path.worktree !== '/' ? path.worktree : path.directory),
      directory: resolve(path.directory),
    };
    const pid = host.pid;
    return {
      location,
      assertCurrent: () => assert.equal(host.pid, pid, 'the native connection remains current'),
      config: () => host.api('/config'),
      proveFilesystem: async () => {
        const name = `composer-proof-${randomUUID()}`;
        const path = join(location.root, name);
        const content = randomUUID();
        try {
          await writeFile(path, content, { flag: 'wx' });
          const result = await host.api<{ content: string }>(`/file/content?path=${encodeURIComponent(name)}`);
          assert.equal(result.content, content);
        } finally {
          await unlink(path);
        }
      },
    };
  };
  const context = async () => storage.loadEditorContext(await connection());
  const runtime = async () => {
    const conn = await connection();
    return baseline.readRuntimeContext(await conn.config(), conn.location);
  };
  const reload = async (saved?: Storage.EditorContext, overrides: Partial<Apply.ApplyPort> = {}) => {
    const committed = saved ?? (await context());
    return apply.applySavedComposition(committed, committed.runtime, {
      assertCurrent: () => committed.connection.assertCurrent(),
      activity: () => host.api('/session/status'),
      dispose: async () => assert.equal(await host.api('/instance/dispose', {}), true),
      refresh: async () => {
        const config = await host.api('/config');
        await Promise.all([host.api('/config/providers'), host.api('/agent'), host.api('/command')]);
        return baseline.readRuntimeRevision(config, committed.connection.location);
      },
      ...overrides,
    });
  };
  const select = async (choice: Selection) => {
    const current = await context();
    const preview = await storage.previewSelection(current, choice);
    return storage.saveSelectionGuarded(current, preview);
  };
  return { storage, context, runtime, reload, select };
}
