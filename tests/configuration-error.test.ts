import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configurationErrorText, inspectionText } from '../src/config-composer/tui/configuration-error.ts';
import { SettingsError } from '../src/config-composer/settings.ts';

test('configuration diagnostics preserve source locations and newlines, bound text and strip terminal controls', () => {
  const message = '/imports/team/config.jsonc:12 /profiles/work\nInvalid model\u001b[31m\u0007' + 'x'.repeat(10000);
  const result = configurationErrorText(new SettingsError(message));
  assert.match(result, /^\/imports\/team\/config.jsonc:12 \/profiles\/work\nInvalid model/);
  assert.ok(result.length <= 6020);
  assert.match(result, /truncated/);
  assert.equal(result.includes('\u001b') || result.includes('\u0007'), false);
});

test('configuration diagnostics redact credential assignments and URL credentials before truncation', () => {
  const result = configurationErrorText(
    new SettingsError(
      '/source.jsonc: apiKey="secret value"\nAuthorization: Bearer abc\n' +
        'https://alice:password@example.test/path?token=hidden&mode=safe\n' +
        'password=' +
        's'.repeat(7000),
    ),
  );
  assert.doesNotMatch(result, /secret value|Bearer abc|alice|password@example|hidden|s{10}/);
  assert.match(result, /redacted/);
  assert.match(result, /\/source.jsonc/);
});

test('unexpected failures expose no raw diagnostic payload or stack', () => {
  const result = configurationErrorText(new Error('secret internal payload'));
  assert.equal(result, 'Could not read or apply configuration. Check the files and server connection.');
  assert.equal(configurationErrorText({ apiKey: 'secret' }), result);
});

test('long diagnostics are divided into readable pages without dropping the final source segment', async () => {
  const { diagnosticPages } = await import('../src/config-composer/tui/configuration-error.ts');
  const message = '/imports/' + 'long-path/'.repeat(70) + 'source.jsonc:123\nFinal validation detail';
  const pages = diagnosticPages(message, 40, 5);
  assert.ok(pages.length > 1);
  assert.ok(pages.every((page) => page.split('\n').length <= 5));
  assert.ok(pages.every((page) => page.split('\n').every((line) => line.length <= 40)));
  assert.equal(pages.join('').replaceAll('\n', ''), message.replaceAll('\n', ''));
  assert.match(pages.at(-1)!, /Final validation detail/);
});

test('inspection preserves complete long values while retaining diagnostic sanitization', () => {
  const value = 'options: ' + 'x'.repeat(30000);
  assert.equal(inspectionText(value), value);
  assert.doesNotMatch(inspectionText('apiKey: secret\nvisible: 0'), /secret/);
});
