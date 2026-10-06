import assert from 'node:assert/strict';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import {
  type PermissionPolicy,
  composePermissions,
  explainPermission,
} from '../src/config-composer/composition/permissions.ts';

test('adversarial valid globs finish within a bounded subprocess instead of stalling compilation', () => {
  const module = new URL('../src/config-composer/composition/permissions.ts', import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--input-type=module',
      '-e',
      `import { compilePermissions } from ${JSON.stringify(module)}; compilePermissions([{['*a'.repeat(25)+'b']:'deny'},{['a'.repeat(80)]:'allow'}]);`,
    ],
    { timeout: 1500, encoding: 'utf8' },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});
test('later wildcard allow wins', () => {
  const policy = composePermissions([{ bash: { 'git *': 'deny' } }, { bash: { '*': 'allow' } }]);
  assert.deepEqual(Object.keys(policy.bash), ['git *', '*']);
  assert.equal(explainPermission(policy, 'bash', 'git status').action, 'allow');
});

test('reverse order and exact-key reinsertion preserve last matching rule', () => {
  const policy = composePermissions([{ bash: { '*': 'allow' } }, { bash: { 'git *': 'deny' } }]);
  assert.equal(explainPermission(policy, 'bash', 'git status').action, 'deny');
  const reinserted = composePermissions([
    { bash: { 'git *': 'deny', 'npm *': 'ask', '*': 'deny' } },
    { bash: { 'git *': 'allow' } },
  ]);
  assert.deepEqual(Object.keys(reinserted.bash), ['npm *', '*', 'git *']);
  assert.deepEqual(explainPermission(reinserted, 'bash', 'git'), {
    action: 'allow',
    matched: { permission: 'bash', pattern: 'git *' },
  });
});

test('scalar contributions remain fallbacks beneath later partial maps', () => {
  const first = { bash: { 'git *': 'deny' as const } };
  assert.deepEqual(composePermissions([first, { bash: 'allow' }]), { bash: 'allow' });
  assert.deepEqual(composePermissions([{ bash: 'deny' }, { bash: { 'git *': 'allow' } }]), {
    bash: { '*': 'deny', 'git *': 'allow' },
  });
  const result = composePermissions([first]);
  assert.notEqual(result.bash, first.bash);
  assert.deepEqual(first, { bash: { 'git *': 'deny' } });
});

test('outer wildcard remains later than an earlier rule in a subsequently mentioned tool', () => {
  assert.equal(
    explainPermission(composePermissions([{ bash: 'deny' }, { '*': 'allow' }]), 'bash', 'git').action,
    'allow',
  );
  assert.equal(
    explainPermission(composePermissions([{ '*': 'allow' }, { bash: 'deny' }]), 'bash', 'git').action,
    'deny',
  );
  const policy = composePermissions([{ bash: { 'git *': 'deny' }, '*': 'allow' }, { bash: { 'npm *': 'ask' } }]);
  assert.deepEqual(Object.keys(policy), ['*', 'bash']);
  assert.equal(explainPermission(policy, 'bash', 'git').action, 'allow');
  assert.equal(explainPermission(policy, 'bash', 'npm install').action, 'ask');
  assert.deepEqual(explainPermission({}, 'bash', 'git'), { fallback: 'native' });
});

test('explanation follows native wildcard, path normalization and home expansion', () => {
  const policy = {
    'ba?': { 'a.b': 'deny' as const, 'line*': 'allow' as const },
    read: { '~/file': 'allow' as const, '$HOME/other': 'deny' as const },
  };
  assert.equal(explainPermission(policy, 'bat', 'a.b').action, 'deny');
  assert.equal(explainPermission(policy, 'bat', 'axb').action, undefined);
  assert.equal(explainPermission(policy, 'bat', 'line\nbreak').action, 'allow');
  assert.equal(explainPermission(policy, 'read', join(homedir(), 'file')).action, 'allow');
  assert.equal(explainPermission(policy, 'read', join(homedir(), 'other').replaceAll('/', '\\')).action, 'deny');
});

test('strict layers preserve earlier group matches and only then use global fallback', () => {
  const policy = composePermissions([
    { skill: { '*': 'deny' }, read: 'ask' },
    { skill: 'allow' },
    { skill: { 'other-*': 'deny' } },
  ]);
  assert.equal(explainPermission(policy, 'skill', 'included-skill').action, 'allow');
  assert.equal(explainPermission(policy, 'skill', 'other-skill').action, 'deny');
  assert.equal(explainPermission(policy, 'read', 'notes.txt').action, 'ask');
  assert.deepEqual(explainPermission(policy, 'bash', 'git status'), { fallback: 'native' });
});

test('interleaved wildcard tool contributions preserve their own order and exact tool exceptions', () => {
  const policy = composePermissions([
    { 'mcp_*': { a: 'deny' }, bash: { 'git *': 'deny' } },
    { '*': 'allow' },
    { 'mcp_*': { b: 'ask' }, bash: { 'npm *': 'ask' } },
  ]);
  assert.equal(explainPermission(policy, 'mcp_future_tool', 'a').action, 'allow');
  assert.equal(explainPermission(policy, 'mcp_future_tool', 'b').action, 'ask');
  assert.equal(explainPermission(policy, 'bash', 'git status').action, 'allow');
  assert.equal(explainPermission(policy, 'bash', 'npm install').action, 'ask');
});

