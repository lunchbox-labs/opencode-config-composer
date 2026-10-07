import type * as Permissions from '../src/config-composer/composition/permissions.ts';
import type { PermissionPolicy } from '../src/config-composer/composition/permissions.ts';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { nativeHarness } from './integration/harness.ts';
import { installedEditor } from './integration/editor.ts';
import { nativeNotifications } from './integration/notifications.ts';
import type {
  AgentConfiguration,
  CompositionDocument,
  PermissionRule,
} from '../src/config-composer/composition/types.ts';

// Real V1 configuration loading, provider dispatch, and cache invalidation; only the remote model is synthetic.
test(
  'OpenCode enforces canonical ordered permissions with visible scope-specific fallback warnings',
  { timeout: 240_000 },
  async (t) => {
    const host = await nativeHarness(t, 'canonical-permissions');
    const { configRoot, project, installed, api } = host;
    await mkdir(join(configRoot, 'agents'), { recursive: true });
    await mkdir(join(configRoot, 'shared-prompts'));
    await mkdir(join(configRoot, 'skills/included-skill'), { recursive: true });
    const { composePermissions, explainPermission } = (await import(
      pathToFileURL(join(installed.directory, 'dist/config-composer/composition/permissions.js')).href
    )) as typeof Permissions;
    const permissionProbe = join(configRoot, 'permission-probe.mjs');
    await writeFile(
      permissionProbe,
      `export default { id: 'permission-probe', server: async () => ({ tool: Object.fromEntries([
      ['allow', 'read', 'notes.txt'], ['ask', 'external_directory', '__composer_permission_probe_outside__'],
    ].map(([name, permission, pattern]) => ['permission_default_' + name, {
      description: 'Probe an unchanged native permission default.', args: {},
      execute: async (_args, context) => { await context.ask({ permission, patterns: [pattern], always: [pattern], metadata: {} }); return 'verified'; },
    }])) }) };`,
    );

    const model = {
      name: 'Synthetic model',
      limit: { context: 8192, output: 256 },
      variants: { low: { reasoningEffort: 'low' }, high: { reasoningEffort: 'high' } },
    };
    const unsupportedLayers: PermissionPolicy[] = [
      { 'webfetc?': { a: 'deny' } },
      { webfetch: 'allow' },
      { 'webfetc?': { b: 'deny' }, skill: 'deny' },
    ];
    const permissionCases: {
      name: string;
      layers: PermissionPolicy[];
      action: 'allow' | 'ask' | 'deny';
      probe?: 'allow' | 'ask';
      unsupported?: boolean;
    }[] = [
      {
        name: 'later-allow',
        layers: [{ skill: { 'included-*': 'deny' } }, { skill: { '*': 'allow' } }],
        action: 'allow',
      },
      {
        name: 'later-deny',
        layers: [{ skill: { '*': 'allow' } }, { skill: { 'included-*': 'deny' } }],
        action: 'deny',
      },
      { name: 'outer-allow', layers: [{ skill: 'deny' }, { '*': 'allow' }], action: 'allow' },
      {
        name: 'retained-allow',
        layers: [{ skill: { 'included-*': 'deny' }, '*': 'allow' }, { skill: { 'other-*': 'allow' } }],
        action: 'allow',
      },
      {
        name: 'reinsert-allow',
        layers: [{ skill: { 'included-*': 'deny', '*': 'deny' } }, { skill: { 'included-*': 'allow' } }],
        action: 'allow',
      },
      { name: 'earlier-scalar', layers: [{ skill: 'allow' }, { skill: { 'other-*': 'allow' } }], action: 'allow' },
      { name: 'global-fallback', layers: [{ skill: { 'other-*': 'allow' } }], action: 'deny' },
      { name: 'approval', layers: [{ skill: 'ask' }], action: 'ask' },
      {
        name: 'interleaved-wildcard',
        layers: [{ 's*': { 'included-*': 'deny' } }, { '*': 'allow' }, { 's*': { 'other-*': 'deny' } }],
        action: 'allow',
      },
      {
        name: 'question-domain-scalar',
        layers: [{ 'skil?': { 'included-*': 'deny' } }, { '*': 'allow' }, { 'skil?': { 'other-*': 'deny' } }],
        action: 'allow',
      },
      {
        name: 'question-domain-map',
        layers: [
          { 'skil?': { 'included-*': 'deny' } },
          { 's*': { 'included-*': 'allow' } },
          { 'skil?': { 'other-*': 'deny' } },
        ],
        action: 'allow',
      },
      {
        name: 'question-domain-later',
        layers: [{ 'skil?': { 'included-*': 'deny' } }, { '*': 'allow' }, { 'skil?': { 'included-*': 'ask' } }],
        action: 'ask',
      },
      ...(['deny', 'allow'] as const).map((action) => ({
        name: `unsupported-${action}`,
        layers: unsupportedLayers,
        action,
        unsupported: true,
      })),
      { name: 'native-fallback', layers: [{ skill: { 'other-*': 'allow' } }], action: 'allow' },
      { name: 'group-over-native', layers: [{ skill: 'allow' }], action: 'allow' },
      { name: 'native-default-allow', layers: [], action: 'allow', probe: 'allow' },
      { name: 'native-default-ask', layers: [], action: 'ask', probe: 'ask' },
      { name: 'replace-allow', layers: [{ skill: 'deny' }, { skill: { 'included-*': 'allow' } }], action: 'allow' },
    ];
    const config = {
      plugin: [installed.directory, permissionProbe],
      permission: { 'sk*': { 'included-*': 'deny' } } satisfies PermissionPolicy,
      model: 'fixture/alpha',
      small_model: 'fixture/alpha',
      default_agent: 'worker',
      enabled_providers: ['fixture'],
      provider: {
        fixture: {
          name: 'Fixture',
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: host.providerURL, apiKey: 'synthetic-test-key' },
          models: { alpha: model, beta: model },
        },
      },
      agent: {
        ...Object.fromEntries(
          permissionCases.map(({ name, layers }) => [
            name,
            {
              mode: 'primary',
              groups: layers.map((_, index) => `${name}-${index}`),
              ...(name === 'native-fallback' || name === 'unsupported-allow'
                ? { permission: { skill: 'allow' } }
                : name === 'group-over-native'
                  ? { permission: { skill: 'deny' } }
                  : {}),
            },
          ]),
        ),
        pinned: { mode: 'subagent', groups: ['base', 'developers'], model: 'fixture/alpha', variant: 'high' },
        'main-follower': { mode: 'primary', groups: ['primary'], prompt: 'Reply briefly.' },
        'small-follower': { mode: 'primary', groups: ['small'], prompt: 'Reply briefly.' },
        compaction: { groups: ['base'] },
      },
    };
    const reference = {
      sourceDirectories: { shared: './shared-prompts', 'agent-prompts': './shared-prompts' },
      agent: {
        permission: {
          'sk*': { '*': 'deny' },
          task: { '*': 'allow' },
          webfetch: 'allow',
          question: 'ask',
          todowrite: 'allow',
          websearch: 'deny',
          doom_loop: 'ask',
        } satisfies PermissionPolicy,
        overrides: { build: { permission: { skill: { '*': 'allow' } } satisfies PermissionPolicy } },
        modelPresets: { balanced: { model: 'fixture/alpha', variant: 'low' } },
        prompts: { defaults: { append: ['{{include:@shared/default.md}}'] } },
        groups: {
          ...Object.fromEntries(
            permissionCases.flatMap(({ name, layers }) =>
              layers.map((permission, index) => [`${name}-${index}`, { permission }]),
            ),
          ),
          base: { model: 'fixture/beta', variant: 'high' },
          developers: {
            modelRef: 'preset:balanced',
            prompt: { append: ['GROUP_GUIDANCE'] },
            permission: { skill: 'allow' },
          },
          primary: { modelRef: 'opencode:model', variant: 'low' },
          small: { modelRef: 'opencode:small_model', variant: 'low' },
        },
      },
      command: {},
      skill: {},
    };
    const rules = (policy: PermissionPolicy): PermissionRule[] =>
      Object.entries(policy).flatMap(([tool, value]) =>
        typeof value === 'string'
          ? [{ tool, action: value }]
          : Object.entries(value).map(([pattern, action]) => ({ tool, pattern, action })),
      );
    const composer: CompositionDocument = {
      sourceDirectories: reference.sourceDirectories,
      defaults: {
        permissions: rules(reference.agent.permission),
        agents: { prompt: reference.agent.prompts.defaults },
      },
      configurationPresets: reference.agent.modelPresets,
      componentGroups: Object.fromEntries(
        Object.entries(reference.agent.groups).map(([name, value]) => {
          const { permission, ...configuration } = value as AgentConfiguration & { permission?: PermissionPolicy };
          return [
            name,
            {
              configuration: {
                ...configuration,
                ...(permission === undefined ? {} : { permissions: rules(permission) }),
              },
            },
          ];
        }),
      ),
      profiles: {
        work: {
          layers: [
            ...Object.keys(reference.agent.groups).map((componentGroup) => ({ componentGroup })),
            { componentGroup: 'builtins' },
          ],
          overrides: { agents: { build: { permissions: rules(reference.agent.overrides.build.permission) } } },
        },
      },
      activeProfiles: ['work'],
    };
    composer.componentGroups!.builtins = { agents: ['build'] };
    await writeFile(
      join(configRoot, 'config-composer.jsonc'),
      `// Dedicated settings\n${JSON.stringify(composer, null, 2)}\n`,
    );
    await writeFile(join(configRoot, 'shared-prompts/default.md'), 'GLOBAL_GUIDANCE');
    await writeFile(join(configRoot, 'shared-prompts/worker.md'), 'INITIAL_WORKER_GUIDANCE');
    await writeFile(join(configRoot, 'shared-prompts/skill.md'), 'SKILL_GUIDANCE {{include:@shared/skill-inner.md}}');
    await writeFile(join(configRoot, 'shared-prompts/skill-inner.md'), 'NESTED_SKILL_GUIDANCE');
    await writeFile(
      join(configRoot, 'skills/included-skill/SKILL.md'),
      '---\nname: included-skill\ndescription: Synthetic skill for native composition.\n---\n' +
        'SKILL_BODY_BEFORE\n{{include:@agent-prompts/skill.md}}\nSKILL_BODY_AFTER\n',
    );
    await writeFile(join(configRoot, 'skills/included-skill/notes.txt'), 'Companion resource');
    await writeFile(
      join(configRoot, 'opencode.jsonc'),
      `// Native integration fixture\n${JSON.stringify(config, null, 2)}\n`,
    );
    await writeFile(
      join(configRoot, 'agents/worker.md'),
      '---\nmode: primary\ngroups: [base, developers]\n---\nReply briefly.\n{{include:@shared/worker.md}}\n',
    );
    await writeFile(join(configRoot, 'tui.jsonc'), JSON.stringify({ plugin: [installed.directory] }));
    await writeFile(
      join(project, 'opencode.json'),
      JSON.stringify({ model: 'fixture/beta', small_model: 'fixture/beta' }),
    );
    const nativeBytes = await readFile(join(configRoot, 'opencode.jsonc'), 'utf8');
    await host.start();
    interface Agent {
      name: string;
      model: { providerID: string; modelID: string };
      variant?: string;
      options: Record<string, unknown>;
      prompt?: string | null;
      permission: { permission: string; pattern: string; action: string }[];
    }
    interface Message {
      info: { modelID: string; error?: unknown };
      parts: {
        type: string;
        text?: string;
        tool?: string;
        state?: {
          status: string;
          error?: string;
          title?: string;
          output?: string;
          metadata?: { name?: string; dir?: string; truncated?: boolean };
        };
      }[];
    }
    const notifications = await nativeNotifications(host);
    const agents = await api<Agent[]>('/agent');
    const effective = await api<{
      permission: PermissionPolicy;
      agent: Record<string, { permission?: PermissionPolicy; prompt?: string }>;
    }>('/config');
    assert.deepEqual((await (await installedEditor(host)).runtime()).baseline.permission, config.permission);
    assert.equal(explainPermission(effective.permission, 'skill', 'included-skill').action, 'deny');
    assert.equal(effective.permission.webfetch, 'allow');
    assert.equal(effective.permission.question, 'ask');
    assert.equal(effective.permission.todowrite, 'allow');
    assert.equal(effective.permission.websearch, 'deny');
    assert.equal(effective.permission.doom_loop, 'ask');
    assert.equal(effective.agent.build.prompt, undefined, 'permission-only built-in override does not invent a prompt');
    assert.ok(
      agents
        .find((agent) => agent.name === 'build')
        ?.permission.some((rule) => rule.permission === 'task' && rule.action === 'allow') === true,
      'enabled delegation inherits Composer defaults',
    );
    for (const fixture of permissionCases) {
      const global = composePermissions([config.permission, reference.agent.permission]);
      const explicit: PermissionPolicy =
        fixture.name === 'native-fallback' || fixture.name === 'unsupported-allow'
          ? { skill: 'allow' }
          : fixture.name === 'group-over-native'
            ? { skill: 'deny' }
            : {};
      const policy =
        fixture.unsupported === true
          ? composePermissions([global, explicit])
          : composePermissions([global, explicit, ...fixture.layers]);
      if (fixture.name.includes('-domain-')) {
        assert.equal(policy.skill, undefined, 'native proof must exercise wildcard replay without an exact-tool block');
      }
      // /config's response schema enumerates known keys first; /agent exposes
      // the ordered rules actually used by native permission evaluation.
      if (fixture.unsupported === true) {
        assert.deepEqual(effective.agent[fixture.name].permission ?? {}, explicit);
      } else if (fixture.probe === undefined) {
        assert.deepEqual(effective.agent[fixture.name].permission, policy);
      } else {
        assert.deepEqual(effective.agent[fixture.name].permission ?? {}, {});
      }
      const emitted = Object.entries(policy).flatMap(([permission, value]) =>
        Object.entries(typeof value === 'string' ? { '*': value } : value).map(([pattern, action]) => ({
          permission,
          pattern,
          action,
        })),
      );
      const actual = agents.find((agent) => agent.name === fixture.name)?.permission;
      assert.ok(actual !== undefined);
      if (fixture.probe === undefined && fixture.unsupported !== true) {
        assert.deepEqual(
          actual.filter((rule) => rule.permission !== 'external_directory').slice(-emitted.length),
          emitted,
        );
      }
      const permissionName =
        fixture.probe === undefined ? 'skill' : fixture.probe === 'allow' ? 'read' : 'external_directory';
      const pattern =
        fixture.probe === undefined
          ? 'included-skill'
          : fixture.probe === 'allow'
            ? 'notes.txt'
            : '__composer_permission_probe_outside__';
      assert.equal(
        explainPermission(policy, permissionName, pattern).action,
        fixture.probe === undefined ? fixture.action : undefined,
      );
      const beforeRequests = host.requests.length;
      const session = await api<{ id: string }>('/session', { title: `Permission ${fixture.name}` });
      const state = { completed: false };
      const request = api<Message>(`/session/${session.id}/message`, {
        agent: fixture.name,
        parts: [
          {
            type: 'text',
            text: fixture.probe === undefined ? 'Load included-skill now.' : `Probe native ${fixture.probe}.`,
          },
        ],
      }).finally(() => {
        state.completed = true;
      });
      let asked = false;
      for (let attempt = 0; attempt < 300 && !state.completed; attempt++) {
        const pending = await api<{ id: string; sessionID: string }[]>('/permission');
        for (const permission of pending.filter((item) => item.sessionID === session.id)) {
          asked = true;
          await api(`/permission/${permission.id}/reply`, { reply: 'once' });
        }
        await setTimeout(30);
      }
      const result = await request;
      assert.equal(asked, fixture.action === 'ask', `native approval: ${fixture.name}`);
      assert.equal(result.info.error, undefined, JSON.stringify(result.info.error));
      const messages = await api<Message[]>(`/session/${session.id}/message`);
      if (fixture.probe === undefined) {
        const captured = JSON.stringify(host.requests.slice(beforeRequests));
        assert.equal(
          captured.includes('SKILL_BODY_BEFORE'),
          fixture.action !== 'deny',
          `provider tool content: ${fixture.name}`,
        );
      }
      const toolName = fixture.probe === undefined ? 'skill' : `permission_default_${fixture.probe}`;
      const tool = messages.flatMap((message) => message.parts).find((part) => part.tool === toolName);
      if (fixture.name === 'unsupported-deny') {
        assert.equal(tool, undefined, 'inherited global deny keeps skill unavailable');
        assert.equal(actual.findLast((rule) => rule.permission === 'sk*' && rule.pattern === '*')?.action, 'deny');
        continue;
      }
      assert.equal(
        tool?.state?.status,
        fixture.action === 'deny' ? 'error' : 'completed',
        `native evaluator: ${fixture.name}`,
      );
      if (fixture.action === 'deny') {
        assert.match(tool.state.error ?? '', /rule which prevents you from using this specific tool call/);
      }
    }
    await notifications.wait(
      (toast) =>
        toast.variant === 'warning' && /Agent unsupported-allow:.*Fallback may be more permissive/.test(toast.message),
    );
    assert.match(host.stderr, /Agent unsupported-allow:.*Fallback may be more permissive/);
    assert.equal(await readFile(join(configRoot, 'opencode.jsonc'), 'utf8'), nativeBytes);
    for (const name of ['plan', 'build']) {
      const rules = agents.find((agent) => agent.name === name)?.permission;
      assert.ok(rules !== undefined);
      assert.equal(
        rules.findLast((rule) => rule.permission === (name === 'build' ? 'skill' : 'sk*'))?.action,
        name === 'build' ? 'allow' : 'deny',
        `${name} inherits the global policy`,
      );
      assert.equal(
        agents.find((agent) => agent.name === name)?.prompt ?? undefined,
        undefined,
        `${name} has no synthesized prompt`,
      );
    }
    // Global compilation failure preserves native globals and valid independent agents.
    const brokenGlobal = {
      ...composer,
      defaults: {
        ...composer.defaults,
        permissions: rules({ webfetch: 'allow', 'webfetc?': { b: 'deny' }, skill: 'deny' }),
      },
    };
    await writeFile(join(configRoot, 'config-composer.jsonc'), JSON.stringify(brokenGlobal));
    const nativeFallback = { ...config, permission: { ...config.permission, 'webfetc?': { a: 'deny' } } };
    await writeFile(join(configRoot, 'opencode.jsonc'), JSON.stringify(nativeFallback));
    await api(
      '/global/config',
      { plugin: [[installed.directory, { reloadToken: randomUUID() }], permissionProbe] },
      'PATCH',
    );
    const fallbackConfig = await api<{
      permission: PermissionPolicy;
      agent: Record<string, { permission?: PermissionPolicy }>;
    }>('/config');
    assert.deepEqual(fallbackConfig.permission, nativeFallback.permission);
    // /config serializes known tool names before arbitrary keys; real evaluation
    // below verifies the ordered native rules instead of that response order.
    assert.deepEqual(fallbackConfig.agent['later-allow'].permission?.skill, { 'included-*': 'deny', '*': 'allow' });
    const preserved = await api<{ id: string }>('/session', { title: 'Global failure independent policy' });
    await api(`/session/${preserved.id}/message`, {
      agent: 'later-allow',
      parts: [{ type: 'text', text: 'Load included-skill now.' }],
    });
    const preservedMessages = await api<Message[]>(`/session/${preserved.id}/message`);
    assert.equal(
      preservedMessages.flatMap((message) => message.parts).find((part) => part.tool === 'skill')?.state?.status,
      'completed',
    );
    await notifications.wait(
      (toast) => toast.variant === 'warning' && /Global scope:.*native global permissions remain/.test(toast.message),
    );
    assert.match(host.stderr, /Global scope:.*native global permissions remain/);
  },
);
