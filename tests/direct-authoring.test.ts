import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readCompositionDocument } from '../src/config-composer/composition/document.ts';
import { parseConfiguration } from '../src/config-composer/configuration.ts';
import * as authoring from '../src/config-composer/composition/authoring.ts';

const source = `{
  // retain shared policy
  "groups": [
    {"name":"workers","members":{"agent":["worker","helper"]},"agent":{"permission":{"edit":"deny"}}},
    {"name":"reviewers","members":{"agent":["worker"]},"agent":{"temperature":0.2}}
  ],
  // retain profile note
  "defaultProfile":"a",
  "profiles":{"a":{"groups":[{"name":"reviewers"},{"name":"workers"}]},"b":{}}
}\n`;
const doc = (text: string) => readCompositionDocument(parseConfiguration(text));
test('direct settings preserve comments and isolate shared versus named profile targets', () => {
  const shared = authoring.setSetting(source, { kind: 'agent', group: 'workers' }, 'temperature', 0);
  const profile = authoring.setSetting(shared, { profile: 'a', kind: 'agent', group: 'workers' }, 'options', {});
  const named = authoring.setSetting(profile, { profile: 'b', kind: 'command', name: 'review' }, 'subtask', false);
  assert.match(named, /retain shared policy/);
  assert.match(named, /retain profile note/);
  const parsed = doc(named) as {
    groups: { agent: object }[];
    profiles: Record<string, { groups?: { agent?: object }[]; command?: object }>;
  };
  assert.deepEqual(parsed.groups[0].agent, { permission: { edit: 'deny' }, temperature: 0 });
  assert.deepEqual(parsed.profiles.a.groups?.[1].agent, { options: {} });
  assert.deepEqual(parsed.profiles.b.command, { review: { subtask: false } });
});
test('inherit removes only the authored field while variant Default remains an empty string', () => {
  const target = { kind: 'agent' as const, name: 'worker' };
  let text = authoring.setSetting(source, target, 'variant', '');
  assert.deepEqual(doc(text).agent, { worker: { variant: '' } });
  text = authoring.setSetting(text, target, 'variant', undefined);
  assert.deepEqual(doc(text).agent, { worker: {} });
  assert.throws(
    () => authoring.setSetting(text, { kind: 'command', name: 'review' }, 'variant', 'high'),
    /Unknown key/,
  );
  assert.throws(() => authoring.setSetting(text, target, 'topK', 1), /Unknown key/);
});
test('profile rename updates default and preserves its original commented body', () => {
  const text = authoring.renameProfile(source.replace('"a":{"groups"', '"a":{/* inside */"groups"'), 'a', 'mixed');
  assert.match(text, /inside/);
  const parsed = doc(text);
  assert.equal(parsed.defaultProfile, 'mixed');
  assert.equal(Object.hasOwn(parsed.profiles as object, 'a'), false);
  assert.throws(() => authoring.renameProfile(source, 'a', 'b'), /already exists/);
  assert.equal(doc(authoring.deleteProfile(text, 'mixed')).defaultProfile, undefined);
});
test('group rename/delete updates every profile reference; root and profile reorders are independent', () => {
  let text = authoring.renameGroup(source, 'workers', 'team');
  let parsed = doc(text);
  assert.equal(parsed.groups[0].name, 'team');
  assert.equal(parsed.profiles.a.groups![1].name, 'team');
  text = authoring.moveGroup(text, 'team', 1);
  parsed = doc(text);
  assert.deepEqual(
    parsed.groups.map((g) => g.name),
    ['reviewers', 'team'],
  );
  assert.deepEqual(
    parsed.profiles.a.groups!.map((g) => g.name),
    ['reviewers', 'team'],
  );
  text = authoring.moveGroup(text, 'team', -1, 'a');
  parsed = doc(text);
  assert.deepEqual(
    parsed.groups.map((g) => g.name),
    ['reviewers', 'team'],
  );
  assert.deepEqual(
    parsed.profiles.a.groups!.map((g) => g.name),
    ['team', 'reviewers'],
  );
  parsed = doc(authoring.deleteGroup(text, 'team'));
  assert.deepEqual(
    parsed.profiles.a.groups!.map((g) => g.name),
    ['reviewers'],
  );
});
test('creation, staged membership, bulk concrete assignments and global destinations stay narrow', () => {
  let text = authoring.createProfile(source, 'mixed');
  text = authoring.createGroup(text, 'builders', { agent: ['build'] });
  text = authoring.setMembers(text, 'builders', { agent: ['build', 'worker'] });
  text = authoring.assignGroupModels(text, 'mixed', ['builders', 'workers'], 'fixture/beta', '');
  text = authoring.setGlobal(text, undefined, 'model', 'fixture/alpha');
  text = authoring.setGlobal(text, 'mixed', 'small_model', 'fixture/beta');
  const parsed = doc(text) as { model: string; profiles: Record<string, { small_model: string; groups: object[] }> };
  assert.equal(parsed.model, 'fixture/alpha');
  assert.equal(parsed.profiles.mixed.small_model, 'fixture/beta');
  assert.deepEqual(parsed.profiles.mixed.groups, [
    { name: 'builders', agent: { model: 'fixture/beta', variant: '' } },
    { name: 'workers', agent: { model: 'fixture/beta', variant: '' } },
  ]);
  assert.throws(() => authoring.setMembers(text, 'builders', {}), /At least one/);
});
