import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { compositionFixture } from './composition-fixture.ts';
import { nativeTerminal } from './terminal.ts';
import { reloadFromTerminal } from './terminal-editor.ts';

test(
  'real terminal validates, cancels, saves, applies and resets typed model parameters',
  { timeout: 240_000 },
  async (t) => {
    const f = await compositionFixture(t, 'parameter-terminal');
    await f.write(f.paths.shared, {
      configurationPresets: { tuning: { model: 'fixture/alpha' } },
      componentGroups: { work: { agents: ['worker'] } },
      profiles: {
        work: {
          layers: [{ componentGroup: 'work' }, { configurationPreset: 'tuning', target: { agents: ['worker'] } }],
        },
      },
      activeProfiles: ['work'],
    });
    await f.host.start();
    const original = await f.send();
    const terminal = await nativeTerminal(f.host, original.session.id, 'parameter-terminal');
    await terminal.wait(['Acceptance conversation', 'verified', 'ctrl+p', 'commands']);
    const open = async () => {
      await terminal.command('/compose-configs', 'Compose configs');
      await terminal.choose('Model parameters and provider options', 'Parameter destination');
      await terminal.press('\r', 'Parameter target');
      await terminal.choose('Preset: tuning', 'Preset: tuning: parameters saved here');
    };
    await open();
    const before = await readFile(f.paths.shared, 'utf8');
    await terminal.choose('temperature', 'temperature: blank removes this local value');
    await terminal.press('0.4\r', 'Save model parameters?', 'resolved parameters');
    await terminal.press('\x1b', 'temperature: blank removes this local value');
    assert.equal(await readFile(f.paths.shared, 'utf8'), before, 'cancelled confirmation does not save');
    await terminal.press('\x15' + '0.5\r', 'Save model parameters?');
    await terminal.press('\r', 'Settings saved');
    assert.equal((await f.document(f.paths.shared)).configurationPresets!.tuning.parameters!.temperature, 0.5);
    assert.equal((await f.send(original.session.id)).captured.temperature, original.captured.temperature);
    await reloadFromTerminal(f, terminal);
    assert.equal((await f.send(original.session.id)).captured.temperature, 0.5);
    await open();
    await terminal.choose('Custom provider options (JSON)', 'options: blank removes this local value');
    await terminal.press('{"reasoningEffort":"medium"}\r', 'Save model parameters?', 'reasoningEffort');
    await terminal.press('\r', 'Settings saved');
    await reloadFromTerminal(f, terminal);
    assert.equal((await f.send(original.session.id)).captured.reasoning_effort, 'medium');
    await open();
    await terminal.choose('topK', 'topK: blank removes this local value');
    const valid = await readFile(f.paths.shared, 'utf8');
    await terminal.press('3\r', 'does not support topK');
    assert.equal(await readFile(f.paths.shared, 'utf8'), valid);
    // Error toasts leave the input open; Escape returns through the editor stack.
    await terminal.press('\x1b', 'Preset: tuning: parameters saved here');
    await terminal.choose('Reset local parameters', 'Save model parameters?');
    await terminal.press('\r', 'Settings saved');
    await reloadFromTerminal(f, terminal);
    const reset = (await f.send(original.session.id)).captured;
    assert.equal(reset.temperature, original.captured.temperature);
    assert.equal(reset.reasoning_effort, original.captured.reasoning_effort);
    assert.equal((await f.document(f.paths.shared)).configurationPresets!.tuning.parameters, undefined);
    assert.match(await readFile(f.paths.shared, 'utf8'), /Preserve fixture comments/);
    assert.ok((await f.history(original.session.id)).some((message) => message.info.id === original.message.info.id));
  },
);

