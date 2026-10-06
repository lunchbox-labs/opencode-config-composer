import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import schema from '../schema.json' with { type: 'json' };
import type {
  AgentConfiguration,
  ConfigurationPreset,
  ConfiguredPermissionPreview,
  PresetTarget,
} from '../src/config-composer/composition/types.ts';
import {
  CompositionValidationError,
  parseCompositionDocument,
  readCompositionDocument,
  selectActiveProfiles,
} from '../src/config-composer/composition/document.ts';

const validate = new Ajv2020({ strict: true, strictRequired: false, allowUnionTypes: true }).compile(schema);
const fixture = new URL('./fixtures/composition/', import.meta.url);

test('canonical JSONC fixture preserves all component kinds and ordered contributions', async () => {
  const source = await readFile(new URL('config-composer.jsonc', fixture), 'utf8');
  const document = parseCompositionDocument(source, 'fixture');
  assert.equal(validate(document), true, JSON.stringify(validate.errors));
  assert.deepEqual(Object.keys(document.components ?? {}), ['agents', 'skills', 'commands', 'prompts']);
  assert.deepEqual(document.imports, ['./profiles/workflows.jsonc']);
  assert.deepEqual(document.activeProfiles, ['claude-coding']);
  assert.deepEqual(document.configurationPresets?.['review-checks'].permissions, [
    { tool: 'bash', pattern: 'git *', action: 'ask' },
    { tool: 'bash', pattern: 'npm *', action: 'deny' },
  ]);
  const profiles = parseCompositionDocument(await readFile(new URL('profiles/workflows.jsonc', fixture), 'utf8'));
  assert.equal(validate(profiles), true);
  assert.equal(profiles.profiles?.['claude-coding'].extends, 'coding-base');
  assert.deepEqual(profiles.profiles['coding-base'].layers?.[0], { componentGroup: 'review' });
  assert.equal(profiles.activeProfiles, undefined, 'definitions do not activate profiles');
});

test('local activation replaces shared order, absence inherits, and an empty list selects none', () => {
  const shared = readCompositionDocument({ activeProfiles: ['review', 'coding'] });
  assert.deepEqual(selectActiveProfiles(shared), ['review', 'coding']);
  assert.deepEqual(selectActiveProfiles(shared, readCompositionDocument({})), ['review', 'coding']);
  assert.deepEqual(selectActiveProfiles(shared, readCompositionDocument({ activeProfiles: [] })), []);
  assert.deepEqual(selectActiveProfiles(shared, readCompositionDocument({ activeProfiles: ['coding', 'review'] })), [
    'coding',
    'review',
  ]);
  const selected = selectActiveProfiles(shared);
  selected.reverse();
  assert.deepEqual(shared.activeProfiles, ['review', 'coding'], 'selection does not mutate the source');
  assert.deepEqual(selectActiveProfiles(), []);
});

test('defaults, scoped overrides, mixed groups, and settings-only presets are independent', () => {
  const input = {
    defaults: { model: 'fixture/main', small_model: 'fixture/small', agents: { permissions: [] } },
    overrides: { model: 'fixture/other', agents: { worker: { modelRef: 'opencode:model' } } },
    componentGroups: {
      skills: { skills: ['test-first'] },
      mixed: { agents: ['worker'], commands: ['test'], configuration: { model: 'fixture/main' } },
    },
    configurationPresets: {
      model: { model: 'fixture/main', parameters: { maxOutputTokens: 4096, options: { stop: ['done'] } } },
      permissions: { permissions: [{ tool: 'bash', pattern: '*', action: 'allow' }] },
    },
  };
  assert.deepEqual(readCompositionDocument(input), input);
  assert.equal(validate(input), true, JSON.stringify(validate.errors));
});

