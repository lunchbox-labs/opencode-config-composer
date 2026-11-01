import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { compositionFixture } from './integration/composition-fixture.ts';
import { nativeTerminal } from './integration/terminal.ts';
import { applyFromTerminal } from './integration/terminal-editor.ts';
import { runtimeDiagnostic } from '../src/config-composer/tui/inspection.ts';

test(
  'native inspector explains the selected alias binding and native default variant',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'tui-alias-source');
    await f.write(f.paths.native, {
      ...f.native,
      agent: { ...f.native.agent, worker: { ...f.native.agent.worker, groups: ['coding'], variant: 'high' } },
    });
    await f.write(f.paths.shared, {
      models: { coding: { model: 'fixture/alpha', variant: 'high' } },
      groups: { coding: { agent: { modelRef: 'coding' } } },
      profiles: { a: { models: { coding: { model: 'fixture/beta' } } } },
      defaultProfile: 'a',
    });
    await f.host.start();
    const session = await f.host.api<{ id: string }>('/session', { title: 'Model alias inspection' });
    const terminal = await nativeTerminal(f.host, session.id);
    await terminal.wait(['Profile: a']);
    await terminal.command('/view-configs', 'Configuration');
    await terminal.choose('agent worker', 'agent worker', '↑↓ select');
    assert.doesNotMatch(terminal.text(), /modelRef/);
    await terminal.chooseFixed('model', 'agent worker · model', 'Model alias "coding" binding');
    // Long native configuration paths can wrap the binding pointer across visual lines.
    await terminal.idle();
    assert.match(terminal.text().replace(/\s/g, ''), /\/profiles\/a\/models\/coding/);
    await terminal.press('\x1b', 'agent worker', '↑↓ select');
    await terminal.chooseFixed('variant', 'agent worker · variant', 'Native default variant');
    await terminal.idle();
    assert.match(terminal.text().replace(/\s/g, ''), /\/profiles\/a\/models\/coding/);
    assert.equal(f.host.requests.length, 0);
  },
);

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

test(
  'native TUI keeps profiles read-only and explains a process profile in inspection',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'tui-process-profile');
    await f.write(f.paths.shared, { profiles: { a: { agent: { worker: { model: 'fixture/beta' } } }, b: {} } });
    await f.host.start({ variables: { OPENCODE_CONFIG_COMPOSER_PROFILE: 'a' } });
    const runtime = await f.editor.runtime();
    const session = await f.host.api<{ id: string }>('/session', { title: 'Process profile' });
    const terminal = await nativeTerminal(f.host, session.id, 'process-profile');
    await terminal.wait(['Profile: a (env)']);
    await terminal.command(
      '/profiles',
      'Config Composer',
      'OPENCODE_CONFIG_COMPOSER_PROFILE selects profile a',
      'Profile switching is',
    );
    assert.doesNotMatch(terminal.text(), /Follow configured default/);
    await terminal.press('\x1b', 'ctrl+p');
    await terminal.command('/view-configs', 'Configuration');
    await terminal.choose('Runtime status and sources', 'Applied profile: a', 'OPENCODE_CONFIG_COMPOSER_PROFILE');
    await assert.rejects(readFile(runtime.selectionLocator.path), /ENOENT/);
    assert.equal(f.host.requests.length, 0);
  },
);