test(
  'real terminal edits ordered configured permissions, previews exact matches and persists without runtime application',
  { timeout: 240_000 },
  async (t) => {
    const f = await compositionFixture(t, 'permission-terminal');
    await f.write(f.paths.shared, {
      configurationPresets: {
        checks: {
          permissions: [
            { tool: 'bash', pattern: 'git *', action: 'deny' },
            { tool: 'bash', pattern: 'git status', action: 'allow' },
          ],
        },
      },
    });
    await f.host.start();
    const original = await f.send();
    const running = JSON.stringify(await f.host.api('/agent'));
    const terminal = await nativeTerminal(f.host, original.session.id, 'permission-terminal');
    await terminal.wait(['Acceptance conversation', 'verified', 'ctrl+p', 'commands']);
    await terminal.command('/compose-configs', 'Compose configs');
    await terminal.choose('Ordered permission rules and configured previews', 'Permission destination');
    await terminal.press('\r', 'Permission target');
    await terminal.choose('Preset: checks', 'Preset: checks: ordered permissions');
    const before = await readFile(f.paths.shared, 'utf8');
    const preview = async (input: string, ...expected: string[]) => {
      await terminal.choose('Test configured matches', 'Permission preview scope');
      await terminal.choose('This definition', 'Permission tool to test');
      await terminal.press('\r', 'Permission input to test');
      await terminal.press(
        `${input}\r`,
        'Configured permission match',
        'Configured preview only',
        ...expected.filter((label) => !label.startsWith('/')),
      );
      // Native alerts hard-wrap long source pointers inside path segments.
      const compact = terminal.text().replace(/\s+/g, '');
      for (const pointer of expected.filter((label) => label.startsWith('/'))) {
        assert.ok(compact.includes(pointer), `Displayed permission origin: ${pointer}`);
      }
      await terminal.press('\x1b', 'Permission input to test');
      await terminal.press('\x1b', 'Permission tool to test');
      await terminal.press('\x1b', 'Permission preview scope');
      await terminal.press('\x1b', 'Preset: checks: ordered permissions');
    };
    await preview(
      'git status',
      'allow: bash git status',
      '/configurationPresets/checks/permissions/1/action',
      'Earlier matching contributions:',
      '/permissions/0/action',
    );
    await preview('unmatched', 'No Composer rule matches', 'no native action is inferred');
    assert.equal(await readFile(f.paths.shared, 'utf8'), before);
    await terminal.choose('2. bash git status', 'Rule 2');
    await terminal.choose('Move earlier', '1. bash git status', '2. bash git *');
    await preview('git status', 'deny: bash git *');
    await terminal.choose('Add rule', '3. * * → ask');
    await terminal.choose('3. * *', 'Rule 3');
    await terminal.choose('Edit tool', 'Tool name or wildcard');
    await terminal.press('\x15' + 'read\r', 'Rule 3');
    await terminal.choose('Edit pattern', 'Pattern: blank means all inputs');
    await terminal.press('*.md\r', 'Rule 3');
    await terminal.choose('Action: ask', 'Permission action');
    await terminal.choose('deny', 'Rule 3');
    await terminal.press('\x1b', '3. read *.md → deny');
    await terminal.choose('Save ordered rules', 'Save configured permission rules?', 'Configured preview only');
    await terminal.press('\r', 'Settings saved', 'Reload now', 'Apply on next restart');
    assert.deepEqual((await f.document(f.paths.shared)).configurationPresets!.checks.permissions, [
      { tool: 'bash', pattern: 'git status', action: 'allow' },
      { tool: 'bash', pattern: 'git *', action: 'deny' },
      { tool: 'read', pattern: '*.md', action: 'deny' },
    ]);
    assert.equal(JSON.stringify(await f.host.api('/agent')), running);
    assert.equal(f.host.requests.length, 1);
    assert.match(await readFile(f.paths.shared, 'utf8'), /Preserve fixture comments/);
  },
);

