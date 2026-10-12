import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { reloadFromTerminal } from './terminal-editor.ts';
import { compositionFixture } from './composition-fixture.ts';
import { nativeTerminal } from './terminal.ts';

test(
  'real terminal authors first sources, groups, presets and profiles, then saves and reloads a retained conversation',
  { timeout: 240_000 },
  async (t) => {
    const fixture = await compositionFixture(t, 'compose-terminal');
    await fixture.host.start();
    const original = await fixture.send();
    const terminal = await nativeTerminal(fixture.host, original.session.id);
    await terminal.wait(['Acceptance conversation', 'verified', 'ctrl+p', 'commands']);
    await terminal.command('/compose-configs', 'Compose configs', 'Effective configuration and sources');
    await terminal.choose('Effective configuration and sources', 'Saved composition preview');
    await terminal.choose('Profiles and layer order', 'Active profiles: none', 'Existing conversations are retained');
    await terminal.press('\x1b', 'Saved composition preview');
    await terminal.press('\x1b', 'Compose configs', 'Profile activation and scope files');
    await terminal.choose('Profile activation and scope files', 'Project profile selection');
    await terminal.choose('Create shared composition source', 'Save profile selection?');
    await terminal.press('\x1b', 'Project profile selection');
    assert.equal(await stat(fixture.paths.shared).catch(() => undefined), undefined, 'cancel does not create a source');
    await terminal.choose('Create shared composition source', 'Save profile selection?');
    await terminal.press('\r', 'Settings saved');
    assert.deepEqual(await fixture.document(fixture.paths.shared), {});
    await terminal.choose('Apply on next restart', 'ctrl+p', 'commands');
    await terminal.command('/compose-configs', 'Compose configs');
    await terminal.choose('Author groups, presets and profiles', 'Composition definitions');
    await terminal.choose('Component groups', 'Create definition');
    await terminal.choose('Create definition', 'New component groups name');
    await terminal.press('team\r', 'Save new definition in');
    await terminal.press('\r', 'Save composition definition?');
    await terminal.press('\r', 'Settings saved');
    assert.deepEqual((await fixture.document(fixture.paths.shared)).componentGroups?.team, {});
    await terminal.choose('Apply on next restart', 'ctrl+p', 'commands');
    const registry = async (kind: string) => {
      await terminal.command('/compose-configs', 'Compose configs');
      await terminal.choose('Author groups, presets and profiles', 'Composition definitions');
      await terminal.choose(kind, 'Create definition');
    };
    const saved = async () => {
      await terminal.press('\r', 'Settings saved');
      await terminal.choose('Apply on next restart', 'ctrl+p', 'commands');
    };
    const create = async (kind: string, name: string) => {
      await registry(kind);
      await terminal.choose('Create definition', `New ${kind.toLowerCase()} name`);
      await terminal.press(`${name}\r`, 'Save new definition in');
      await terminal.press(
        '\r',
        kind === 'Configuration presets' ? 'New configuration preset' : 'Save composition definition?',
      );
      if (kind === 'Configuration presets') {
        await terminal.choose('Fixture Beta', 'Fixture Beta: variant');
        await terminal.choose('Model default', 'Save composition definition?');
      }
      await saved();
    };
    await create('Configuration presets', 'balanced');
    await create('Profiles', 'work');
    await registry('Component groups');
    await terminal.choose('team', 'Component groups: team');
    await terminal.choose('Edit agents', 'team: agents');
    await terminal.choose('worker', '✓ worker');
    await terminal.choose('Save members', 'Save composition definition?');
    await saved();
    await registry('Profiles');
    await terminal.choose('work', 'Profiles: work');
    await terminal.choose('Ordered layers', 'work: ordered layers');
    await terminal.choose('Add component group layer', 'Choose component group');
    await terminal.choose('team', '1. team');
    await terminal.choose('Add configuration preset layer', 'Choose configuration preset');
    await terminal.choose('balanced', 'Choose preset target');
    await terminal.choose('worker', '2. balanced');
    await terminal.choose('Save layers', 'Save composition definition?');
    await saved();
    const authored = await fixture.document(fixture.paths.shared);
    assert.deepEqual(authored.componentGroups?.team.agents, ['worker']);
    assert.equal(authored.configurationPresets?.balanced.model, 'fixture/beta');
    assert.deepEqual(authored.profiles?.work.layers, [
      { componentGroup: 'team' },
      { configurationPreset: 'balanced', target: { agents: ['worker'] } },
    ]);
    assert.equal(authored.activeProfiles, undefined, 'authoring never activates a definition');
    assert.equal(fixture.host.requests.length, 1, 'inspection and editing never send model requests');
    await terminal.command('/compose-configs', 'Compose configs');
    await terminal.choose('Profile activation and scope files', 'Project profile selection');
    await terminal.choose('Edit ordered selection', 'project: ordered active profiles');
    await terminal.choose('Add profile occurrence', 'Choose profile');
    await terminal.choose('work', '1. work');
    await terminal.choose('Save selection', 'Save profile selection?');
    await terminal.press('\r', 'Settings saved');
    assert.deepEqual((await fixture.editor.snapshot()).sources.activeProfiles, ['work']);
    assert.equal(
      (await fixture.send(original.session.id)).captured.model,
      'alpha',
      'save leaves active host settings unchanged',
    );
    await reloadFromTerminal(fixture, terminal);
    assert.equal(
      (await fixture.send(original.session.id)).captured.model,
      'beta',
      'terminal reload applies the saved profile',
    );
    assert.equal(await stat(fixture.paths.project).catch(() => undefined), undefined);
    assert.equal(await stat(fixture.paths.local).catch(() => undefined), undefined);

    assert.ok(
      (await fixture.history(original.session.id)).some((message) => message.info.id === original.message.info.id),
    );
  },
);