const invalid: [string, unknown][] = [
  ['unknown root field', { activeProfile: 'review' }],
  ['unknown nested field', { components: { agents: { worker: { fil: './worker.md' } } } }],
  ['empty component', { components: { agents: { worker: {} } } }],
  ['ambiguous component content', { components: { prompts: { scope: { file: './scope.md', text: 'scope' } } } }],
  ['invalid registry name', { componentGroups: { '../review': {} } }],
  ['invalid component name', { components: { agents: { '../worker': { prompt: 'work' } } } }],
  ['duplicate active selection', { activeProfiles: ['review', 'review'] }],
  ['file-path activation', { activeProfiles: ['./profiles/review.jsonc'] }],
  ['null activation', { activeProfiles: null }],
  ['too many active profiles', { activeProfiles: Array.from({ length: 65 }, (_, i) => `p${i}`) }],
  ['remote import', { imports: ['https://example.org/profiles.jsonc'] }],
  ['non-JSONC import', { imports: ['./profiles'] }],
  ['empty import', { imports: [''] }],
  ['duplicate import', { imports: ['./a.jsonc', './a.jsonc'] }],
  ['multiple parents', { profiles: { review: { extends: ['base', 'other'] } } }],
  ['activation within profile', { profiles: { review: { activeProfiles: [] } } }],
  [
    'ambiguous layer',
    { profiles: { review: { layers: [{ componentGroup: 'review', configurationPreset: 'model' }] } } },
  ],
  ['preset without target', { profiles: { review: { layers: [{ configurationPreset: 'model' }] } } }],
  ['empty target', { profiles: { review: { layers: [{ configurationPreset: 'model', target: { agents: [] } }] } } }],
  [
    'non-agent target',
    { profiles: { review: { layers: [{ configurationPreset: 'model', target: { skills: ['test'] } }] } } },
  ],
  [
    'invalid permission action',
    { configurationPresets: { policy: { permissions: [{ tool: 'bash', action: 'maybe' }] } } },
  ],
  ['unordered permissions', { configurationPresets: { policy: { permissions: { bash: 'allow' } } } }],
  [
    'conflicting model identity',
    { configurationPresets: { model: { model: 'fixture/a', modelRef: 'opencode:model' } } },
  ],
  ['invalid model', { defaults: { model: 'missing-provider' } }],
  ['invalid temperature', { configurationPresets: { model: { parameters: { temperature: 3 } } } }],
  ['invalid output tokens', { configurationPresets: { model: { parameters: { maxOutputTokens: 1.5 } } } }],
  ['unsafe custom key', JSON.parse('{"configurationPresets":{"model":{"parameters":{"options":{"__proto__":{}}}}}}')],
];

for (const [name, value] of invalid) {
  test(`canonical validation rejects ${name} in both parser and exported schema`, () => {
    assert.throws(() => readCompositionDocument(value), CompositionValidationError);
    assert.equal(validate(value), false, name);
  });
}

test('legacy formats fail with actionable source and field migration diagnostics', () => {
  for (const [key, destination] of [
    ['agent', 'components.agents'],
    ['command', 'components.commands'],
    ['skill', 'components.skills'],
    ['groups', 'componentGroups'],
    ['modelPresets', 'configurationPresets'],
    ['model', 'defaults.model'],
    ['small_model', 'defaults.small_model'],
  ]) {
    assert.throws(
      () => readCompositionDocument({ [key]: {} }, 'project.jsonc'),
      (error: unknown) => {
        assert.ok(error instanceof CompositionValidationError);
        assert.equal(error.diagnostic.code, 'legacy-composition-key');
        assert.equal(error.diagnostic.sourceId, 'project.jsonc');
        assert.equal(error.diagnostic.pointer, `/${key}`);
        assert.ok(error.message.includes(destination));
        return true;
      },
    );
  }
});

test('JSONC parsing rejects duplicate keys, malformed input, excessive depth, and oversized sources', () => {
  for (const text of [
    '{"activeProfiles": [], "activeProfiles": []}',
    '{',
    '[]',
    '{"x":'.repeat(40) + '0' + '}'.repeat(40),
    ' '.repeat(1024 * 1024 + 1),
  ]) {
    assert.throws(() => parseCompositionDocument(text, 'broken.jsonc'), CompositionValidationError);
  }
});

test('validation copies data and rejects non-JSON values without mutating input', () => {
  const input = {
    activeProfiles: ['review'],
    configurationPresets: { model: { parameters: { options: { a: [1] } } } },
  };
  const parsed = readCompositionDocument(input);
  input.activeProfiles.push('coding');
  assert.deepEqual(parsed.activeProfiles, ['review']);
  assert.notEqual(
    parsed.configurationPresets?.model.parameters?.options,
    input.configurationPresets.model.parameters.options,
  );
  for (const options of [{ a: undefined }, { a: NaN }, { a: Infinity }, { a: new Date() }]) {
    assert.throws(
      () => readCompositionDocument({ configurationPresets: { model: { parameters: { options } } } }),
      CompositionValidationError,
    );
  }
});

test('file-based activation and inheritance identify the named-profile migration', () => {
  for (const input of [
    { activeProfiles: ['./profiles/review.jsonc'] },
    { profiles: { review: { extends: '../base.jsonc' } } },
    { composition: {}, extends: './base.jsonc' },
  ]) {
    assert.throws(
      () => readCompositionDocument(input, 'old-profile.jsonc'),
      (error: unknown) => {
        assert.ok(error instanceof CompositionValidationError);
        assert.match(error.message, /imports/);
        assert.match(error.message, /profile/i);
        return true;
      },
    );
  }
});

test('ordered permissions preserve repeated rules and explicit ask without fallback synthesis', () => {
  const permissions = [
    { tool: 'bash', pattern: 'git *', action: 'deny' },
    { tool: 'bash', pattern: '*', action: 'allow' },
    { tool: 'bash', pattern: 'npm *', action: 'ask' },
    { tool: 'bash', pattern: 'git *', action: 'allow' },
  ];
  assert.deepEqual(
    readCompositionDocument({ configurationPresets: { checks: { permissions } } }).configurationPresets?.checks
      .permissions,
    permissions,
  );
});

