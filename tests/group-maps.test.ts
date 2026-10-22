import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import Ajv from 'ajv/dist/2020.js';
import { parseConfiguration } from '../src/config-composer/configuration.ts';
import { readCompositionDocument } from '../src/config-composer/composition/document.ts';
import { resolveComposition } from '../src/config-composer/composition/runtime.ts';

test('group definitions and profile patches are name-keyed maps, never legacy arrays', async () => {
  const schema = JSON.parse(await readFile(new URL('../schema.json', import.meta.url), 'utf8')) as object;
  const validate = new Ajv({ strict: false }).compile(schema);
  const valid = { groups: { workers: {} }, profiles: { work: { groups: { workers: { agent: { temperature: 0 } } } } } };
  assert.equal(validate(valid), true, JSON.stringify(validate.errors));
  assert.deepEqual(readCompositionDocument({}), { groups: {}, profiles: {} });
  assert.doesNotThrow(() => readCompositionDocument(valid));
  for (const invalid of [
    { groups: [] },
    { groups: [{ name: 'workers' }] },
    { groups: { workers: { name: 'workers' } } },
    { groups: { workers: {} }, profiles: { work: { groups: [] } } },
    { groups: { workers: {} }, profiles: { work: { groups: [{ name: 'workers' }] } } },
    { groups: { workers: {} }, profiles: { work: { groups: { workers: { name: 'workers' } } } } },
    { groups: { '': {} } },
    { groups: { ' ': {} } },
    { groups: { '\0': {} } },
  ]) {
    assert.equal(validate(invalid), false, JSON.stringify(invalid));
    assert.throws(() => readCompositionDocument(invalid), Error, JSON.stringify(invalid));
  }
  assert.throws(() => readCompositionDocument({ profiles: { work: { groups: { absent: {} } } } }), /Unknown group/);
  assert.throws(() => parseConfiguration('{"groups":{"workers":{},"workers":{}}}'), /duplicate JSON/);
});

test('definition map insertion order never changes agent-owned ordered precedence', () => {
  const groups = { first: { agent: { temperature: 0.1 } }, last: { agent: { temperature: 0.2 } } };
  const patches = { last: { agent: { temperature: 0.3 } }, first: { agent: { temperature: 0.4 } } };
  const native = { agent: { forward: { groups: ['first', 'last'] }, reverse: { groups: ['last', 'first'] } } };
  for (const root of [groups, Object.fromEntries(Object.entries(groups).reverse())]) {
    for (const profile of [patches, Object.fromEntries(Object.entries(patches).reverse())]) {
      const document = readCompositionDocument({ groups: root, profiles: { selected: { groups: profile } } });
      const result = resolveComposition(document, 'selected', native, {});
      assert.equal(result.agent.forward.temperature, 0.3);
      assert.equal(result.agent.reverse.temperature, 0.4);
      assert.equal(
        result.decisions['/agent/forward/temperature'].origin.pointer,
        '/profiles/selected/groups/last/agent/temperature',
      );
      assert.equal(
        result.decisions['/agent/reverse/temperature'].origin.pointer,
        '/profiles/selected/groups/first/agent/temperature',
      );
    }
  }
});

test('exact group keys include prototype-like names and produce escaped provenance pointers', () => {
  const document = readCompositionDocument(
    parseConfiguration(
      '{"groups":{"__proto__":{"agent":{"temperature":0.1}},"constructor":{},"a/b~c":{"agent":{"temperature":0.2}}},"profiles":{"selected":{"groups":{"constructor":{"agent":{"temperature":0.3}},"a/b~c":{"agent":{"temperature":0.4}}}}}}',
    ),
  );
  const native = { agent: { worker: { groups: ['__proto__', 'constructor', 'a/b~c'] } } };
  const shared = resolveComposition(document, null, native, {});
  assert.equal(shared.agent.worker.temperature, 0.2);
  assert.equal(shared.decisions['/agent/worker/temperature'].origin.pointer, '/groups/a~1b~0c/agent/temperature');
  const selected = resolveComposition(document, 'selected', native, {});
  assert.equal(selected.agent.worker.temperature, 0.4);
  assert.equal(
    selected.decisions['/agent/worker/temperature'].origin.pointer,
    '/profiles/selected/groups/a~1b~0c/agent/temperature',
  );
  assert.throws(
    () => resolveComposition(readCompositionDocument({}), null, { agent: { worker: { groups: ['constructor'] } } }, {}),
    /unknown group/i,
  );
});