test(
  'real terminal inspects provenance and edits ordered, empty and inherited profile selections',
  { timeout: 240_000 },
  async (t) => {
    const f = await compositionFixture(t, 'compose-terminal-selection');
    await f.write(f.paths.shared, {
      componentGroups: {
        focused: { agents: ['worker'], configuration: { model: 'fixture/alpha' } },
        working: { agents: ['worker'], configuration: { model: 'fixture/beta' } },
      },
      profiles: {
        focus: { layers: [{ componentGroup: 'focused' }] },
        work: { layers: [{ componentGroup: 'working' }] },
      },
      activeProfiles: ['focus', 'work'],
    });
    const nativeSource = join(f.host.project, 'opencode.jsonc');
    await writeFile(
      nativeSource,
      '{"$schema":"https://opencode.ai/config.json","agent":{"project-reader":{"prompt":"READ_ONLY_NATIVE"}}}\n',
    );
    await f.host.start();
    const original = await f.send();
    const before = await readFile(f.paths.shared, 'utf8');
    const terminal = await nativeTerminal(f.host, original.session.id, 'compose-terminal-selection');
    await terminal.wait(['Acceptance conversation', 'verified', 'ctrl+p', 'commands']);
    await terminal.command('/compose-configs', 'Compose configs');
    await terminal.choose('Effective configuration and sources', 'Saved composition preview');
    await terminal.choose(
      'Profiles and layer order',
      'Active profiles: focus → work',
      'Replayed profile order: focus → work',
    );
    await terminal.press('\x1b', 'Saved composition preview');
    await terminal.choose(
      '/agent/worker/model',
      'Saved preview: fixture/beta',
      'Overwritten:',
      '/componentGroups/working/configuration/model',
      '/componentGroups/focused/configuration/model',
    );
    await terminal.press('\x1b', 'Saved composition preview');
    await terminal.choose(
      'Source files and editability',
      'Writable in this editor',
      'Read-only in this editor',
      'running configuration may differ until reload',
    );
    assert.equal(await readFile(f.paths.shared, 'utf8'), before);
    assert.equal(
      await readFile(nativeSource, 'utf8'),
      '{"$schema":"https://opencode.ai/config.json","agent":{"project-reader":{"prompt":"READ_ONLY_NATIVE"}}}\n',
    );
    assert.equal(f.host.requests.length, 1, 'inspection sends no model request');
    await terminal.press('\x1b', 'Saved composition preview');
    await terminal.press('\x1b', 'Compose configs');
    await terminal.press('\x1b', 'ctrl+p', 'commands');
    const selection = async () => {
      await terminal.command('/compose-configs', 'Compose configs');
      await terminal.choose('Profile activation and scope files', 'Project profile selection');
    };
    const apply = async () => {
      await terminal.press('\r', 'Settings saved');
      await reloadFromTerminal(f, terminal);
    };
    await selection();
    await terminal.choose('Edit ordered selection', 'project: ordered active profiles');
    await terminal.choose('2. work', 'Profile occurrence 2');
    await terminal.choose('Move earlier', '1. work', '2. focus');
    await terminal.choose('Save selection', 'Save profile selection?');
    await apply();
    assert.deepEqual((await f.editor.snapshot()).sources.activeProfiles, ['work', 'focus']);
    assert.equal((await f.send(original.session.id)).captured.model, 'alpha');
    await selection();
    await terminal.choose('Select no profiles', 'Save profile selection?');
    await apply();
    assert.equal(await stat(f.paths.local).catch(() => undefined), undefined);
    assert.deepEqual((await f.editor.snapshot()).sources.activeProfiles, []);
    assert.equal((await f.send()).captured.model, 'alpha');
    await selection();
    await terminal.choose('Use configured defaults', 'Save profile selection?');
    await apply();
    assert.equal(await stat(f.paths.local).catch(() => undefined), undefined);
    assert.deepEqual((await f.editor.snapshot()).sources.activeProfiles, ['focus', 'work']);
    await selection();
    await terminal.choose('Edit ordered selection', 'project: ordered active profiles');
    await terminal.choose('1. focus', 'Profile occurrence 1');
    await terminal.choose('Remove occurrence', '1. work');
    await terminal.choose('Save selection', 'Save profile selection?');
    await apply();
    assert.deepEqual((await f.editor.snapshot()).sources.activeProfiles, ['work']);
    assert.equal(await readFile(f.paths.shared, 'utf8'), before);
    assert.equal((await f.send(original.session.id)).captured.model, 'beta');
    assert.ok((await f.history(original.session.id)).some((message) => message.info.id === original.message.info.id));
    assert.equal(
      await readFile(nativeSource, 'utf8'),
      '{"$schema":"https://opencode.ai/config.json","agent":{"project-reader":{"prompt":"READ_ONLY_NATIVE"}}}\n',
    );
  },
);

