import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { compositionFixture } from './composition-fixture.ts';
import { nativeTerminal } from './terminal.ts';
import { applyFromTerminal, readPreview } from './terminal-editor.ts';
test(
  'terminal no-profile preview discloses a removed field before its single Apply',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'terminal-removal');
    await f.write(f.paths.shared, {
      defaultProfile: 'a',
      profiles: { a: { agent: { helper: { top_p: 0.7 } } } },
    });
    const source = await readFile(f.paths.shared, 'utf8');
    const native = await readFile(f.paths.native, 'utf8');
    await f.host.start();
    assert.equal((await f.editor.runtime()).candidate?.agent.helper.top_p, 0.7);
    const session = await f.host.api<{ id: string }>('/session', { title: 'Removal journey' });
    const terminal = await nativeTerminal(f.host, session.id, 'terminal-removal');
    await terminal.wait(['ctrl+p', 'commands']);
    await terminal.command('/profiles', 'Follow configured default');
    await terminal.choose('Shared only', 'Apply profile selection?');
    const preview = await readPreview(terminal);
    assert.match(preview, /\/agent\/helper\/top_p/);
    assert.match(preview, /Removed contribution: inherit\/native fallback/);
    assert.match(preview, /Previously configured/);
    assert.match(preview, /0\.7/);
    await applyFromTerminal(f, terminal);
    assert.equal((await f.editor.runtime()).candidate?.agent.helper.top_p, undefined);
    assert.equal((await f.editor.context()).selection.choice, null);
    assert.equal(await readFile(f.paths.shared, 'utf8'), source);
    assert.equal(await readFile(f.paths.native, 'utf8'), native);
    assert.equal(f.host.requests.length, 0);
  },
);
test(
  'terminal profile selection previews pins, cancels, applies once and inspects raw final authority',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'terminal-profile');
    await mkdir(join(f.host.configRoot, 'agents'));
    const markdown = join(f.host.configRoot, 'agents/worker.md');
    const raw = '---\nmodel: fixture/alpha\n---\nNATIVE_WORKER';
    await writeFile(markdown, raw);
    await f.write(f.paths.shared, {
      profiles: { review: { agent: { worker: { model: 'fixture/beta', temperature: 0 } } } },
    });
    await f.host.start();
    const context = await f.editor.context();
    const session = await f.host.api<{ id: string }>('/session', { title: 'Profile journey' });
    const terminal = await nativeTerminal(f.host, session.id, 'terminal-profile');
    await terminal.wait(['ctrl+p', 'commands']);
    await terminal.command('/profiles', 'Follow configured default');
    await terminal.choose('○ review', 'Apply profile selection?');
    const preview = await readPreview(terminal);
    assert.match(preview, /Pinned by frontmatter/);
    assert.match(preview, /Blocked Composer value/);
    assert.match(preview, /fixture\/beta/);
    await terminal.press('\x1b', 'Profiles');
    await assert.rejects(readFile(context.selection.path), /ENOENT/);
    await terminal.choose('○ review', 'Apply profile selection?');
    await applyFromTerminal(f, terminal);
    assert.equal((await f.editor.context()).selection.choice, 'review');
    await terminal.press('\x1b', 'ctrl+p', 'Profile: review');
    await terminal.command('/view-configs', 'Configuration');
    await terminal.choose('agent worker', 'agent worker', 'model');
    await terminal.chooseFixed(
      'model',
      'agent worker · model',
      'Pinned by frontmatter',
      'Blocked Composer value',
      'fixture/beta',
    );
    assert.equal(await readFile(markdown, 'utf8'), raw);
    assert.equal(f.host.requests.length, 0);
  },
);
test(
  'terminal inspection retains loaded pins and a requested profile switch rejects native drift',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'terminal-native-drift');
    await mkdir(join(f.host.configRoot, 'agents'));
    const agent = join(f.host.configRoot, 'agents/worker.md');
    await writeFile(agent, '---\nmodel: fixture/alpha\n---\nBODY_OLD');
    await f.host.start();
    const previous = await f.editor.runtime();
    const session = await f.host.api<{ id: string }>('/session', { title: 'Native drift journey' });
    const terminal = await nativeTerminal(f.host, session.id, 'terminal-native-drift');
    await terminal.wait(['ctrl+p', 'commands']);
    await writeFile(agent, '---\nmode: [invalid]\n---\nBODY_NEW');
    await terminal.command('/view-configs', 'Configuration');
    await terminal.choose('agent worker', 'agent worker');
    await terminal.chooseFixed('model', 'agent worker · model', 'fixture/alpha');
    await terminal.press('\x1b', 'agent worker');
    await terminal.press('\x1b', 'Configuration');
    await terminal.press('\x1b', 'ctrl+p');
    await terminal.command('/profiles', 'Follow configured default');
    await terminal.choose('Shared only', 'Config Composer', 'Restart the OpenCode server process');
    assert.doesNotMatch(terminal.text(), /Composer revision applied/);
    assert.equal((await f.editor.runtime()).id, previous.id);
    assert.equal(f.host.requests.length, 0);
  },
);
test(
  'terminal inspection shows downstream native values without borrowing Composer attribution',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'terminal-downstream');
    const later = join(f.host.configRoot, 'later-plugin.mjs');
    await writeFile(
      later,
      `export default { id: 'later-config', server: async () => ({ config: async (config) => { config.agent.worker.temperature = 0.7; } }) };`,
    );
    await f.write(f.paths.native, { ...f.native, plugin: [f.host.installed.directory, later] });
    await f.write(f.paths.shared, { agent: { worker: { temperature: 0.2 } } });
    await f.host.start();
    await assert.rejects(f.editor.runtime(), /Configuration changed after Composer/);
    const session = await f.host.api<{ id: string }>('/session', { title: 'Downstream contribution' });
    const terminal = await nativeTerminal(f.host, session.id, 'terminal-downstream');
    await terminal.wait(['ctrl+p', 'Profile: Shared only']);
    await terminal.command('/view-configs', 'Configuration');
    await terminal.choose('agent worker', 'agent worker');
    await terminal.chooseFixed(
      'temperature',
      'agent worker · temperature',
      'Loaded configuration contribution: 0.7',
      'exact source unavailable',
      'Effective native temperature: 0.7',
    );
    assert.doesNotMatch(terminal.text(), /Pinned by frontmatter/);
    assert.equal(f.host.requests.length, 0);
  },
);
