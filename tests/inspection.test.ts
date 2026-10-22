import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Inspection, appliedProfile, inspectionAgents } from '../src/config-composer/tui/inspection.ts';
import { sameConfigurationValue } from '../src/config-composer/composition/runtime-baseline.ts';

test('profile label uses only the applied marker and remains safe for reactive proxies', () => {
  const marker = {
    version: 2,
    status: 'applied',
    location: { directory: '/project', root: '/project' },
    revision: { effective: 'applied-revision' },
    candidate: { profile: 'Primary' as string | null },
    selection: { choice: 'different-saved-choice' },
  };
  const config = new Proxy({ plugin: [['composer', { __configComposerRuntime: marker }]] }, {});
  const read = () => appliedProfile(config, '/project', '/project');
  assert.equal(read(), 'Primary');
  marker.candidate.profile = null;
  assert.equal(read(), 'Shared only');
  marker.status = 'error';
  assert.equal(read(), undefined);
  marker.status = 'applied';
  assert.equal(appliedProfile(config, '/other', '/other'), undefined);
  assert.equal(appliedProfile({}, '/project', '/project'), undefined);
});
test('native classification wins over names, hidden is independent and absent built-ins use names', () => {
  const snapshot = {
    config: { agent: { plan: { disable: true }, custom: { hidden: true } } },
    agents: [
      { name: 'renamed-build', native: true },
      { name: 'build', native: false },
      { name: 'custom', hidden: true, native: false },
    ],
  } as unknown as Inspection;
  assert.deepEqual(inspectionAgents(snapshot, false), ['build', 'custom']);
  assert.deepEqual(inspectionAgents(snapshot, true), ['build', 'custom', 'plan', 'renamed-build']);
});
test('attribution comparison preserves permission pattern and custom-tool rule order', () => {
  assert.equal(
    sameConfigurationValue(
      'permission',
      { bash: { '*': 'ask', 'git *': 'allow' } },
      { bash: { 'git *': 'allow', '*': 'ask' } },
    ),
    false,
  );
  assert.equal(
    sameConfigurationValue('permission', { '*': 'ask', custom: 'allow' }, { custom: 'allow', '*': 'ask' }),
    false,
  );
  assert.equal(
    sameConfigurationValue('permission', { read: 'allow', edit: 'deny' }, { edit: 'deny', read: 'allow' }),
    false,
  );
  assert.equal(
    sameConfigurationValue('permission', { read: 'deny', '*': 'allow' }, { '*': 'allow', read: 'deny' }),
    false,
  );
  assert.equal(sameConfigurationValue('options', { a: false, b: 0 }, { b: 0, a: false }), true);
});
