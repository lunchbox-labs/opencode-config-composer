import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compositionFixture } from './composition-fixture.ts';
import { nativeTerminal } from './terminal.ts';
import { reloadFromTerminal } from './terminal-editor.ts';
import { nativeNotifications } from './notifications.ts';
import { installSkill, nativeSkill, unsupportedRules } from './permission-fixture.ts';

test(
  'real terminal repairs invalid membership with a visible candidate fallback warning before saving and applying',
  { timeout: 240_000 },
  async (t) => {
    const f = await compositionFixture(t, 'repair-terminal');
    await installSkill(f.host);
    const nativePath = join(f.host.configRoot, 'opencode.jsonc');
    const native = JSON.parse(await readFile(nativePath, 'utf8')) as { agent: Record<string, unknown> };
    native.agent.worker = {
      mode: 'primary',
      prompt: 'NATIVE_WORKER',
      permission: { skill: { 'included-skill': 'allow' } },
    };
    await writeFile(nativePath, JSON.stringify(native));
    await f.write(f.paths.shared, {
      componentGroups: {
        work: {
          agents: ['worker', 'missing-agent'],
          configuration: { model: 'fixture/beta', permissions: unsupportedRules },
        },
      },
      profiles: { work: { layers: [{ componentGroup: 'work' }] } },
      activeProfiles: ['work'],
    });
    const invalid = await readFile(f.paths.shared, 'utf8');
    await f.host.start();
    const original = await f.send();
    assert.equal(original.captured.model, 'alpha', 'invalid membership applies no partial model overlay');
    const terminal = await nativeTerminal(f.host, original.session.id, 'repair-terminal');
    await terminal.wait(['Acceptance conversation', 'verified', 'ctrl+p', 'commands']);
    await terminal.command('/compose', 'Compose');
    await terminal.choose('Repair invalid memberships', 'Inspect saved membership error');
    await terminal.choose(
      'Inspect saved membership error',
      'Saved composition is invalid',
      'missing-agent',
      'Effective saved configuration is unavailable',
    );
    assert.equal(await readFile(f.paths.shared, 'utf8'), invalid);
    await terminal.press('\x1b', 'Repair invalid memberships');
    await terminal.choose('work', 'Repair group: work');
    await terminal.choose('Edit agents', 'Repair work: agents', 'missing-agent');
    await terminal.choose('missing-agent', 'Repair work: agents', 'missing-agent');
    assert.ok(
      !terminal
        .text()
        .split('\n')
        .find((line) => line.includes('missing-agent'))!
        .includes('✓'),
    );
    await terminal.choose('Keep membership changes in draft', 'Repair group: work');
    await terminal.press('\x1b', 'Repair invalid memberships');
    await terminal.choose(
      'Review complete repair',
      'Save membership repair?',
      'Validated candidate profiles: work',
      'Agent worker:',
      'Fallback may be more',
      'permissive, including missing intended deny rules.',
      'Confirm',
      'Cancel',
    );
    assert.equal(await readFile(f.paths.shared, 'utf8'), invalid, 'candidate warning and preview precede every write');
    await terminal.press('\x1b', 'Repair invalid memberships');
    assert.equal(
      await readFile(f.paths.shared, 'utf8'),
      invalid,
      'cancelled repair keeps the invalid source unchanged',
    );
    await terminal.choose(
      'Review complete repair',
      'Save membership repair?',
      'Agent worker:',
      'Fallback may be more',
      'permissive, including missing intended deny rules.',
      'Confirm',
      'Cancel',
    );
    await terminal.press('\r', 'Settings saved');
    assert.deepEqual((await f.document(f.paths.shared)).componentGroups!.work.agents, ['worker']);
    assert.match(await readFile(f.paths.shared, 'utf8'), /Preserve fixture comments/);
    assert.equal((await f.send(original.session.id)).captured.model, 'alpha', 'saving a repair does not apply it');
    await reloadFromTerminal(f, terminal);
    assert.equal((await f.send(original.session.id)).captured.model, 'beta');
    await nativeSkill(f.host, 'worker', 'allow');
    assert.ok((await f.history(original.session.id)).some((message) => message.info.id === original.message.info.id));
  },
);

