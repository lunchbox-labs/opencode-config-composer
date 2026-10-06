import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { compositionFixture } from './composition-fixture.ts';
import { nativeTerminal } from './terminal.ts';

async function reloadFromTerminal(
  fixture: Awaited<ReturnType<typeof compositionFixture>>,
  terminal: Awaited<ReturnType<typeof nativeTerminal>>,
) {
  await fixture.host.prepareConfigurationDependencies();
  const previous = JSON.stringify((await fixture.host.api<{ plugin: unknown[] }>('/config')).plugin);
  await terminal.choose('Reload now', 'Reload OpenCode settings?');
  await terminal.press('\r', 'Settings reloaded');
  // A previous toast can remain visible during another reload. Observe this
  // reload's new native registration before sending any request or more keys.
  for (let attempt = 0; attempt < 200; attempt++) {
    const current = JSON.stringify((await fixture.host.api<{ plugin: unknown[] }>('/config')).plugin);
    if (current !== previous) {
      await fixture.host.api('/agent');
      return;
    }
    await setTimeout(50);
  }
  assert.fail('The terminal reload did not publish a new native registration');
}

test(
  'real terminal authors first sources, groups, presets and profiles, then saves and reloads a retained conversation',
  { timeout: 240_000 },
  async (t) => {
    const fixture = await compositionFixture(t, 'compose-terminal');
    await fixture.host.start();
    const original = await fixture.send();
    const terminal = await nativeTerminal(fixture.host, original.session.id);
    await terminal.wait(['Acceptance conversation', 'verified', 'ctrl+p', 'commands']);
    await terminal.command('/compose', 'Compose', 'Effective configuration and sources');
    await terminal.choose('Effective configuration and sources', 'Saved composition preview');
    await terminal.choose('Profiles and layer order', 'Active profiles: none', 'Existing conversations are retained');
    await terminal.press('\x1b', 'Saved composition preview');
    await terminal.press('\x1b', 'Compose', 'Profile activation and scope files');
    await terminal.choose('Profile activation and scope files', 'shared', 'project', 'local');
    await terminal.choose('shared', 'shared profile selection');
    await terminal.choose('Create empty composition source', 'Save profile selection?');
    await terminal.press('\x1b', 'shared profile selection');
    assert.equal(await stat(fixture.paths.shared).catch(() => undefined), undefined, 'cancel does not create a source');
    await terminal.choose('Create empty composition source', 'Save profile selection?');
    await terminal.press('\r', 'Settings saved');
    assert.deepEqual(await fixture.document(fixture.paths.shared), {});
    await terminal.choose('Apply on next restart', 'ctrl+p', 'commands');
    await terminal.command('/compose', 'Compose');
    await terminal.choose('Author groups, presets and profiles', 'Composition definitions');
    await terminal.choose('Component groups', 'Create definition');
    await terminal.choose('Create definition', 'New component groups name');
    await terminal.press('team\r', 'Save new definition in');
    await terminal.press('\r', 'Save composition definition?');
    await terminal.press('\r', 'Settings saved');
    assert.deepEqual((await fixture.document(fixture.paths.shared)).componentGroups?.team, {});
    await terminal.choose('Apply on next restart', 'ctrl+p', 'commands');
    const registry = async (kind: string) => {
      await terminal.command('/compose', 'Compose');
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
    await terminal.command('/compose', 'Compose');
    await terminal.choose('Profile activation and scope files', 'shared', 'project', 'local');
    await terminal.choose('shared', 'shared profile selection');
    await terminal.choose('Edit ordered selection', 'shared: ordered active profiles');
    await terminal.choose('Add profile occurrence', 'Choose profile');
    await terminal.choose('work', '1. work');
    await terminal.choose('Save selection', 'Save profile selection?');
    await terminal.press('\r', 'Settings saved');
    assert.deepEqual((await fixture.document(fixture.paths.shared)).activeProfiles, ['work']);
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
    await terminal.command('/compose', 'Compose');
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
    await terminal.press('\x1b', 'Compose');
    await terminal.press('\x1b', 'ctrl+p', 'commands');
    const scope = async (name: string) => {
      await terminal.command('/compose', 'Compose');
      await terminal.choose('Profile activation and scope files', 'shared', 'project', 'local');
      await terminal.choose(name, `${name} profile selection`);
    };
    const apply = async () => {
      await terminal.press('\r', 'Settings saved');
      await reloadFromTerminal(f, terminal);
    };
    await scope('shared');
    await terminal.choose('Edit ordered selection', 'shared: ordered active profiles');
    await terminal.choose('2. work', 'Profile occurrence 2');
    await terminal.choose('Move earlier', '1. work', '2. focus');
    await terminal.choose('Save selection', 'Save profile selection?');
    await apply();
    assert.deepEqual((await f.document(f.paths.shared)).activeProfiles, ['work', 'focus']);
    assert.equal((await f.send(original.session.id)).captured.model, 'alpha');
    await scope('local');
    await terminal.choose('Select no profiles', 'Save profile selection?');
    await apply();
    assert.deepEqual((await f.document(f.paths.local)).activeProfiles, []);
    assert.deepEqual((await f.editor.snapshot()).sources.activeProfiles, []);
    assert.equal((await f.send()).captured.model, 'alpha');
    await scope('local');
    await terminal.choose('Inherit earlier selection', 'Save profile selection?');
    await apply();
    assert.equal(Object.hasOwn(await f.document(f.paths.local), 'activeProfiles'), false);
    assert.deepEqual((await f.editor.snapshot()).sources.activeProfiles, ['work', 'focus']);
    await scope('shared');
    await terminal.choose('Edit ordered selection', 'shared: ordered active profiles');
    await terminal.choose('2. focus', 'Profile occurrence 2');
    await terminal.choose('Remove occurrence', '1. work');
    await terminal.choose('Save selection', 'Save profile selection?');
    await apply();
    assert.deepEqual((await f.document(f.paths.shared)).activeProfiles, ['work']);
    assert.equal((await f.send(original.session.id)).captured.model, 'beta');
    assert.ok((await f.history(original.session.id)).some((message) => message.info.id === original.message.info.id));
    assert.equal(
      await readFile(nativeSource, 'utf8'),
      '{"$schema":"https://opencode.ai/config.json","agent":{"project-reader":{"prompt":"READ_ONLY_NATIVE"}}}\n',
    );
  },
);
