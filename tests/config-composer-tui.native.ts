import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compositionFixture } from './integration/composition-fixture.ts';
import { nativeTerminal } from './integration/terminal.ts';
test('native TUI opens Profile, Groups and Effective for an empty installation', { timeout: 240000 }, async (t) => {
  const f = await compositionFixture(t, 'tui-smoke');
  await f.host.start();
  const session = await f.host.api<{ id: string }>('/session', { title: 'Composer smoke' });
  const terminal = await nativeTerminal(f.host, session.id);
  await terminal.wait(['ctrl+p', 'commands']);
  await terminal.command('/compose-configs', 'Compose configs', 'Profile', 'Groups', 'Effective');
  await terminal.choose('Groups', 'Groups · shared', 'No groups configured');
  await terminal.press('\x1b', 'Compose configs');
  await terminal.choose('Profile', 'Use configured default', 'No profile');
  await terminal.press('\x1b', 'Compose configs');
  await terminal.choose('Effective', 'Effective configuration', 'Retained session selection');
  await terminal.choose('Retained session selection', 'Existing sessions can retain', '/models', '/variants');
  assert.equal(f.host.requests.length, 0);
});
