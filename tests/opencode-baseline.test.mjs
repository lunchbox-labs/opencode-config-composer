import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateBaseline, validateCliVersion, validateTestVersion } from '../scripts/opencode.mjs';

function fixture() {
  const manifest = {
    engines: { opencode: '1.2.x' },
    opencodeTestVersion: '1.2.3',
    devDependencies: { '@opencode-ai/plugin': '4.5.6', '@opencode-ai/sdk': '7.8.9' },
  };
  const lock = {
    packages: {
      '': structuredClone(manifest),
      'node_modules/@opencode-ai/plugin': { version: '4.5.6' },
      'node_modules/@opencode-ai/sdk': { version: '7.8.9' },
    },
  };
  return { manifest, lock };
}

test('the CLI baseline and independently pinned host libraries can use different versions', () => {
  const { manifest, lock } = fixture();
  assert.equal(validateBaseline(manifest, lock), '1.2.3');
});

test('a range or a stale lockfile cannot select the tested CLI', () => {
  const { manifest, lock } = fixture();
  manifest.opencodeTestVersion = '^1.2.3';
  assert.throws(() => validateBaseline(manifest, lock), /exact stable CLI version/);
  manifest.opencodeTestVersion = '1.3.0';
  assert.throws(() => validateBaseline(manifest, lock), /outside the supported host range|lockfile host range differs/);
});

test('host library drift is rejected without treating its version as a CLI release', () => {
  const { manifest, lock } = fixture();
  lock.packages['node_modules/@opencode-ai/sdk'].version = '7.8.10';
  assert.throws(() => validateBaseline(manifest, lock), /@opencode-ai\/sdk locked version differs/);
});

test('native checks require the actual binary to report the declared CLI baseline', () => {
  validateCliVersion('1.2.3\n', '1.2.3');
  assert.throws(() => validateCliVersion('4.5.6\n', '1.2.3'), /native OpenCode binary differs/);
});

test('supported patch boundaries include the floor and latest and exclude adjacent minors', () => {
  for (const version of ['1.19.0', '1.19.3']) {
    assert.equal(validateTestVersion(version, '1.19.x'), version);
  }
  for (const version of ['1.18.34', '1.20.0']) {
    assert.throws(() => validateTestVersion(version, '1.19.x'), /outside the supported host range/);
  }
});