test(
  'real terminal retains the last editor error across cancellation, repeated inspection and corrected sources',
  { timeout: 120_000 },
  async (t) => {
    const fixture = await compositionFixture(t, 'last-editor-error');
    await fixture.write(fixture.paths.shared, { componentGroups: { team: {} } });
    const before = await readFile(fixture.paths.shared, 'utf8');
    await fixture.host.start();
    const session = await fixture.host.api<{ id: string }>('/session', { title: 'Error inspection' });
    const terminal = await nativeTerminal(fixture.host, session.id, 'last-editor-error');
    await terminal.wait(['ctrl+p', 'commands']);
    await terminal.command('/compose-configs', 'Compose configs');
    await terminal.choose('Last editor error', 'No editor error in this project and instance.');
    await terminal.press('\x1b', 'Compose configs');
    await writeFile(fixture.paths.shared, '{ invalid');
    await terminal.choose('Effective configuration and sources', 'JSON');
    await terminal.choose('Last editor error', 'Last editor error', 'Project:', 'Configuration:', 'JSON');
    await terminal.press('\x1b', 'Compose configs');
    await writeFile(fixture.paths.shared, before);
    for (let index = 0; index < 2; index++) {
      await terminal.choose('Last editor error', 'Last editor error', 'Project:', 'JSON');
      await terminal.press('\x1b', 'Compose configs');
    }
    await terminal.choose('Effective configuration and sources', 'Saved composition preview');
    await terminal.press('\x1b', 'Compose configs');
    await terminal.choose('Last editor error', 'Last editor error', 'Project:', 'JSON');
    await terminal.press('\x1b', 'Compose configs');
    await terminal.press('\x1b', 'ctrl+p', 'commands');
    await writeFile(
      fixture.paths.shared,
      JSON.stringify({ imports: ['./' + 'long-segment/'.repeat(80) + 'END.jsonc'] }),
    );
    await terminal.command('/compose-configs', 'Compose configs');
    await terminal.choose('Effective configuration and sources', 'Could not read import');
    await terminal.choose('Last editor error', 'Details 1 of');
    const count = /Details 1 of (\d+)/.exec(terminal.text())?.[1];
    assert.ok(count !== undefined && Number(count) > 1);
    await terminal.choose(`Details ${count} of ${count}`, 'Last editor error', 'END.jsonc');
    await terminal.press('\x1b', 'Details 1 of');
    await terminal.press('\x1b', 'Compose configs');
    await terminal.press('\x1b', 'ctrl+p', 'commands');
    await writeFile(fixture.paths.shared, before);
    await terminal.command('/agent-groups', 'Agent groups');
    await terminal.choose('All agents', 'Agents');
    await terminal.choose('worker', 'Manage groups');
    await terminal.choose('Manage groups', 'worker: groups');
    await terminal.choose('Add group', 'Choose a group');
    await terminal.choose('team', 'worker: groups', '1. team');
    const nativePath = join(fixture.host.configRoot, 'opencode.jsonc');
    const changed = (await readFile(nativePath, 'utf8')) + '\n// external change\n';
    await writeFile(nativePath, changed);
    await terminal.choose('Save groups', 'Save agent settings?');
    await terminal.press('\r', 'worker: groups', 'Last editor error');
    for (let index = 0; index < 2; index++) {
      await terminal.choose('Last editor error', 'Last editor error', 'Project:', 'changed');
      await terminal.press('\x1b', 'worker: groups');
    }
    await terminal.press('\x15', '1. team');
    await terminal.press('\x1b', 'Manage groups');
    assert.equal(await readFile(nativePath, 'utf8'), changed);
    assert.equal(await readFile(fixture.paths.shared, 'utf8'), before);
    assert.equal(fixture.host.requests.length, 0);
  },
);
