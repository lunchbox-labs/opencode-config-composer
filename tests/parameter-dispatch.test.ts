import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyModelParameters } from '../src/config-composer/composition/model-parameters.ts';
import { readCompositionDocument } from '../src/config-composer/composition/document.ts';
import { resolveComposition } from '../src/config-composer/composition/runtime.ts';
import type { NativeAuthority } from '../src/config-composer/composition/document-types.ts';

const source = { path: '/worker.md', canonicalPath: '/worker.md', fingerprint: 'x' };
const bound = {
  model: 'p/alias',
  temperature: 0.4,
  top_p: 0.6,
  topK: 10,
  maxOutputTokens: 128,
  options: { reasoningEffort: 'low', nested: { own: 'alias', added: false }, text: '', count: 0, nil: null, list: [] },
};
const document = readCompositionDocument({ models: { coding: bound }, agent: { worker: { modelRef: 'coding' } } });
const input = (id = 'alias', variant?: string) => ({
  agent: 'worker',
  model: { providerID: 'p', id, api: { npm: '@ai-sdk/anthropic' }, variants: { high: { reasoningEffort: 'high' } } },
  message: { model: { providerID: 'p', modelID: 'alias', ...(variant === undefined ? {} : { variant }) } },
});
const output = () => ({
  temperature: 0.1,
  topP: 0.2,
  topK: 1,
  maxOutputTokens: undefined as number | undefined,
  options: { native: true, nested: { own: 'native', untouched: true } } as Record<string, unknown>,
});

test('dispatch applies only to actual matching model and never mutates captured state', () => {
  const candidate = resolveComposition(document, null, { agent: { worker: {} } }, {});
  const before = structuredClone(candidate);
  const result = output();
  applyModelParameters(candidate, {}, input(), result);
  assert.deepEqual(result, {
    temperature: 0.4,
    topP: 0.6,
    topK: 10,
    maxOutputTokens: 128,
    options: {
      native: true,
      nested: { own: 'alias', untouched: true, added: false },
      reasoningEffort: 'low',
      text: '',
      count: 0,
      nil: null,
      list: [],
    },
  });
  assert.deepEqual(candidate, before);
  for (const request of [
    input('other'),
    { ...input(), agent: 'title' },
    { ...input(), model: { ...input().model, providerID: 'other' } },
  ]) {
    const untouched = output();
    applyModelParameters(candidate, {}, request, untouched);
    assert.deepEqual(untouched, output());
  }
  const cleared = output();
  applyModelParameters(undefined, {}, input(), cleared);
  assert.deepEqual(cleared, output());
});

test('explicit agent scalars and option leaves and selected variant beat alias defaults', () => {
  const candidate = resolveComposition(
    document,
    null,
    { agent: { worker: { temperature: 0, top_p: 0, options: { nested: { own: 'pin' } } } } },
    {},
  );
  const result = output();
  result.temperature = 0;
  result.topP = 0;
  result.options.nested = { own: 'pin' };
  result.options.reasoningEffort = 'high';
  applyModelParameters(candidate, {}, input('alias', 'high'), result);
  assert.equal(result.temperature, 0);
  assert.equal(result.topP, 0);
  assert.deepEqual(result.options.nested, { own: 'pin', added: false });
  assert.equal(result.options.reasoningEffort, 'high');
  const noSelectedVariant = output();
  candidate.agent.worker.variant = 'high';
  applyModelParameters(candidate, {}, input(), noSelectedVariant);
  assert.equal(
    noSelectedVariant.options.reasoningEffort,
    'low',
    'do not revive alias/config variant absent from the actual request',
  );
});

test('authored frontmatter options pin the whole field, including empty objects', () => {
  for (const options of [{}, { nested: { own: false } }]) {
    const authority: NativeAuthority = {
      worker: { sources: [source], fields: { options: { value: options, authored: { options }, source } } },
    };
    const candidate = resolveComposition(document, null, { agent: { worker: {} } }, authority);
    const result = output();
    const prior = structuredClone(result.options);
    applyModelParameters(candidate, authority, input(), result);
    assert.deepEqual(result.options, prior);
    assert.equal(result.maxOutputTokens, 128);
  }
});

test('user topK reaches OpenAI-compatible requests without adapter filtering', () => {
  const candidate = resolveComposition(document, null, { agent: { worker: {} } }, {});
  const request = input();
  request.model.api.npm = '@ai-sdk/openai-compatible';
  const result = output();
  applyModelParameters(candidate, {}, request, result);
  assert.equal(result.topK, 10);
  assert.equal(result.temperature, 0.4);
  assert.equal(result.maxOutputTokens, 128);
});

test('native small title requests do not inherit the user message variant', () => {
  const candidate = resolveComposition(
    readCompositionDocument({ models: { coding: bound }, agent: { title: { modelRef: 'coding' } } }),
    null,
    {},
    {},
  );
  const request = { ...input('alias', 'high'), agent: 'title' };
  const result = output();
  applyModelParameters(candidate, {}, request, result);
  assert.equal(result.options.reasoningEffort, 'low');
});

test('user temperature reaches requests even when native metadata reports no support', () => {
  const candidate = resolveComposition(document, null, { agent: { worker: {} } }, {});
  const request = { ...input(), model: { ...input().model, capabilities: { temperature: false } } };
  const result = { ...output(), temperature: undefined };
  applyModelParameters(candidate, {}, request, result);
  assert.equal(result.temperature, 0.4);
  assert.equal(result.maxOutputTokens, 128);
});

test('explicit native temperature retains precedence when capability metadata reports no support', () => {
  const candidate = resolveComposition(document, null, { agent: { worker: { temperature: 0 } } }, {});
  const request = { ...input(), model: { ...input().model, capabilities: { temperature: false } } };
  const result = { ...output(), temperature: 0 };
  applyModelParameters(candidate, {}, request, result);
  assert.equal(result.temperature, 0);
  assert.equal(result.topK, 10);
});