test('schema accepts each component body and keeps external references unresolved', () => {
  const input = {
    components: {
      agents: { 'team/reviewer': { prompt: '', skills: ['external-skill'], promptRefs: ['external-prompt'] } },
      commands: { review: { file: './commands/review.md', agent: 'team/reviewer' } },
      prompts: { scope: { text: 'Only review the diff.' } },
    },
    sourceDirectories: { shared: '../fragments' },
    configurationPresets: { variant: { variant: 'high', parameters: { topK: 1, topP: 0, temperature: 2 } } },
    profiles: {
      review: {
        extends: 'external-parent',
        layers: [
          {
            configurationPreset: 'variant',
            target: { agents: ['team/reviewer'], componentGroups: ['external-group'] },
          },
        ],
      },
    },
  };
  assert.deepEqual(readCompositionDocument(input), input);
  assert.equal(validate(input), true);
});

test('JSONC rejects unsafe property tokens even when the parser would omit their values', () => {
  for (const text of [
    '{"__proto__":null}',
    '{"configurationPresets":{"m":{"parameters":{"options":{"__proto__":1}}}}}',
  ]) {
    assert.throws(
      () => parseCompositionDocument(text, 'unsafe.jsonc'),
      (error: unknown) => {
        assert.ok(error instanceof CompositionValidationError);
        assert.equal(error.diagnostic.code, 'unsafe-composition-key');
        assert.equal(error.diagnostic.pointer?.endsWith('/__proto__'), true);
        return true;
      },
    );
  }
});

test('TypeScript contracts exclude conflicting model identities and empty preset targets', () => {
  // @ts-expect-error -- A contribution must not specify two model identities.
  const agent: AgentConfiguration = { model: 'fixture/a', modelRef: 'opencode:model' };
  // @ts-expect-error -- Presets obey the same mutually exclusive identity contract.
  const preset: ConfigurationPreset = { model: 'fixture/a', modelRef: 'opencode:model' };
  // @ts-expect-error -- A preset assignment requires at least one target kind.
  const target: PresetTarget = {};
  assert.throws(() => readCompositionDocument({ defaults: { agents: agent } }));
  assert.throws(() => readCompositionDocument({ configurationPresets: { invalid: preset } }));
  assert.throws(() =>
    readCompositionDocument({ profiles: { invalid: { layers: [{ configurationPreset: 'model', target }] } } }),
  );
});

test('preset layer errors identify the supplied branch and exact invalid target', () => {
  for (const [layer, pointer, message] of [
    [{ configurationPreset: 'model', target: { agents: [] } }, '/target/agents', /fewer than 1/],
    [{ configurationPreset: 'model' }, '', /target/],
    [{ componentGroup: 'review', extra: true }, '/extra', /additional properties/],
  ] as const) {
    assert.throws(
      () => readCompositionDocument({ profiles: { review: { layers: [layer] } } }),
      (error: unknown) => {
        assert.ok(error instanceof CompositionValidationError);
        assert.equal(error.diagnostic.pointer, `/profiles/review/layers/0${pointer}`);
        assert.match(error.message, message);
        return true;
      },
    );
  }
});

test('permission diagnostics retain canonical contribution pointers across scopes', () => {
  const permissions = [{ tool: 'bash', action: 'invalid' }];
  for (const [input, pointer] of [
    [{ defaults: { agents: { permissions } } }, '/defaults/agents/permissions/0/action'],
    [{ configurationPresets: { checks: { permissions } } }, '/configurationPresets/checks/permissions/0/action'],
    [
      { componentGroups: { review: { configuration: { permissions } } } },
      '/componentGroups/review/configuration/permissions/0/action',
    ],
    [
      { overrides: { agents: { 'team/reviewer': { permissions } } } },
      '/overrides/agents/team~1reviewer/permissions/0/action',
    ],
    [
      { profiles: { review: { overrides: { agents: { build: { permissions } } } } } },
      '/profiles/review/overrides/agents/build/permissions/0/action',
    ],
  ] as const) {
    assert.throws(
      () => readCompositionDocument(input, 'source.jsonc'),
      (error: unknown) => {
        assert.ok(error instanceof CompositionValidationError);
        assert.equal(error.diagnostic.sourceId, 'source.jsonc');
        assert.equal(error.diagnostic.pointer, pointer);
        return true;
      },
    );
  }
});

test('permission preview contracts distinguish an explicit ask from native fallback', () => {
  const fallback: ConfiguredPermissionPreview = { fallback: 'native' };
  const matched: ConfiguredPermissionPreview = {
    action: 'ask',
    matched: { permission: 'bash', pattern: 'git *' },
    origin: {
      sourceId: 'source.jsonc',
      pointer: '/configurationPresets/checks/permissions/0/action',
      layer: 'profile:review',
      operation: 'set',
      references: [],
      overwritten: [],
    },
  };
  // @ts-expect-error -- A nonmatch must not claim that native fallback evaluates to ask.
  const invalid: ConfiguredPermissionPreview = { fallback: 'native', action: 'ask' };
  assert.equal(fallback.action, undefined);
  assert.equal(matched.fallback, undefined);
  assert.equal(invalid.action, 'ask');
});
