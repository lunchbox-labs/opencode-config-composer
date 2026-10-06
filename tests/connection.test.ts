import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, win32 } from 'node:path';
import { test } from 'node:test';
import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import { verifySharedFilesystem } from '../src/config-composer/connection.ts';

test('filesystem proofs are fresh, private, and removed after success or a replayed response', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'composer-connection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let previous = '';
  let replay = false;
  const paths: string[] = [];
  const api = {
    lifecycle: { signal: new AbortController().signal },
    client: {
      file: {
        read: async ({ path, directory }: { path: string; directory: string }) => {
          assert.equal(directory, root);
          assert.equal(isAbsolute(path), false);
          assert.equal(win32.isAbsolute(path), false);
          assert.match(path, /^\.config-composer-probe-[^/\\]+\/proof\.txt$/);
          path = join(directory, path);
          assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
          assert.equal((await stat(path)).mode & 0o777, 0o600);
          paths.push(path);
          const content = await readFile(path, 'utf8');
          assert.match(content, /^[a-f0-9]{64}$/);
          if (replay) {
            assert.notEqual(content, previous);
            return { data: { type: 'text', content: previous } };
          }
          previous = content;
          return { data: { type: 'text', content } };
        },
      },
    },
  } as unknown as TuiPluginApi;
  assert.equal(await verifySharedFilesystem(api, root, root), api.client);
  assert.deepEqual(await readdir(root), []);
  replay = true;
  await assert.rejects(verifySharedFilesystem(api, root, root), /shared filesystem/);
  assert.equal(new Set(paths).size, 2);
  assert.deepEqual(await readdir(root), []);
});

for (const change of ['client', 'abort'] as const) {
  test(`filesystem verification rejects a ${change} change while the response is pending`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'composer-connection-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const controller = new AbortController();
    const api = {
      lifecycle: { signal: controller.signal },
      client: {
        file: {
          read: async ({ path, directory }: { path: string; directory: string }) => {
            const content = await readFile(join(directory, path), 'utf8');
            if (change === 'client') {
              api.client = {} as TuiPluginApi['client'];
            } else {
              controller.abort();
            }
            return { data: { type: 'text', content } };
          },
        },
      },
    } as unknown as TuiPluginApi;
    await assert.rejects(verifySharedFilesystem(api, root, root), /connection changed/);
    assert.deepEqual(await readdir(root), []);
  });
}

test('filesystem proofs keep Windows server locations separate from portable relative paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'composer-windows-proof-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const serverRoot of ['C:\\Users\\fixture\\config\\opencode', '\\\\server\\share\\config']) {
    const api = {
      lifecycle: { signal: new AbortController().signal },
      client: {
        file: {
          read: async ({ directory, path }: { directory: string; path: string }) => {
            assert.equal(directory, serverRoot);
            assert.equal(win32.isAbsolute(path), false);
            assert.equal(path.includes('\\'), false);
            const resolved = win32.resolve(directory, path);
            assert.equal(win32.relative(directory, resolved).startsWith('..'), false);
            return { data: { type: 'text', content: await readFile(join(root, path), 'utf8') } };
          },
        },
      },
    } as unknown as TuiPluginApi;
    assert.equal(await verifySharedFilesystem(api, root, serverRoot), api.client);
    assert.deepEqual(await readdir(root), []);
  }
});
