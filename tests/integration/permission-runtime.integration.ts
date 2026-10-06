import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CompositionDocument, PermissionRule } from '../../src/config-composer/composition/types.ts';
import { compositionFixture } from './composition-fixture.ts';
import { nativeNotifications } from './notifications.ts';
import { bundledPermissions } from './bundled-permissions.ts';
import { type PermissionAgent, installSkill, nativeSkill, unsupportedRules } from './permission-fixture.ts';

const skill = (action: PermissionRule['action']): PermissionRule[] => [
  { tool: 'skill', pattern: 'included-skill', action },
];

test(
  'unsupported scopes preserve independent native policies and allow, deny and ask fallback until explicit repair reload',
  { timeout: 240_000 },
  async (t) => {
    const f = await compositionFixture(t, 'permission-scoped-fallback');
    await installSkill(f.host);
    const nativePath = join(f.host.configRoot, 'opencode.jsonc');
    const native = JSON.parse(await readFile(nativePath, 'utf8')) as Record<string, unknown>;
    native.permission = { skill: { 'included-skill': 'ask' } };
    native.agent = {
      worker: { mode: 'primary', prompt: 'NATIVE_WORKER' },
      build: { groups: ['base'] },
      'fallback-allow': { mode: 'primary', groups: ['broken'], permission: { skill: { 'included-skill': 'allow' } } },
      'fallback-ask': { mode: 'primary', groups: ['broken'], permission: { skill: { 'included-skill': 'ask' } } },
      'fallback-global': { mode: 'primary', groups: ['broken'] },
    };
    await writeFile(nativePath, `// Native fields retained\n${JSON.stringify(native, null, 2)}\n`);
    await mkdir(join(f.host.configRoot, 'agents'));
    const customPath = join(f.host.configRoot, 'agents/custom.md');
    const customBytes =
      '---\nmode: primary\ngroups: [base]\npermission:\n  skill:\n    included-skill: allow\n---\nNATIVE_CUSTOM_BODY\n';
    await writeFile(customPath, customBytes);
    const document: CompositionDocument = {
      defaults: { permissions: skill('deny') },
      configurationPresets: { permit: { permissions: skill('allow') } },
      componentGroups: {
        base: {
          configuration: {
            model: 'fixture/beta',
            permissions: skill('deny'),
            prompt: { append: ['INDEPENDENT_PROMPT'] },
          },
        },
        broken: { configuration: { model: 'fixture/beta', permissions: skill('deny') } },
      },
      profiles: {
        work: {
          layers: [
            { componentGroup: 'base' },
            { componentGroup: 'broken' },
            { configurationPreset: 'permit', target: { agents: ['build'] } },
          ],
          overrides: { agents: { custom: { permissions: skill('deny') } } },
        },
      },
      activeProfiles: ['work'],
    };
    await f.write(f.paths.shared, document);
    await f.host.start();
    const notifications = await nativeNotifications(f.host, 'scoped-fallback-notifications');
    const original = await f.send();
    const agents = () => f.host.api<PermissionAgent[]>('/agent');
    const before = await agents();
    const normalizeBundled = await bundledPermissions(f.host);
    const independent = Object.fromEntries(
      ['build', 'custom'].map((name) => [
        name,
        normalizeBundled(before.find((agent) => agent.name === name)!.permission),
      ]),
    );
    const initialProvenance = (await f.editor.snapshot()).resolved.provenance;
    assert.equal(
      initialProvenance['/agent/build/permission/skill/included-skill'].pointer,
      '/configurationPresets/permit/permissions/0/action',
    );
    assert.equal(
      initialProvenance['/agent/custom/permission/skill/included-skill'].pointer,
      '/profiles/work/overrides/agents/custom/permissions/0/action',
    );
    assert.equal(
      before.find((agent) => agent.name === 'build')!.prompt ?? undefined,
      undefined,
      'permission/model contributions preserve an unauthored built-in prompt',
    );
    assert.match(
      before.find((agent) => agent.name === 'custom')!.prompt!,
      /NATIVE_CUSTOM_BODY[\s\S]*INDEPENDENT_PROMPT/,
    );
    await nativeSkill(f.host, 'build', 'allow');
    await nativeSkill(f.host, 'custom', 'deny');
    await nativeSkill(f.host, 'fallback-allow', 'deny');
    assert.equal(notifications.toasts.length, 0);

    document.componentGroups!.broken.configuration!.permissions = unsupportedRules;
    await f.write(f.paths.shared, document);
    assert.deepEqual(await agents(), before, 'saving unsupported rules leaves the active native registry unchanged');
    await nativeSkill(f.host, 'fallback-allow', 'deny');
    await f.editor.reload();
    const warning = await notifications.wait((toast) => toast.message.startsWith('Agent fallback-allow:'));
    assert.equal(warning.variant, 'warning');
    assert.match(warning.message, /componentGroups\/broken\/configuration\/permissions/);
    assert.match(warning.message, /native agent permissions and the successfully applied global policy remain/);
    assert.match(warning.message, /more permissive, including missing intended deny rules/);
    const fallbackProvenance = (await f.editor.snapshot()).resolved.provenance;
    assert.equal(fallbackProvenance['/agent/fallback-allow/permission/skill/included-skill'].layer, 'native');
    assert.equal(
      fallbackProvenance['/agent/fallback-allow/permission/skill/included-skill'].pointer,
      '/agent/fallback-allow/permission/skill/included-skill',
    );
    for (const name of ['build', 'custom']) {
      const key = `/agent/${name}/permission/skill/included-skill`;
      assert.deepEqual(
        fallbackProvenance[key],
        initialProvenance[key],
        `${name}: independent compiled provenance remains intact`,
      );
    }
    for (const agent of await agents()) {
      if (Object.hasOwn(independent, agent.name)) {
        assert.deepEqual(
          normalizeBundled(agent.permission),
          independent[agent.name],
          `${agent.name}: preserve the complete independent ordered policy`,
        );
      }
    }
    await nativeSkill(f.host, 'build', 'allow');
    await nativeSkill(f.host, 'custom', 'deny');
    await nativeSkill(f.host, 'fallback-allow', 'allow');
    await nativeSkill(f.host, 'fallback-ask', 'ask');
    await nativeSkill(f.host, 'fallback-global', 'deny');
    assert.equal(
      (await f.send(undefined, 'fallback-allow')).captured.model,
      'beta',
      'unsupported permissions do not discard independent model settings',
    );

    document.defaults!.permissions = unsupportedRules;
    await f.write(f.paths.shared, document);
    const globalStart = notifications.toasts.length;
    await f.editor.reload();
    await notifications.wait(
      (toast) =>
        toast.message.startsWith('Global scope:') && toast.message.includes('native global permissions remain'),
      globalStart,
    );
    assert.deepEqual((await f.host.api<{ permission: unknown }>('/config')).permission, native.permission);
    assert.equal((await f.editor.snapshot()).resolved.provenance['/permission/skill/included-skill'].layer, 'native');
    await nativeSkill(f.host, 'build', 'allow');
    await nativeSkill(f.host, 'custom', 'deny');
    await nativeSkill(f.host, 'fallback-global', 'ask');
    await nativeSkill(f.host, 'fallback-allow', 'allow');

    document.defaults!.permissions = skill('deny');
    document.componentGroups!.broken.configuration!.permissions = skill('deny');
    await f.write(f.paths.shared, document);
    const recoveryStart = notifications.toasts.length;
    await f.editor.reload();
    assert.deepEqual((await f.editor.snapshot()).resolved.permissionWarnings, []);
    await nativeSkill(f.host, 'fallback-allow', 'deny');
    await nativeSkill(f.host, 'fallback-ask', 'deny');
    assert.equal(
      notifications.toasts.length,
      recoveryStart,
      'corrected public reload and new sessions do not replay stale warnings',
    );
    for (const agent of await agents()) {
      if (Object.hasOwn(independent, agent.name)) {
        assert.deepEqual(normalizeBundled(agent.permission), independent[agent.name]);
      }
    }
    assert.ok((await f.history(original.session.id)).some((message) => message.info.id === original.message.info.id));
    assert.equal(await readFile(customPath, 'utf8'), customBytes);
    const savedNative = await readFile(nativePath, 'utf8');
    assert.match(savedNative, /Native fields retained/);
    const { plugin: _plugin, ...remaining } = JSON.parse(savedNative.replace(/^\/\/[^\n]*\n/, '')) as Record<
      string,
      unknown
    >;
    const { plugin: _originalPlugin, ...expected } = native;
    assert.deepEqual(remaining, expected, 'reload changes only the native plugin token');
  },
);