test(
  'native details scroll in a narrow terminal, stay redacted and return through Back and Escape before an explicit Apply',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'tui-scroll');
    const members = Array.from({ length: 12 }, (_, index) => `member${index}`);
    await f.write(f.paths.native, {
      ...f.native,
      agent: {
        ...f.native.agent,
        ...Object.fromEntries(
          members.map((name) => [name, { mode: 'subagent', prompt: 'MEMBER', groups: ['coding'] }]),
        ),
      },
    });
    await f.write(f.paths.shared, {
      agent: {
        ...Object.fromEntries(members.map((name, index) => [name, { temperature: index / 100 }])),
        member11: { temperature: 0.11, options: { apiKey: 'PRIVATE_SENTINEL', reasoningEffort: 'high' } },
      },
      groups: { coding: { agent: { top_p: 0.5 } } },
      profiles: { review: { groups: { coding: { agent: { model: 'fixture/beta' } } } } },
    });
    await f.host.start();
    const session = await f.host.api<{ id: string }>('/session', { title: 'Scrolling details' });
    const terminal = await nativeTerminal(f.host, session.id, 'tui-scroll', { cols: 80, rows: 24 });
    const title = 'Global models and shared exceptions';
    await terminal.wait(['ctrl+p', 'Profile: Shared only']);
    await terminal.command('/view-configs', 'Configuration');
    await terminal.choose(title, title, 'Current loaded configuration', 'enter/esc back');
    assert.equal(terminal.shows('"reasoningEffort": "high"'), false, 'the definitions extend beyond the dialog');
    const read = await terminal.scrollTo('"reasoningEffort": "high"');
    assert.ok(terminal.shows(title) && terminal.shows('enter/esc back'), 'scrolling keeps the title and hint');
    assert.equal(terminal.shows('Current loaded configuration'), false);
    assert.match(read, /apiKey=\[redacted\]/);
    assert.doesNotMatch(read, /PRIVATE_SENTINEL/);
    await terminal.press('\x1b[H', 'Current loaded configuration');
    await terminal.press('\x1b', 'Configuration', 'Runtime status and sources');
    await terminal.choose(title, title, 'enter/esc back');
    await terminal.press('\r', 'Configuration', 'Runtime status and sources');
    await terminal.press('\x1b', 'ctrl+p');
    // The command helper waits for the restored conversation input.
    await terminal.command('/profiles', 'Follow configured default');
    await terminal.choose('○ review', 'Apply profile selection?', 'enter apply…');
    const preview = await terminal.scrollTo('Existing session model/variant choices remain native.');
    for (const name of members) {
      assert.match(preview, new RegExp(`/agent/${name}/model`));
    }
    await terminal.press('\r', 'Apply reviewed changes?');
    await terminal.press('\x1b', 'Apply profile selection?', 'enter apply…');
    await terminal.idle();
    assert.ok(
      terminal.shows('Existing session model/variant choices remain native.'),
      'cancelling Apply keeps the place',
    );
    await terminal.press('\x1b', 'Profiles');
    const context = await f.editor.context();
    await assert.rejects(readFile(context.selection.path), /ENOENT/);
    await terminal.choose('○ review', 'Apply profile selection?', 'enter apply…');
    await applyFromTerminal(f, terminal, 'Profile review applied.');
    assert.equal((await f.editor.context()).selection.choice, 'review');
    assert.equal((await f.editor.runtime()).candidate?.agent.member11.model, 'fixture/beta');
    assert.equal(f.host.requests.length, 0);
  },
);

test('native TUI shows delayed config failures until recovery and again after it', { timeout: 240000 }, async (t) => {
  const f = await compositionFixture(t, 'tui-error-notice');
  const slow = join(f.host.configRoot, 'slow-config.mjs');
  await writeFile(
    slow,
    `export default { id: 'slow-config', server: async () => ({
    config: async () => { await new Promise(resolve => setTimeout(resolve, 1600)); }
  }) };`,
  );
  await f.write(f.paths.native, { ...f.native, plugin: [f.host.installed.directory, slow] });
  const projectNative = join(f.host.project, 'opencode.jsonc');
  await f.write(projectNative, {});
  await f.host.start();
  const terminal = await nativeTerminal(f.host, undefined, 'error-notice');
  await terminal.wait(['Profile: Shared only']);
  for (let episode = 0; episode < 2; episode++) {
    // The later config hook keeps the host refresh pending beyond the old timer.
    // The second episode publishes the identical diagnostic after a good refresh.
    await f.write(projectNative, { agent: { worker: { groups: ['missing-group'] } } });
    await f.host.api('/instance/dispose', {});
    const loaded = await f.host.api('/config');
    assert.match(runtimeDiagnostic(loaded, f.host.project, f.host.project) ?? '', /Composer not applied/);
    await terminal.wait(['Config Composer', 'Composer not applied.', 'Profile: error']);
    // The host expires the toast; the prompt slot still reports the failed composition.
    for (let attempt = 0; terminal.text().includes('Composer not applied.') && attempt < 400; attempt++) {
      await setTimeout(50);
    }
    assert.doesNotMatch(terminal.text(), /Composer not applied\./);
    assert.match(terminal.text(), /Profile: error/);
    assert.doesNotMatch(terminal.text(), /Profile: Shared only/);
    await f.write(projectNative, {});
    await f.host.api('/instance/dispose', {});
    await terminal.wait(['Profile: Shared only']);
    assert.doesNotMatch(terminal.text(), /Profile: error|Composer not applied\./);
  }
  assert.equal(f.host.requests.length, 0);
});
