import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import Ajv from 'ajv/dist/2020.js';
import { readCompositionDocument } from '../src/config-composer/composition/document.ts';
import { resolveComposition } from '../src/config-composer/composition/runtime.ts';
import { modelParameterDetail } from '../src/config-composer/tui/view.ts';

const native = { agent: { worker: { groups: ['coding'], model: 'p/native' } } };
const parameters = {
  temperature: 0,
  top_p: 0,
  topK: 10,
  maxOutputTokens: 128,
  options: { nested: { flag: false, count: 0, text: '', nil: null, list: [] } },
};

test('model parameter bindings have parser/schema parity and finite bounded controls', async () => {
  const schema = JSON.parse(await readFile(new URL('../schema.json', import.meta.url), 'utf8')) as object;
  const validate = new Ajv({ strict: false }).compile(schema);
  for (const fields of [parameters, { temperature: 2, top_p: 1 }, { options: {} }]) {
    const value = { models: { coding: { model: 'p/alias', ...fields } } };
    assert.doesNotThrow(() => readCompositionDocument(value));
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
  }
  for (const fields of [
    { temperature: -1 },
    { temperature: 3 },
    { top_p: -0.1 },
    { top_p: 1.1 },
    { topK: 0 },
    { topK: 1.1 },
    { maxOutputTokens: 0 },
    { maxOutputTokens: 1.1 },
    { maxOutputTokens: Number.MAX_SAFE_INTEGER + 1 },
    { options: [] },
    { options: { groups: ['coding'] } },
    { parameters: {} },
    ...['temperature', 'top_p', 'topP', 'topK', 'top_k', 'maxOutputTokens', 'max_tokens', 'max_completion_tokens'].map(
      (key) => ({ options: { [key]: 1 } }),
    ),
  ]) {
    const value = { models: { coding: { model: 'p/alias', ...fields } } };
    assert.throws(() => readCompositionDocument(value), Error, JSON.stringify(fields));
    assert.equal(validate(value), false, JSON.stringify(fields));
  }
  for (const number of [NaN, Infinity, -Infinity]) {
    assert.throws(() => readCompositionDocument({ models: { coding: { model: 'p/alias', temperature: number } } }));
  }
});

test('parameters replace as a whole with profile binding, including same-model changes and Shared only', () => {
  const document = readCompositionDocument({
    models: { coding: { model: 'p/alias', maxOutputTokens: 64 } },
    groups: { coding: { agent: { modelRef: 'coding' } } },
    profiles: {
      a: { models: { coding: { model: 'p/alias', ...parameters } } },
      b: { models: { coding: { model: 'p/alias', temperature: 0.9 } } },
    },
  });
  for (const [choice, expected] of [
    ['a', parameters],
    ['b', { temperature: 0.9 }],
    ['a', parameters],
    [null, { maxOutputTokens: 64 }],
  ] as const) {
    const candidate = resolveComposition(document, choice, native, {});
    const binding = candidate.modelParameters?.worker;
    assert.ok(binding !== undefined);
    assert.deepEqual(binding.parameters, expected);
    assert.equal(binding.model, 'p/alias');
    assert.deepEqual(candidate.agent.worker, { model: 'p/alias', variant: '' });
    assert.equal(
      binding.origin.modelBinding?.pointer,
      choice === null ? '/models/coding' : `/profiles/${choice}/models/coding`,
    );
  }
});

test('later aliases/literal models and authored pins cannot leave stale parameter bundles', () => {
  const source = { path: '/worker.md', canonicalPath: '/worker.md', fingerprint: 'x' };
  const base = {
    models: { coding: { model: 'p/alias', ...parameters }, plain: { model: 'p/alias' } },
    groups: { coding: { agent: { modelRef: 'coding' } } },
  };
  for (const agent of [
    { worker: { modelRef: 'plain' } },
    { worker: { model: 'p/alias' } },
    { worker: { model: 'p/other' } },
  ]) {
    const result = resolveComposition(readCompositionDocument({ ...base, agent }), null, native, {});
    assert.equal(result.modelParameters?.worker, undefined);
  }
  for (const model of ['p/alias', 'p/other']) {
    const result = resolveComposition(readCompositionDocument(base), null, native, {
      worker: { sources: [source], fields: { model: { value: model, authored: { model }, source } } },
    });
    assert.equal(result.modelParameters?.worker?.model, model === 'p/alias' ? model : undefined);
  }
  const profileOnly = resolveComposition(
    readCompositionDocument({ groups: base.groups, profiles: { a: { models: base.models } } }),
    null,
    native,
    {},
  );
  assert.equal(profileOnly.modelParameters?.worker, undefined);
  assert.equal(profileOnly.agent.worker.model, 'p/native');
});

test('inspection distinguishes model-specific defaults, sources and final frontmatter pins', () => {
  const source = { path: '/worker.md', canonicalPath: '/worker.md', fingerprint: 'x' };
  const authority = {
    worker: {
      sources: [source],
      fields: {
        options: { value: {}, authored: { options: {} }, source },
        temperature: { value: 0, authored: { temperature: 0 }, source },
      },
    },
  };
  const candidate = resolveComposition(
    readCompositionDocument({
      models: { coding: { model: 'p/alias', ...parameters } },
      agent: { worker: { modelRef: 'coding' } },
    }),
    null,
    { agent: { worker: {} } },
    authority,
  );
  const detail = modelParameterDetail(candidate, authority, 'worker', '/composer.jsonc');
  assert.match(detail, /Request defaults for p\/alias only/);
  assert.match(detail, /\/agent\/worker\/modelRef/);
  assert.match(detail, /\/models\/coding/);
  assert.match(detail, /temperature: 0 takes priority \(frontmatter\)/);
  assert.match(detail, /Alias options blocked by authored frontmatter: \{\}/);
});