test(
  'real terminal creates inactive model, reference and staged parameter presets without intermediate writes',
  { timeout: 240_000 },
  async (t) => {
    const f = await compositionFixture(t, 'preset-create-terminal');
    await f.write(f.paths.shared, {
      configurationPresets: { base: { model: 'fixture/alpha', variant: 'high' } },
      defaults: { small_model: 'fixture/beta' },
    });
    await f.host.start();
    const terminal = await nativeTerminal(f.host, undefined, 'preset-create-terminal');
    await terminal.wait(['ctrl+p', 'commands']);
    const create = async (name: string) => {
      await terminal.command('/compose-configs', 'Compose configs');
      await terminal.choose('Author groups, presets and profiles', 'Composition definitions');
      await terminal.choose('Configuration presets', 'Create definition');
      await terminal.choose('Create definition', 'New configuration presets name');
      await terminal.press(`${name}\r`, 'Save new definition in');
      await terminal.press('\r', 'New configuration preset');
    };
    await create('budget');
    const before = await readFile(f.paths.shared, 'utf8');
    await terminal.choose('Parameter-only preset', 'New preset: staged parameters');
    await terminal.choose('Review and create preset', 'at least one');
    await terminal.choose('maxOutputTokens', 'maxOutputTokens: blank removes this local value');
    await terminal.press('0\r', 'positive safe integers');
    await terminal.press('\x15' + '128\r', 'New preset: staged parameters');
    assert.equal(await readFile(f.paths.shared, 'utf8'), before);
    await terminal.choose('Review and create preset', 'Save composition definition?', 'checked at dispatch');
    await terminal.press('\x1b', 'New preset: staged parameters');
    assert.equal(await readFile(f.paths.shared, 'utf8'), before);
    await terminal.choose('maxOutputTokens', 'maxOutputTokens: blank removes this local value');
    await terminal.press('\x15' + '256\r', 'New preset: staged parameters');
    await terminal.choose('Review and create preset', 'Save composition definition?');
    await terminal.press('\r', 'Settings saved');
    await terminal.choose('Apply on next restart', 'ctrl+p', 'commands');
    assert.deepEqual((await f.document(f.paths.shared)).configurationPresets?.budget, {
      parameters: { maxOutputTokens: 256 },
    });
    for (const [name, reference] of [
      ['following', 'opencode:model'],
      ['small', 'opencode:small_model'],
      ['linked', 'preset:base'],
    ]) {
      await create(name);
      await terminal.choose('Exact model reference', 'New preset: model reference');
      await terminal.choose(reference, 'Save composition definition?');
      await terminal.press('\r', 'Settings saved');
      await terminal.choose('Apply on next restart', 'ctrl+p', 'commands');
      assert.deepEqual((await f.document(f.paths.shared)).configurationPresets?.[name], { modelRef: reference });
    }
    await create('concrete');
    await terminal.choose('Concrete model', 'New configuration preset');
    await terminal.choose('Fixture Beta', 'Fixture Beta: variant');
    await terminal.choose('Model default', 'Save composition definition?');
    await terminal.press('\r', 'Settings saved');
    await terminal.choose('Apply on next restart', 'ctrl+p', 'commands');
    assert.deepEqual((await f.document(f.paths.shared)).configurationPresets?.concrete, { model: 'fixture/beta' });
    await create('stale');
    await terminal.choose('Parameter-only preset', 'New preset: staged parameters');
    await terminal.choose('topP', 'topP: blank removes this local value');
    await terminal.press('0.8\r', 'New preset: staged parameters');
    await terminal.choose('Review and create preset', 'Save composition definition?');
    const concurrent = (await readFile(f.paths.shared, 'utf8')) + '\n// external edit';
    await writeFile(f.paths.shared, concurrent);
    await terminal.press('\r', 'changed');
    assert.equal(await readFile(f.paths.shared, 'utf8'), concurrent);
    assert.deepEqual((await f.document(f.paths.shared)).activeProfiles, undefined);
    assert.match(concurrent, /Preserve fixture comments/);
  },
);
