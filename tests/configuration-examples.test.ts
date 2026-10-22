import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import Ajv from 'ajv/dist/2020.js';
import { parseConfiguration } from '../src/config-composer/configuration.ts';
import { readCompositionDocument } from '../src/config-composer/composition/document.ts';
import { resolveComposition } from '../src/config-composer/composition/runtime.ts';

test('provider examples allocate one provider or an explicit mixed profile to existing agents', async () => {
  const document = readCompositionDocument(
    parseConfiguration(
      await readFile(new URL('../docs/examples/provider-profiles/config-composer.jsonc', import.meta.url), 'utf8'),
    ),
  );
  for (const [profile, expected] of Object.entries({
    anthropic: ['anthropic/claude-sonnet-4-5', 'anthropic/claude-sonnet-4-5', 'anthropic/claude-sonnet-4-5'],
    openai: ['openai/gpt-5', 'openai/gpt-5', 'openai/gpt-5'],
    mixed: ['openai/gpt-5', 'anthropic/claude-sonnet-4-5', 'anthropic/claude-sonnet-4-5'],
  })) {
    const result = resolveComposition(document, profile, {}, {});
    assert.deepEqual(
      ['build', 'plan', 'explore'].map((name) => result.agent[name].model),
      expected,
    );
  }
  const shared = resolveComposition(document, null, {}, {});
  assert.ok(['build', 'plan', 'explore'].every((name) => shared.agent[name].model === undefined));
});

test('shipped examples validate against strict schema and target native builtins', async () => {
  const schema = JSON.parse(await readFile(new URL('../schema.json', import.meta.url), 'utf8')) as object;
  const validate = new Ajv({ strict: false }).compile(schema);
  for (const path of [
    '../skills/config-composer-create/examples/review.jsonc',
    './fixtures/composition/config-composer.jsonc',
    '../docs/examples/role-permissions/config-composer.jsonc',
    '../docs/examples/project-selection/config-composer.jsonc',
    '../docs/examples/provider-profiles/config-composer.jsonc',
    '../docs/examples/review-programming/config-composer.jsonc',
  ]) {
    const raw = parseConfiguration(await readFile(new URL(path, import.meta.url), 'utf8'));
    assert.ok(validate(raw), JSON.stringify(validate.errors));
    const doc = readCompositionDocument(raw);
    for (const profile of Object.keys(doc.profiles)) {
      assert.equal(resolveComposition(doc, profile, {}, {}).profile, profile);
    }
  }
});

test('published schema uses native action-only permissions and string modes in every agent patch', async () => {
  const schema = JSON.parse(await readFile(new URL('../schema.json', import.meta.url), 'utf8')) as object;
  const validate = new Ajv({ strict: false }).compile(schema);
  for (const tool of ['todowrite', 'question', 'webfetch', 'websearch', 'doom_loop']) {
    for (const value of [{}, { '*': 'deny' }]) {
      const patch = { permission: { [tool]: value } };
      for (const document of [
        { agent: { worker: patch } },
        { groups: [{ name: 'workers', members: { agent: ['worker'] }, agent: patch }] },
        { profiles: { inactive: { agent: { worker: patch } } } },
      ]) {
        assert.equal(validate(document), false, JSON.stringify(document));
      }
    }
    assert.equal(validate({ agent: { worker: { permission: { [tool]: 'ask' } } } }), true);
  }
  for (const mode of [['primary'], ['subagent'], ['all'], [[['primary']]]]) {
    assert.equal(validate({ profiles: { inactive: { agent: { worker: { mode } } } } }), false);
  }
  assert.equal(
    validate({
      agent: { worker: { permission: { bash: {}, read: { '*.md': 'ask' }, custom_tool: { '*': 'deny' } } } },
    }),
    true,
  );
  assert.equal(validate({ agent: { worker: { permission: {} } } }), true);
});