test('scalar-only native keys retain their position between wildcard contributions', () => {
  const policy = composePermissions([
    { 'webfetch*': { a: 'deny' } },
    { webfetch: 'allow' },
    { 'webfetch*': { b: 'ask' } },
  ]);
  assert.equal(policy.webfetch, 'allow');
  assert.equal(explainPermission(policy, 'webfetch', 'a').action, 'allow');
  assert.equal(explainPermission(policy, 'webfetch', 'b').action, 'ask');
  assert.equal(explainPermission(policy, 'webfetch_extra', 'a').action, 'deny');
});

test('compiler never broadens an unsupported repeated question wildcard to a star', () => {
  assert.throws(
    () => composePermissions([{ 'webfetc?': { a: 'deny' } }, { webfetch: 'allow' }, { 'webfetc?': { b: 'deny' } }]),
    /unsupported permission compilation.*webfetc\?/i,
  );
  const policy = composePermissions([{ 'ba?': { a: 'deny' } }, { 'ba?': { b: 'allow' } }]);
  assert.equal(explainPermission(policy, 'bat', 'a').action, 'deny');
  assert.equal(explainPermission(policy, 'bat', 'b').action, 'allow');
});

test('repeated question globs replay intervening rules covering their whole domain', () => {
  for (const middle of ['*', '**', 'b*', '?a?', 'ba*']) {
    const layers: PermissionPolicy[] = [
      { 'ba?': { a: 'deny', retained: 'ask' } },
      { [middle]: { a: 'allow' } },
      { 'ba?': { b: 'ask' } },
      { '*': { c: 'deny' } },
      { 'ba?': { d: 'allow' } },
    ];
    const policy = composePermissions(layers);
    for (const name of ['bat', 'bar', 'ba', 'bath', 'other']) {
      for (const target of ['a', 'b', 'c', 'd', 'retained', 'unknown']) {
        assert.equal(
          explainPermission(policy, name, target).action,
          layers.map((layer) => explainPermission(layer, name, target).action).findLast((value) => value !== undefined),
          JSON.stringify({ middle, name, target }),
        );
      }
    }
  }
  const policy = composePermissions([{ 'ba?': { a: 'deny' } }, { '*': 'allow' }, { 'ba?': { b: 'ask' } }]);
  assert.equal(explainPermission(policy, 'bat', 'a').action, 'allow');
  assert.equal(explainPermission(policy, 'bat', 'b').action, 'ask');
});

test('optional trailing name glob replays universal partial maps without losing its bare-name match', () => {
  const layers: PermissionPolicy[] = [
    { 'skill *': { a: 'deny', retained: 'ask' } },
    { '*': { a: 'allow' } },
    { 'skill *': { b: 'deny' } },
  ];
  const policy = composePermissions(layers);
  for (const name of ['skill', 'skill extra', 'skills', 'skillx', 'other']) {
    for (const target of ['a', 'b', 'retained', 'unknown']) {
      assert.equal(
        explainPermission(policy, name, target).action,
        layers.map((layer) => explainPermission(layer, name, target).action).findLast((value) => value !== undefined),
        JSON.stringify({ name, target }),
      );
    }
  }
});

test('partial-domain overlaps still reject without broadening', () => {
  for (const middle of ['b?t', 'ba', 'ba?x', 'b*t']) {
    const layers: PermissionPolicy[] = [{ 'ba?': { a: 'deny' } }, { [middle]: 'allow' }, { 'ba?': { b: 'ask' } }];
    if (middle === 'ba' || middle === 'ba?x') {
      // Disjoint names are safe and must not acquire the moved block's rules.
      assert.equal(explainPermission(composePermissions(layers), middle, 'a').action, 'allow');
    } else {
      assert.throws(() => composePermissions(layers), /Unsupported permission compilation/);
    }
  }
});

test('compiled policies agree with last matching authored layers across tool and target overlaps', () => {
  const candidates: PermissionPolicy[] = [
    { bash: { 'git *': 'deny' } },
    { '*': { '*': 'allow' } },
    { bash: { 'npm *': 'ask' } },
    { 'mcp_*': { '*': 'deny' } },
    { 'mcp_*': { read: 'allow' } },
    { '**': { read: 'ask' } },
    { webfetch: 'allow' },
    { 'web*': { read: 'deny' } },
    { skill: 'allow' },
    { skill: { 'other-*': 'deny' } },
  ];
  for (const first of candidates) {
    for (const second of candidates) {
      for (const third of candidates) {
        const layers = [first, second, third];
        const policy = composePermissions(layers);
        for (const permission of ['bash', 'mcp_future', 'webfetch', 'skill', 'unknown']) {
          for (const pattern of ['git status', 'npm install', 'read', 'other-skill']) {
            const expected = layers
              .map((layer) => explainPermission(layer, permission, pattern).action)
              .findLast((value) => value !== undefined);
            assert.equal(
              explainPermission(policy, permission, pattern).action,
              expected,
              JSON.stringify({ layers, permission, pattern }),
            );
          }
        }
      }
    }
  }
});
