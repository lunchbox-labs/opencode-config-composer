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
    await terminal.command('/compose-configs', 'Compose configs');
    await terminal.choose('Profile', 'Use configured default');
    await terminal.choose('No profile — keep shared settings', 'Apply profile selection?');
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
    await terminal.command('/compose-configs', 'Compose configs');
    await terminal.choose('Profile', 'Use configured default');
    await terminal.choose('○ review', 'Apply profile selection?');
    const preview = await readPreview(terminal, 'Apply profile selection?');
    assert.match(preview, /Pinned by frontmatter/);
    assert.match(preview, /Blocked Composer value/);
    assert.match(preview, /fixture\/beta/);
    await terminal.press('\x1b', 'Profile');
    await assert.rejects(readFile(context.selection.path), /ENOENT/);
    await terminal.choose('○ review', 'Apply profile selection?');
    await reloadFromTerminal(f, terminal);
    assert.equal((await f.editor.context()).selection.choice, 'review');
    await terminal.press('\x1b', 'ctrl+p');
    await terminal.command('/compose-configs', 'Compose configs');
    await terminal.choose('Effective', 'Effective configuration');
    await terminal.choose('agent worker', 'agent worker', 'Edit shared exception');
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
  'terminal edits shared settings, stages members, and authors a profile model at its explicit destination',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'terminal-authoring');
    await writeFile(
      f.paths.shared,
      '// keep policy note\n' +
        JSON.stringify({
          groups: [
            {
              name: 'workers',
              description: 'Shared worker policy',
              members: { agent: ['worker', 'helper'] },
              agent: { temperature: 0.2 },
            },
          ],
          profiles: { mixed: { groups: [{ name: 'workers' }] } },
        }),
    );
    const native = await readFile(f.paths.native, 'utf8');
    await f.host.start();
    const session = await f.host.api<{ id: string }>('/session', { title: 'Authoring journey' });
    const terminal = await nativeTerminal(f.host, session.id, 'terminal-authoring');
    await terminal.wait(['ctrl+p', 'commands']);
    await terminal.command('/compose-configs', 'Compose configs');
    await terminal.choose('Groups', 'Groups · shared');
    await terminal.choose('workers', 'Shared · workers');
    const before = await readFile(f.paths.shared, 'utf8');
    await terminal.choose('Members', 'Members · workers');
    await terminal.choose('agent helper', 'Members · workers', '○ agent helper');
    assert.equal(await readFile(f.paths.shared, 'utf8'), before);
    await terminal.press('\x1b', 'Shared · workers');
    await terminal.choose('Agent settings for members', 'Shared · workers · agent settings');
    await terminal.choose('temperature', 'Shared · workers · temperature');
    await terminal.choose('Edit value', 'enter submit');
    await terminal.press('\x150\r', 'Apply document changes?');
    const preview = await readPreview(terminal, 'Apply document changes?');
    assert.match(preview, /worker/);
    assert.match(preview, /helper/);
    await reloadFromTerminal(f, terminal);
    assert.equal((await f.editor.context()).source.document.groups[0].agent?.temperature, 0);
    assert.match(await readFile(f.paths.shared, 'utf8'), /keep policy note/);
    await terminal.press('\x1b', 'ctrl+p');
    await terminal.command('/compose-configs', 'Compose configs');
    await terminal.choose('Profile', 'Profile');
    await terminal.choose('Edit mixed', 'Profile mixed');
    await terminal.choose('Group settings', 'Profile mixed · groups');
    await terminal.choose('workers', 'Profile mixed · workers');
    await terminal.choose('Agent settings for members', 'Profile mixed · workers · agent settings');
    await terminal.choose('model', 'Profile mixed · workers · model');
    await terminal.choose('Edit value', 'Profile mixed · workers · model', 'Fixture beta');
    await terminal.choose('Fixture beta', 'Profile mixed · workers · variant');
    await terminal.choose('Default', 'Apply document changes?');
    await reloadFromTerminal(f, terminal);
    const document = (await f.editor.context()).source.document;
    assert.equal(document.profiles.mixed.groups?.[0].agent?.model, 'fixture/beta');
    assert.equal(document.profiles.mixed.groups[0].agent.variant, '');
    assert.equal(document.groups[0].agent?.model, undefined);
    assert.equal(await readFile(f.paths.native, 'utf8'), native);
    assert.equal(f.host.requests.length, 0);
  },
);
test(
  'terminal common permission preview names affected members and authored order matches applied runtime',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'terminal-policy-order');
    await f.write(f.paths.shared, {
      groups: [
        {
          name: 'first',
          members: { agent: ['worker', 'helper'] },
          agent: { permission: { edit: 'deny' }, temperature: 0.1 },
        },
        { name: 'second', members: { agent: ['worker', 'helper'] }, agent: { temperature: 0.9 } },
      ],
    });
    await f.host.start();
    const session = await f.host.api<{ id: string }>('/session', { title: 'Policy order journey' });
    const terminal = await nativeTerminal(f.host, session.id, 'terminal-policy-order');
    await terminal.wait(['ctrl+p', 'commands']);
    await terminal.command('/compose-configs', 'Compose configs');
    await terminal.choose('Groups', 'Groups · shared');
    await terminal.choose('first', 'Shared · first');
    await terminal.choose('Agent settings for members', 'Shared · first · agent settings');
    await terminal.choose('permission', 'Shared · first · permission');
    await terminal.choose('Edit value', 'Edit complete permission');
    await terminal.choose('Edit complete permission', 'Shared · first · permission JSON');
    await terminal.press('\x15{"edit":"ask"}\r', 'Apply document changes?');
    const preview = await readPreview(terminal, 'Apply document changes?');
    assert.match(preview, /worker/);
    assert.match(preview, /helper/);
    assert.match(preview, /inheritance remains host-owned/);
    await reloadFromTerminal(f, terminal);
    assert.deepEqual((await f.editor.runtime()).candidate?.agent.worker.permission, { edit: 'ask' });
    await terminal.press('\x1b', 'ctrl+p');
    await terminal.command('/compose-configs', 'Compose configs');
    await terminal.choose('Groups', 'Groups · shared');
    await terminal.choose('first', 'Shared · first');
    await terminal.choose('Move down', 'Apply document changes?');
    const order = await readPreview(terminal, 'Apply document changes?');
    assert.match(order, /0\.1/);
    await reloadFromTerminal(f, terminal);
    assert.deepEqual(
      (await f.editor.context()).source.document.groups.map((group) => group.name),
      ['second', 'first'],
    );
    assert.equal((await f.editor.runtime()).candidate?.agent.worker.temperature, 0.1);
    assert.equal(f.host.requests.length, 0);
  },
);
