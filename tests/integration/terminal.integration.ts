import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { compositionFixture } from './composition-fixture.ts';
import { nativeTerminal } from './terminal.ts';
import { readPreview, reloadFromTerminal } from './terminal-editor.ts';
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
    const preview = await readPreview(terminal, 'Apply profile selection?');
    assert.match(preview, /\/agent\/helper\/top_p/);
    assert.match(preview, /Removed contribution: inherit\/native fallback/);
    assert.match(preview, /Previously configured/);
    assert.match(preview, /0\.7/);
    await reloadFromTerminal(f, terminal);
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
    const preview = await readPreview(terminal, 'Apply profile selection?');
    assert.match(preview, /Pinned by frontmatter/);
    assert.match(preview, /Blocked Composer value/);
    assert.match(preview, /fixture\/beta/);
    await terminal.press('\x1b', 'Profiles');
    await assert.rejects(readFile(context.selection.path), /ENOENT/);
    await terminal.choose('○ review', 'Apply profile selection?');
    await reloadFromTerminal(f, terminal);
    assert.equal((await f.editor.context()).selection.choice, 'review');
    await terminal.press('\x1b', 'ctrl+p');
    await terminal.command('/view-configs', 'Configuration');
    await terminal.choose('agent worker', 'agent worker', 'model');
    await terminal.choose(
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
  'terminal reload adopts external native Markdown and rebootstrap keeps inspection available',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'terminal-external-reload');
    await mkdir(join(f.host.configRoot, 'agents'));
    await mkdir(join(f.host.configRoot, 'commands'));
    const agent = join(f.host.configRoot, 'agents/worker.md');
    const command = join(f.host.configRoot, 'commands/reload-proof.md');
    await writeFile(agent, '---\nmodel: fixture/alpha\n---\nBODY_OLD');
    await writeFile(command, '---\ndescription: COMMAND_OLD\n---\nCOMMAND_BODY_OLD');
    await f.host.start();
    const session = await f.host.api<{ id: string }>('/session', { title: 'External reload journey' });
    const terminal = await nativeTerminal(f.host, session.id, 'terminal-external-reload');
    await terminal.wait(['ctrl+p', 'commands']);
    await writeFile(agent, '---\nmodel: fixture/beta\n---\nBODY_NEW');
    await writeFile(command, '---\ndescription: COMMAND_NEW\n---\nCOMMAND_BODY_NEW');
    const previous = await f.editor.runtime();
    await f.host.prepareConfigurationDependencies();
    await terminal.command('/reload-configs', 'Configuration reloaded');
    const current = await f.editor.runtime();
    assert.notEqual(current.id, previous.id);
    assert.equal(current.candidate?.agent.worker.model, 'fixture/beta');
    await terminal.press('\x1b', 'ctrl+p');
    await terminal.command('/view-configs', 'Configuration');
    await terminal.choose('agent worker', 'agent worker');
    await terminal.choose('model', 'agent worker · model', 'fixture/beta');
    await terminal.press('\x1b', 'agent worker');
    await terminal.press('\x1b', 'Configuration');
    await terminal.press('\x1b', 'ctrl+p');
    await terminal.press('/reload-proof', 'COMMAND_NEW');
    assert.equal(f.host.requests.length, 0);
  },
);
test(
  'terminal global JSON reload renders a restart warning without success or disposal',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'terminal-restart-warning');
    await f.host.start();
    const previous = await f.editor.runtime();
    const session = await f.host.api<{ id: string }>('/session', { title: 'Restart warning journey' });
    const terminal = await nativeTerminal(f.host, session.id, 'terminal-restart-warning');
    await terminal.wait(['ctrl+p', 'commands']);
    await f.write(f.paths.native, { ...f.native, username: 'external-global-edit' });
    const saved = await readFile(f.paths.native, 'utf8');
    await terminal.command(
      '/reload-configs',
      'Restart OpenCode to apply these changes.',
      'Restart the OpenCode server process',
    );
    assert.doesNotMatch(terminal.text(), /Configuration reloaded|Composer revision applied/);
    assert.equal((await f.editor.runtime()).id, previous.id);
    assert.equal(await readFile(f.paths.native, 'utf8'), saved);
    assert.equal(f.host.requests.length, 0);
  },
);
