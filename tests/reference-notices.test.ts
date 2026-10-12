import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import type { Config } from '@opencode-ai/plugin';
import { referenceNotices } from '../src/config-composer/tui/reference-diagnostics.ts';
import { publishRuntimeBaseline } from '../src/config-composer/composition/runtime-baseline.ts';
import { packageName } from '../src/config-composer/package-name.ts';

test('post-load notices resolve authoritative skills, show missing context, deduplicate reads, and clear after correction', async () => {
  const config: Config = { plugin: [packageName] };
  const diagnostics = [
    {
      kind: 'skills' as const,
      name: 'frontmatter-name',
      status: 'pending' as const,
      group: 'work',
      profile: 'coding',
      sourceId: '/source.jsonc',
      pointer: '/componentGroups/work/skills/0',
    },
  ];
  publishRuntimeBaseline(
    config,
    {},
    { root: '/project', directory: '/project' },
    {},
    {},
    { observedNativeFiles: 'a'.repeat(64), diagnostics },
  );
  const toasts: { message: string }[] = [];
  let found = false;
  const api = {
    state: { path: { worktree: '/project', directory: '/project' } },
    client: {
      config: { get: async () => ({ data: config }) },
      app: {
        skills: async () => ({
          data: found ? [{ name: 'frontmatter-name', location: '/different-directory/SKILL.md' }] : [],
        }),
      },
      command: { list: async () => ({ data: [] }) },
    },
    lifecycle: { signal: new AbortController().signal, onDispose: () => {} },
    ui: { toast: (notice: { message: string }) => toasts.push(notice) },
  } as unknown as TuiPluginApi;
  const notices = referenceNotices(api, '/config');
  await notices.refresh(true);
  assert.equal(notices.current().diagnostics[0].status, 'missing');
  assert.equal(notices.current().diagnostics[0].group, 'work');
  assert.match(toasts[0].message, /\/compose-configs\b/);
  await notices.refresh(false);
  await notices.refresh(true);
  assert.equal(toasts.length, 1);
  found = true;
  await notices.refresh(true);
  assert.deepEqual(notices.current().diagnostics, []);
  assert.equal(notices.current().unavailable, undefined);
  found = false;
  await notices.refresh(true);
  assert.equal(toasts.length, 2, 'a corrected issue can be reported if it returns');
});

test('unavailable and ambiguous inventories stay pending; late results cannot cross workspace or disposal boundaries', async () => {
  const config: Config = { plugin: [packageName] };
  publishRuntimeBaseline(
    config,
    {},
    { root: '/project', directory: '/project' },
    {},
    {},
    {
      observedNativeFiles: 'a'.repeat(64),
      diagnostics: [{ kind: 'skills', name: 'skill', status: 'pending' }],
    },
  );
  const gate = Promise.withResolvers<undefined>();
  const started = Promise.withResolvers<undefined>();
  const controller = new AbortController();
  let delayed = false;
  let reads = 0;
  let notices = 0;
  const api = {
    state: { path: { directory: '/project', worktree: '/project' } },
    client: {
      config: {
        get: async () => {
          reads++;
          if (delayed) {
            started.resolve(undefined);
            await gate.promise;
          }
          return { data: config };
        },
      },
      command: { list: async () => ({ error: 'unavailable' }) },
      app: { skills: async () => ({ data: [{ name: 'skill' }, { name: 'skill' }] }) },
    },
    lifecycle: { signal: controller.signal },
    ui: { toast: () => notices++ },
  } as unknown as TuiPluginApi;
  const warnings = referenceNotices(api, '/config');
  await warnings.refresh(true);
  assert.equal(warnings.current().diagnostics[0].status, 'pending');
  assert.equal(notices, 1);
  delayed = true;
  const pending = warnings.refresh(true);
  await started.promise;
  api.state.path.directory = '/another';
  gate.resolve(undefined);
  await pending;
  assert.equal(notices, 1);
  assert.equal(warnings.current().diagnostics[0].status, 'pending');
  controller.abort();
  await warnings.refresh(true);
  assert.equal(notices, 1);
  assert.ok(reads > 1);
});

test('a reload during inventory discovery cannot settle names against the previous runtime', async () => {
  const config: Config = { plugin: [packageName] };
  const publish = () =>
    publishRuntimeBaseline(
      config,
      {},
      { root: '/project', directory: '/project' },
      {},
      {},
      {
        observedNativeFiles: 'a'.repeat(64),
        diagnostics: [{ kind: 'skills', name: 'old', status: 'pending' }],
      },
    );
  publish();
  const api = {
    state: { path: { directory: '/project', worktree: '/project' } },
    client: {
      config: { get: async () => ({ data: config }) },
      command: { list: async () => ({ data: [] }) },
      app: {
        skills: async () => {
          publish();
          return { data: [] };
        },
      },
    },
    lifecycle: { signal: new AbortController().signal },
    ui: { toast: () => {} },
  } as unknown as TuiPluginApi;
  const warnings = referenceNotices(api, '/config');
  await warnings.refresh();
  assert.deepEqual(warnings.current().diagnostics, []);
  assert.match(warnings.current().unavailable!, /instance changed/);
});
