import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { type NativeMessage, compositionFixture } from './composition-fixture.ts';
import { systemPrompt } from './content-editor.ts';
import { nativeTerminal } from './terminal.ts';
import { reloadFromTerminal } from './terminal-editor.ts';

type Fixture = Awaited<ReturnType<typeof compositionFixture>>;
interface RegisteredCommand {
  name: string;
  slashName?: string;
  title: string;
}

async function observeShortcuts(f: Fixture) {
  const module = join(f.host.root, 'shortcuts-probe.mjs');
  const file = join(f.host.root, 'registered-shortcuts.json');
  await copyFile(new URL('./shortcuts-probe.mjs', import.meta.url), module);
  const config = join(f.host.configRoot, 'tui.jsonc');
  const before = JSON.parse(await readFile(config, 'utf8')) as { plugin: unknown[] };
  await writeFile(config, JSON.stringify({ ...before, plugin: [...before.plugin, [module, { file }]] }));
  return async (predicate: (commands: RegisteredCommand[]) => boolean) => {
    let commands: RegisteredCommand[] = [];
    for (let attempt = 0; attempt < 600; attempt++) {
      try {
        commands = JSON.parse(await readFile(file, 'utf8')) as RegisteredCommand[];
        if (predicate(commands)) {
          return commands;
        }
      } catch (error) {
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
      await setTimeout(50);
    }
    assert.fail(`Native shortcut registry did not reach its expected state: ${JSON.stringify(commands)}`);
  };
}

const named = (name: string, title?: string) => (commands: RegisteredCommand[]) =>
  commands.some(
    (command) =>
      command.name === `config-composer.shortcut.${name}` &&
      command.slashName === name &&
      (title === undefined || command.title === title),
  );

async function visibleShortcutWarning(terminal: Awaited<ReturnType<typeof nativeTerminal>>, expected: string) {
  const compact = (text: string) => text.replace(/\s/g, '');
  let warning = '';
  for (let attempt = 0; attempt < 600; attempt++) {
    const lines = terminal.text().split('\n');
    const titleRow = lines.findIndex((line) => line.includes('Profile shortcuts'));
    if (titleRow !== -1) {
      const heading = lines[titleRow];
      const titleColumn = heading.indexOf('Profile shortcuts');
      const left = heading.lastIndexOf('┃', titleColumn);
      const right = heading.indexOf('┃', titleColumn + 'Profile shortcuts'.length);
      if (left !== -1 && right !== -1) {
        const contents: string[] = [];
        for (let row = titleRow + 1; row < lines.length; row++) {
          const line = lines[row];
          if (line[left] !== '┃' || line[right] !== '┃') {
            break;
          }
          contents.push(line.slice(left + 1, right).trim());
        }
        // Native wrapping can split even a source path, and background text sits
        // outside the toast on the same rows. Compare only its visible contents.
        warning = contents.join('\n');
        if (compact(warning).includes(compact(expected))) {
          const artifacts = process.env.INTEGRATION_ARTIFACT_DIR;
          if (artifacts !== undefined) {
            await mkdir(artifacts, { recursive: true });
            await writeFile(join(artifacts, 'profile-shortcuts-visible-collision.txt'), warning);
          }
          return;
        }
      }
    }
    await setTimeout(50);
  }
  assert.fail(
    `Native shortcut warning did not visibly render ${JSON.stringify(expected)}:\n${warning}\n${terminal.text()}`,
  );
}

test(
  'native registered shortcuts review scopes, persist ordered saves, apply all linked agents and clear without losing session choices',
  { timeout: 240_000 },
  async (t) => {
    const f = await compositionFixture(t, 'profile-shortcuts-terminal');
    const nativePath = join(f.host.configRoot, 'opencode.jsonc');
    const native = JSON.parse(await readFile(nativePath, 'utf8')) as { agent: Record<string, unknown> };
    native.agent.peer = { mode: 'primary', prompt: 'NATIVE_PEER' };
    await writeFile(nativePath, JSON.stringify(native));
    await f.write(f.paths.shared, {
      componentGroups: {
        focused: {
          agents: ['worker', 'peer'],
          configuration: {
            model: 'fixture/alpha',
            parameters: { temperature: 0.2, topP: 0.6 },
            prompt: { append: ['FOCUS_PROFILE'] },
          },
        },
        working: {
          agents: ['worker', 'peer'],
          configuration: {
            model: 'fixture/beta',
            parameters: { temperature: 0.7, topP: 0.8 },
            prompt: { append: ['WORK_PROFILE'] },
          },
        },
      },
      profiles: {
        focus: { layers: [{ componentGroup: 'focused' }] },
        work: { layers: [{ componentGroup: 'working' }] },
      },
      profileShortcuts: {
        code: { activeProfiles: ['focus', 'work'], description: 'Select focused then working profiles' },
        reverse: { activeProfiles: ['work', 'focus'] },
        quiet: { activeProfiles: [], description: 'Select no profiles' },
      },
      activeProfiles: ['focus'],
    });
    await f.write(f.paths.local, { activeProfiles: [] });
    await f.host.start();
    const original = await f.send();
    const registry = await observeShortcuts(f);
    const terminal = await nativeTerminal(f.host, original.session.id, 'profile-shortcuts-terminal');
    await terminal.wait(['Acceptance conversation', 'verified', 'ctrl+p', 'commands']);
    await registry(named('code', 'Profiles: focus → work'));
    await registry(named('quiet', 'Profiles: none'));
    const bytes = async () =>
      Promise.all([f.paths.shared, f.paths.local, nativePath].map((path) => readFile(path, 'utf8')));
    const before = await bytes();
    await terminal.command('/code', '/code: save profile selection in', 'shared', 'project', 'local');
    await terminal.choose(
      'shared',
      'Save /code profile selection?',
      'Shortcut /code: focus → work',
      'Destination: shared',
      'Masked by local selection',
      'Confirm',
      'Cancel',
    );
    assert.deepEqual(await bytes(), before, 'review precedes every write');
    await terminal.press('\x1b', '/code: save profile selection in');
    assert.deepEqual(await bytes(), before, 'cancel preserves comments and native configuration bytes');
    assert.equal(f.host.requests.length, 1, 'opening a registered slash action and cancelling sends no model request');

    await terminal.choose('shared', 'Save /code profile selection?', 'Masked by local selection');
    await terminal.press('\r', 'Settings saved', 'Saved Composer revision', 'pending');
    assert.deepEqual((await f.document(f.paths.shared)).activeProfiles, ['focus', 'work']);
    assert.equal(await readFile(f.paths.local, 'utf8'), before[1]);
    assert.equal((await f.send()).captured.model, 'alpha', 'a shared selection remains masked by explicit local none');
    await reloadFromTerminal(f, terminal);
    assert.deepEqual((await f.editor.snapshot()).sources.activeProfiles, []);
    assert.equal((await f.send()).captured.model, 'alpha', 'applying masked shared profiles does not activate them');

    const save = async (command: string, selection: string) => {
      const requests = f.host.requests.length;
      await terminal.command(`/${command}`, `/${command}: save profile selection in`);
      await terminal.choose(
        'local',
        `Save /${command} profile selection?`,
        `Shortcut /${command}: ${selection}`,
        'Destination: local',
      );
      await terminal.press('\r', 'Settings saved', 'Saved Composer revision', 'pending');
      assert.equal(f.host.requests.length, requests, 'shortcut save sends no model request');
    };
    await save('code', 'focus → work');
    assert.deepEqual((await f.document(f.paths.local)).activeProfiles, ['focus', 'work']);
    assert.equal(
      (await f.send(original.session.id)).captured.model,
      'alpha',
      'save retains the currently applied configuration',
    );
    await reloadFromTerminal(f, terminal);
    const check = async (model: string, temperature: number, topP: number) => {
      const agents = await f.host.api<
        {
          name: string;
          model?: { providerID: string; modelID: string };
          prompt?: string;
        }[]
      >('/agent');
      for (const name of ['worker', 'peer']) {
        const agent = agents.find((candidate) => candidate.name === name);
        assert.ok(agent !== undefined);
        assert.deepEqual(agent.model, { providerID: 'fixture', modelID: model });
        assert.match(agent.prompt ?? '', /FOCUS_PROFILE/);
        assert.match(agent.prompt ?? '', /WORK_PROFILE/);
        const captured = (await f.send(name === 'worker' ? original.session.id : undefined, name)).captured;
        assert.equal(captured.model, model);
        assert.equal(captured.temperature, temperature);
        assert.equal(captured.top_p, topP);
        assert.match(systemPrompt(captured), /FOCUS_PROFILE/);
        assert.match(systemPrompt(captured), /WORK_PROFILE/);
      }
    };
    await check('beta', 0.7, 0.8);
    await save('reverse', 'work → focus');
    assert.deepEqual((await f.document(f.paths.local)).activeProfiles, ['work', 'focus']);
    assert.equal((await f.send()).captured.model, 'beta', 'reverse order is pending until applied');
    await reloadFromTerminal(f, terminal);
    await check('alpha', 0.2, 0.6);

    const selected = await f.host.api<NativeMessage>(`/session/${original.session.id}/message`, {
      agent: 'worker',
      model: { providerID: 'fixture', modelID: 'beta' },
      parts: [{ type: 'text', text: 'Reply with verified.' }],
    });
    assert.equal(selected.info.error, undefined);
    assert.equal(f.host.requests.at(-1)!.model, 'beta', 'the real conversation chooses a different session model');
    await save('quiet', 'none');
    assert.deepEqual((await f.document(f.paths.local)).activeProfiles, []);
    await reloadFromTerminal(f, terminal);
    assert.deepEqual((await f.editor.snapshot()).sources.activeProfiles, []);
    const retained = await f.send(original.session.id);
    assert.equal(retained.captured.model, 'beta', 'clear preserves the selected model of the existing session');
    assert.ok(
      !/FOCUS_PROFILE|WORK_PROFILE/.test(systemPrompt(retained.captured)),
      'clear removes active profile prompts',
    );
    assert.equal((await f.send()).captured.model, 'alpha', 'fresh dispatch restores the native default');
    const clearAgents = await f.host.api<{ name: string; model?: unknown; prompt?: string }[]>('/agent');
    for (const name of ['worker', 'peer']) {
      const agent = clearAgents.find((candidate) => candidate.name === name)!;
      assert.equal(agent.model, undefined, `clear removes ${name}'s profile model`);
      assert.equal(agent.prompt, `NATIVE_${name.toUpperCase()}`);
    }
    assert.ok((await f.history(original.session.id)).some((message) => message.info.id === original.message.info.id));
    assert.equal(
      (await f.host.api<{ title: string }>(`/session/${original.session.id}`)).title,
      'Acceptance conversation',
    );
    assert.equal(await readFile(nativePath, 'utf8'), before[2], 'instance apply never rewrites native configuration');
    assert.match(await readFile(f.paths.shared, 'utf8'), /Preserve fixture comments/);
    assert.match(await readFile(f.paths.local, 'utf8'), /Preserve fixture comments/);
  },
);

test(
  'native shortcut registrations reject stale definitions, refresh edited actions and reject real native command collisions',
  { timeout: 180_000 },
  async (t) => {
    const f = await compositionFixture(t, 'profile-shortcuts-refresh');
    const nativePath = join(f.host.configRoot, 'opencode.jsonc');
    const native = JSON.parse(await readFile(nativePath, 'utf8')) as Record<string, unknown>;
    native.command = { 'native-action': { template: 'Reply with verified.', description: 'Native fixture command' } };
    await writeFile(nativePath, JSON.stringify(native));
    await f.write(f.paths.shared, {
      profiles: { focus: {}, work: {} },
      profileShortcuts: { code: { activeProfiles: ['focus', 'work'] } },
    });
    await f.host.start();
    const original = await f.send();
    assert.ok((await f.host.api<{ name: string }[]>('/command')).some((command) => command.name === 'native-action'));
    const registry = await observeShortcuts(f);
    const terminal = await nativeTerminal(f.host, original.session.id, 'profile-shortcuts-refresh');
    await terminal.wait(['Acceptance conversation', 'verified', 'ctrl+p', 'commands']);
    await registry(named('code', 'Profiles: focus → work'));
    const edited = await f.document(f.paths.shared);
    edited.profileShortcuts!.code.activeProfiles = ['work', 'focus'];
    await f.write(f.paths.shared, edited);
    const bytes = await readFile(f.paths.shared, 'utf8');
    await terminal.command(
      '/code',
      'Shortcut /code changed.',
      'Refresh shortcuts in Compose',
      'before reviewing its new selection.',
    );
    assert.equal(await readFile(f.paths.shared, 'utf8'), bytes);
    assert.equal(f.host.requests.length, 1, 'stale shortcuts fail before dispatch or write');
    const refresh = async () => {
      await terminal.command('/compose', 'Compose');
      await terminal.choose('Refresh profile shortcuts');
    };
    await refresh();
    await registry(named('code', 'Profiles: work → focus'));
    await terminal.press('\x1b', 'ctrl+p', 'commands');
    await terminal.command('/code', '/code: save profile selection in');
    await terminal.choose('local', 'Shortcut /code: work → focus', 'Save /code profile selection?');
    await terminal.press('\x1b', '/code: save profile selection in');
    await terminal.press('\x1b', 'ctrl+p', 'commands');
    assert.equal(await readFile(f.paths.shared, 'utf8'), bytes);

    edited.profileShortcuts = { 'native-action': { activeProfiles: [] } };
    await f.write(f.paths.shared, edited);
    const collisionBytes = await readFile(f.paths.shared, 'utf8');
    await refresh();
    await visibleShortcutWarning(
      terminal,
      `${await realpath(f.paths.shared)}/profileShortcuts/native-action: ` +
        'Shortcut /native-action conflicts with an existing command or alias. Choose a different shortcut name.',
    );
    await registry((commands) => !commands.some((command) => command.name.startsWith('config-composer.shortcut.')));
    assert.equal(await readFile(f.paths.shared, 'utf8'), collisionBytes);
    assert.equal(f.host.requests.length, 1, 'refresh and rejected collisions send no model request');
    assert.ok((await f.history(original.session.id)).some((message) => message.info.id === original.message.info.id));
  },
);
