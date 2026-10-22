import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compositionFixture } from './integration/composition-fixture.ts';
import { nativeTerminal } from './integration/terminal.ts';
test(
  'native TUI exposes direct profiles and read-only inspection for an empty installation',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'tui-smoke');
    await f.host.start();
    const session = await f.host.api<{ id: string }>('/session', { title: 'Composer smoke' });
    const terminal = await nativeTerminal(f.host, session.id);
    await terminal.wait(['ctrl+p', 'commands']);
    await terminal.command('/profiles', 'Profiles', 'Follow configured default', 'Shared only');
    await terminal.press('\x1b', 'ctrl+p');
    await terminal.command(
      '/view-configs',
      'Configuration',
      'Shared groups',
      'Profile definitions',
      'Reload configurations',
    );
    await terminal.choose('Retained session selection', 'Existing sessions can retain', '/models', '/variants');
    assert.equal(f.host.requests.length, 0);
  },
);
