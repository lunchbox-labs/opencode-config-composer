import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compositionFixture } from './integration/composition-fixture.ts';
import { nativeTerminal } from './integration/terminal.ts';
test(
  'native TUI exposes direct profiles and read-only inspection for an empty installation',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'tui-smoke');
    await f.write(f.paths.native, {
      ...f.native,
      agent: {
        ...f.native.agent,
        helper: { ...f.native.agent.helper, hidden: true },
        build: { model: 'fixture/beta' },
      },
    });
    await f.host.start();
    const session = await f.host.api<{ id: string }>('/session', { title: 'Composer smoke' });
    const terminal = await nativeTerminal(f.host, session.id);
    await terminal.wait(['ctrl+p', 'commands', 'Profile: Shared only']);
    await terminal.command('/profiles', 'Profiles', 'Follow configured default', 'Shared only');
    await terminal.press('\x1b', 'ctrl+p');
    await terminal.command(
      '/view-configs',
      'Configuration',
      'Shared groups',
      'Profile definitions',
      'Runtime status and sources',
    );
    assert.doesNotMatch(terminal.text(), /agent build/);
    await terminal.choose('Show built-in agents', 'Hide built-in agents', 'agent build');
    await terminal.choose('Hide built-in agents', 'Show built-in agents');
    assert.doesNotMatch(terminal.text(), /agent build/);
    await terminal.choose('agent helper', 'agent helper', '↑↓ select');
    assert.doesNotMatch(terminal.text(), /Search…/);
    await terminal.chooseFixed('groups', 'agent helper · groups', 'No declared groups');
    await terminal.press('\x1b', 'agent helper', '↑↓ select');
    await terminal.chooseFixed('← Back', 'Configuration');
    await terminal.choose('Retained session selection', 'Existing sessions can retain', '/models', '/variants');
    await terminal.stop();
    const home = await nativeTerminal(f.host, undefined, 'home-slot');
    await home.wait(['Profile: Shared only']);
    assert.equal(f.host.requests.length, 0);
  },
);