test(
  'real terminal applies edited permissions, warns before unsupported saves and restores corrected native decisions',
  { timeout: 240_000 },
  async (t) => {
    const f = await compositionFixture(t, 'permission-apply-terminal');
    await installSkill(f.host);
    const nativePath = join(f.host.configRoot, 'opencode.jsonc');
    const native = JSON.parse(await readFile(nativePath, 'utf8')) as { agent: Record<string, unknown> };
    native.agent.worker = {
      mode: 'primary',
      prompt: 'NATIVE_WORKER',
      permission: { skill: { 'included-skill': 'allow' } },
    };
    await writeFile(nativePath, JSON.stringify(native));
    await f.write(f.paths.shared, {
      configurationPresets: { policy: { permissions: [{ tool: 'skill', pattern: 'included-skill', action: 'deny' }] } },
      componentGroups: { work: { agents: ['worker'] } },
      profiles: {
        work: {
          layers: [{ componentGroup: 'work' }, { configurationPreset: 'policy', target: { agents: ['worker'] } }],
        },
      },
      activeProfiles: ['work'],
    });
    await f.host.start();
    const notifications = await nativeNotifications(f.host, 'permission-terminal-notifications');
    const original = await f.send();
    await nativeSkill(f.host, 'worker', 'deny');
    const terminal = await nativeTerminal(f.host, original.session.id, 'permission-apply-terminal');
    await terminal.wait(['Acceptance conversation', 'verified', 'ctrl+p', 'commands']);
    const edit = async () => {
      await terminal.command('/compose', 'Compose');
      await terminal.choose('Ordered permission rules and configured previews', 'Permission destination');
      await terminal.press('\r', 'Permission target');
      await terminal.choose('Preset: policy', 'Preset: policy: ordered permissions');
    };
    await edit();
    await terminal.choose('1. skill included-skill', 'Rule 1');
    await terminal.choose('Action: deny', 'Permission action');
    await terminal.choose('allow', 'Rule 1');
    await terminal.press('\x1b', '1. skill included-skill → allow');
    await terminal.choose('Save ordered rules', 'Save configured permission rules?', 'Reload applies supported rules');
    await terminal.press('\r', 'Settings saved', 'Reload now');
    await nativeSkill(f.host, 'worker', 'deny');
    await reloadFromTerminal(f, terminal);
    await nativeSkill(f.host, 'worker', 'allow');

    const broken = await f.document(f.paths.shared);
    broken.configurationPresets!.policy.permissions = unsupportedRules;
    await f.write(f.paths.shared, broken);
    const pending = await readFile(f.paths.shared, 'utf8');
    await edit();
    await terminal.choose('4. skill included-skill', 'Rule 4');
    await terminal.choose('Action: deny', 'Permission action');
    await terminal.choose('ask', 'Rule 4');
    await terminal.press('\x1b', '4. skill included-skill → ask');
    await terminal.choose('Save ordered rules', 'Save configured permission rules?', 'Agent worker:');
    await terminal.wait([
      'Fallback may be more',
      'permissive, including missing intended deny rules.',
      'Confirm',
      'Cancel',
    ]);
    assert.equal(await readFile(f.paths.shared, 'utf8'), pending, 'the fallback warning is visible before saving');
    await terminal.press('\x1b', 'Preset: policy: ordered permissions');
    assert.equal(await readFile(f.paths.shared, 'utf8'), pending);
    await terminal.choose(
      'Save ordered rules',
      'Save configured permission rules?',
      'Fallback may be more',
      'permissive, including missing intended deny rules.',
      'Confirm',
      'Cancel',
    );
    await terminal.press('\r', 'Settings saved');
    const warningStart = notifications.toasts.length;
    await reloadFromTerminal(f, terminal);
    await notifications.wait((toast) => toast.message.startsWith('Agent worker:'), warningStart);
    await terminal.wait(['Config Composer permissions', 'Agent worker:']);
    await nativeSkill(f.host, 'worker', 'allow');

    await edit();
    for (const [tool, next] of [
      ['webfetc?', 'webfetch'],
      ['webfetch', 'webfetc?'],
      ['webfetc?', 'skill'],
    ] as const) {
      await terminal.choose(`1. ${tool}`, 'Rule 1');
      await terminal.choose('Remove rule', `1. ${next}`);
    }
    await terminal.choose('1. skill included-skill', 'Rule 1');
    await terminal.choose('Action: ask', 'Permission action');
    await terminal.choose('deny', 'Rule 1');
    await terminal.press('\x1b', '1. skill included-skill → deny');
    await terminal.choose('Save ordered rules', 'Save configured permission rules?');
    await terminal.press('\r', 'Settings saved');
    await reloadFromTerminal(f, terminal);
    assert.deepEqual((await f.editor.snapshot()).resolved.permissionWarnings, []);
    await notifications.flush();
    const recovered = notifications.toasts.length;
    await nativeSkill(f.host, 'worker', 'deny');
    await notifications.flush();
    assert.equal(
      notifications.toasts.length,
      recovered,
      'corrected sessions do not replay unsupported-policy warnings',
    );
    assert.ok((await f.history(original.session.id)).some((message) => message.info.id === original.message.info.id));
  },
);
