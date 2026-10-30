import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catalogModels } from '../src/config-composer/settings.ts';
import { validateCandidate } from '../src/config-composer/storage.ts';
import { readCompositionDocument } from '../src/config-composer/composition/document.ts';
import { resolveComposition } from '../src/config-composer/composition/runtime.ts';

const document = readCompositionDocument({
  models: { coding: { model: 'p/alias', topK: 10 }, plain: { model: 'p/alias', temperature: 0 } },
  agent: { worker: { modelRef: 'coding' }, helper: { modelRef: 'plain' } },
});
const catalog = (npm: string) =>
  catalogModels([{ id: 'p', models: { alias: { name: 'alias', api: { npm }, variants: {} } } }]);

test('the catalog records each model adapter when the provider reports one', () => {
  assert.deepEqual(catalog('@ai-sdk/anthropic'), [{ id: 'p/alias', npm: '@ai-sdk/anthropic', variants: {} }]);
  assert.deepEqual(catalogModels([{ id: 'p', models: { alias: {} } }]), [{ id: 'p/alias', variants: {} }]);
});

test('preview rejects topK for OpenAI-compatible models before any request is sent', () => {
  const candidate = resolveComposition(document, null, { agent: { worker: {}, helper: {} } }, {});
  validateCandidate(candidate, catalog('@ai-sdk/anthropic'));
  validateCandidate(candidate, catalogModels([{ id: 'p', models: { alias: {} } }]));
  assert.throws(
    () => validateCandidate(candidate, catalog('@ai-sdk/openai-compatible')),
    /Model alias coding \(agent worker\): topK is unsupported by @ai-sdk\/openai-compatible/,
  );
});
