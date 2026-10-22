import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { compositionFixture } from './composition-fixture.ts';
import { nativeTerminal } from './terminal.ts';
import { reloadFromTerminal } from './terminal-editor.ts';
test('terminal choose preview cancel confirm apply and inspect pinned effects', { timeout: 240000 }, async (t) => {
  const f = await compositionFixture(t, 'terminal-profile');
  await mkdir(join(f.host.configRoot, 'agents'));
  await writeFile(join(f.host.configRoot, 'agents/worker.md'), '---\nmodel: fixture/alpha\n---\nNATIVE_WORKER');
  await f.write(f.paths.shared, {
    profiles: { review: { agent: { worker: { model: 'fixture/beta', temperature: 0 } } } },
  });
  await f.host.start();
  const context = await f.editor.context();
  const session = await f.host.api<{ id: string }>('/session', { title: 'Profile journey' });
  const terminal = await nativeTerminal(f.host, session.id);
  await terminal.wait(['ctrl+p', 'commands']);
  await terminal.command('/compose-configs', 'Compose configs');
  await terminal.choose('Profile', 'Follow default');
  await terminal.choose('review', 'Save profile selection?', 'blocked Composer', 'fixture/beta');
  await terminal.press('\x1b', 'Profile');
  await assert.rejects(readFile(context.selection.path), /ENOENT/);
  await terminal.choose('review', 'Save profile selection?');
  await terminal.press('\r', 'Selection saved', 'Apply now');
  await reloadFromTerminal(f, terminal);
  assert.equal((await f.editor.context()).selection.choice, 'review');
  await terminal.press('\x1b', 'Selection saved');
  await terminal.press('\x1b', 'Profile');
  await terminal.press('\x1b', 'Compose configs');
  await terminal.press('\x1b', 'ctrl+p');
  await terminal.command('/compose-configs', 'Compose configs');
  await terminal.choose('Effective', 'Effective configuration');
  await terminal.choose('/agent/worker/model', 'frontmatter', 'blockedComposer', 'fixture/beta');
  assert.equal(f.host.requests.length, 0);
});
