import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compositionFixture } from './composition-fixture.ts';
import { systemPrompt } from './content-editor.ts';
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
      await terminal.command('/compose', 'Compose');
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
    await terminal.command('/compose', 'Compose');
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
  'real terminal saves multiline prompt operations, renames aliases and edits repeated prompt references',
  { timeout: 240_000 },
  async (t) => {
    const f = await compositionFixture(t, 'prompt-terminal');
    await mkdir(join(f.host.configRoot, 'snippets'));
    await writeFile(join(f.host.configRoot, 'snippets/context.md'), 'TERMINAL_CONTEXT');
    await f.write(f.paths.shared, {
      sourceDirectories: { notes: './snippets' },
      components: {
        prompts: { context: { text: '{{include:@notes/context.md}}' } },
        agents: { consumer: { mode: 'primary', prompt: 'TERMINAL_BASE', promptRefs: ['context'] } },
      },
      componentGroups: { work: { agents: ['consumer'] } },
      profiles: { work: { layers: [{ componentGroup: 'work' }] } },
      activeProfiles: ['work'],
    });
    await f.host.start();
    const original = await f.send(undefined, 'consumer');
    const terminal = await nativeTerminal(f.host, original.session.id, 'prompt-terminal');
    await terminal.wait(['Acceptance conversation', 'verified', 'ctrl+p', 'commands']);
    await terminal.command('/compose', 'Compose');
    await terminal.choose('Prompt operations and inheritance', 'Prompt destination');
    await terminal.press('\r', 'Prompt target');
    await terminal.choose('Component definition: consumer', 'Component definition: consumer: prompt operations');
    await terminal.choose('Ordered append fragments', 'append fragments');
    await terminal.choose('Add multiline fragment or include', 'Prompt text: multiline');
    // Native bracketed paste inserts one multiline input; Enter submits the completed text.
    await terminal.press('\x1b[200~TERMINAL_FIRST\nTERMINAL_SECOND\x1b[201~', 'TERMINAL_FIRST', 'TERMINAL_SECOND');
    await terminal.press('\r', '1. TERMINAL_FIRST');
    await terminal.choose('Save ordered fragments', 'Save prompt operations?', 'TERMINAL_FIRST', 'TERMINAL_SECOND');
    await terminal.press('\r', 'Settings saved');
    assert.deepEqual((await f.document(f.paths.shared)).components!.agents!.consumer.configuration!.prompt!.append, [
      'TERMINAL_FIRST\nTERMINAL_SECOND',
    ]);
    await reloadFromTerminal(f, terminal);
    assert.ok(
      systemPrompt((await f.send(original.session.id, 'consumer')).captured).includes(
        'TERMINAL_FIRST\nTERMINAL_SECOND',
      ),
    );
    const assets = async () => {
      await terminal.command('/compose', 'Compose');
      await terminal.choose('Reusable prompts and include source aliases', 'Prompt components and source aliases');
    };
    await assets();
    await terminal.choose('Include source aliases', 'Include source aliases');
    await terminal.choose('notes', 'notes: declaring definition');
    await terminal.choose('Rename with reference review', 'New definition name');
    await terminal.press('\x15shared\r', 'Save prompt source definition?', 'Known reference consumers');
    await terminal.press('\r', 'Settings saved');
    await reloadFromTerminal(f, terminal);
    const renamed = await f.document(f.paths.shared);
    assert.equal(renamed.sourceDirectories!.shared, './snippets');
    assert.equal(renamed.sourceDirectories!.notes, undefined);
    assert.equal(renamed.components!.prompts!.context.text, '{{include:@shared/context.md}}');
    await assets();
    await terminal.choose('Ordered agent prompt references', 'Composer agent component');
    await terminal.choose('consumer', 'consumer: ordered prompt references');
    await terminal.choose('Append reusable prompt', 'Prompt component');
    await terminal.choose('context', '2. context');
    await terminal.choose('Save ordered references', 'Save prompt source definition?');
    await terminal.press('\r', 'Settings saved');
    await reloadFromTerminal(f, terminal);
    const repeated = systemPrompt((await f.send(original.session.id, 'consumer')).captured);
    assert.ok(repeated.includes('TERMINAL_BASE\n\nTERMINAL_CONTEXT\n\nTERMINAL_CONTEXT'));
    assert.equal(repeated.split('TERMINAL_FIRST').length - 1, 1, 'reload never duplicates saved operations');
    assert.ok((await f.history(original.session.id)).some((message) => message.info.id === original.message.info.id));
    assert.match(await readFile(f.paths.shared, 'utf8'), /Preserve fixture comments/);
  },
);
