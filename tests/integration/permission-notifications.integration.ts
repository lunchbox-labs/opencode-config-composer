import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CompositionDocument } from '../../src/config-composer/composition/types.ts';
import { compositionFixture } from './composition-fixture.ts';
import { nativeNotifications } from './notifications.ts';
import { unsupportedRules } from './permission-fixture.ts';

test(
  'installed warning delivery deduplicates same-instance replay and session messages, then announces changed scope and recovery',
  { timeout: 180_000 },
  async (t) => {
    const f = await compositionFixture(t, 'permission-notification-lifecycle');
    const document = (group: string, broken = true): CompositionDocument => ({
      componentGroups: {
        [group]: {
          agents: ['worker'],
          configuration: {
            permissions: broken ? unsupportedRules : [{ tool: 'skill', pattern: 'included-skill', action: 'deny' }],
          },
        },
      },
      profiles: { work: { layers: [{ componentGroup: group }] } },
      activeProfiles: ['work'],
    });
    await f.write(f.paths.shared, document('broken'));
    const wrapper = join(f.host.configRoot, 'notification-replay.mjs');
    // Public reload creates new plugin instances. This native fixture controls only
    // same-instance replay sequencing; every config/chat hook and notification client
    // remains the installed implementation. Public reload/decisions are covered separately.
    await writeFile(
      wrapper,
      `
import composer from ${JSON.stringify(pathToFileURL(join(f.host.installed.directory, 'dist/server.js')).href)};
import { writeFile } from 'node:fs/promises';
export default { id: 'permission-notification-replay', server: async (input) => {
  const hooks = await composer.server(input);
  let current;
  return { ...hooks,
    config: async (config) => { current = config; await hooks.config(config); },
    'chat.message': async (input, output) => {
      const text = output.parts.filter((part) => part.type === 'text').map((part) => part.text).join(' ');
      if (text === 'CHANGE_WARNING') await writeFile(${JSON.stringify(f.paths.shared)}, ${JSON.stringify(JSON.stringify(document('changed')))});
      if (text === 'REPAIR_WARNING') await writeFile(${JSON.stringify(f.paths.shared)}, ${JSON.stringify(JSON.stringify(document('changed', false)))});
      if (['REPLAY_UNCHANGED', 'CHANGE_WARNING', 'REPAIR_WARNING'].includes(text)) await hooks.config(current);
      await hooks['chat.message'](input, output);
    }
  };
} };
`,
    );
    const nativePath = join(f.host.configRoot, 'opencode.jsonc');
    const native = JSON.parse(await readFile(nativePath, 'utf8')) as {
      plugin: string[];
      agent: Record<string, unknown>;
    };
    native.plugin = [pathToFileURL(wrapper).href];
    native.agent.clean = { mode: 'primary', prompt: 'Independent native agent' };
    await writeFile(nativePath, JSON.stringify(native));
    await f.host.start();
    const events = await nativeNotifications(f.host, 'warning-lifecycle-notifications');
    await f.host.api('/agent');
    await events.wait((toast) => toast.message.startsWith('Agent worker:'));
    await events.flush();
    assert.equal(events.toasts.length, 1, 'one warning per unsupported scope on initial configuration');
    assert.match(f.host.stderr, /Agent worker:.*Fallback may be more permissive/);
    const sessionA = await f.host.api<{ id: string }>('/session', { title: 'Warning lifecycle A' });
    const sessionB = await f.host.api<{ id: string }>('/session', { title: 'Warning lifecycle B' });
    const send = async (session: string, text = 'Reply with verified.', agent = 'worker') => {
      const before = f.host.requests.length;
      const result = await f.host.api<{ info: { error?: unknown }; parts: { text?: string }[] }>(
        `/session/${session}/message`,
        { agent, parts: [{ type: 'text', text }] },
      );
      assert.equal(result.info.error, undefined);
      assert.ok(result.parts.some((part) => part.text === 'verified'));
      assert.equal(f.host.requests.length, before + 1, 'warning paths continue actual native model dispatch');
      await events.flush();
    };
    await send(sessionA.id);
    assert.equal(events.toasts.length, 2, 'a session receives the relevant current warning');
    await send(sessionA.id);
    assert.equal(events.toasts.length, 2, 'repeated messages in the same warning state are deduplicated');
    await send(sessionB.id);
    assert.equal(events.toasts.length, 3, 'a different session receives its own replay');
    await send(sessionA.id, 'Reply with verified.', 'clean');
    assert.equal(events.toasts.length, 4);
    assert.match(events.toasts.at(-1)!.message, /resolved for this session/);
    assert.equal(events.toasts.at(-1)!.variant, 'info');
    await send(sessionA.id);
    assert.equal(events.toasts.length, 5, 'switching back to the affected agent replays the warning');
    await send(sessionA.id, 'REPLAY_UNCHANGED');
    assert.equal(events.toasts.length, 5, 'same-object config replay does not repeat an unchanged warning');
    await send(sessionA.id, 'CHANGE_WARNING');
    assert.equal(events.toasts.length, 7, 'changed source scope notifies the instance and affected session');
    for (const toast of events.toasts.slice(5)) {
      assert.equal(toast.variant, 'warning');
      assert.match(toast.message, /componentGroups\/changed\/configuration\/permissions/);
    }
    await send(sessionA.id, 'REPAIR_WARNING');
    assert.equal(events.toasts.length, 9);
    assert.deepEqual(
      events.toasts.slice(7).map((toast) => toast.variant),
      ['info', 'info'],
    );
    assert.ok(
      events.toasts
        .slice(7)
        .some((toast) => toast.message === 'Permission composition warning resolved for agent:worker.'),
    );
    assert.ok(
      events.toasts
        .slice(7)
        .some((toast) => toast.message === 'Permission composition warnings resolved for this session.'),
    );
    await send(sessionA.id, 'REPLAY_UNCHANGED');
    assert.equal(events.toasts.length, 9, 'resolved config and session state stays quiet');
    await send(sessionB.id);
    assert.equal(events.toasts.length, 10, 'a previously warned session receives its recovery once');
    assert.equal(events.toasts.at(-1)!.message, 'Permission composition warnings resolved for this session.');
    await send(sessionB.id);
    assert.equal(events.toasts.length, 10);
    for (const toast of events.toasts) {
      assert.equal(
        await realpath(toast.directory),
        await realpath(f.host.project),
        'delivery belongs to the real native project',
      );
    }
  },
);
