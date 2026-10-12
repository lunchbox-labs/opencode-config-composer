import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editorErrorText } from '../src/config-composer/tui/editor-error.ts';
import { SettingsError } from '../src/config-composer/settings.ts';

test('editor diagnostics preserve source locations and newlines, bound text and strip terminal controls', () => {
  const message = '/imports/team/config.jsonc:12 /profiles/work\nInvalid model\u001b[31m\u0007' + 'x'.repeat(10000);
  const result = editorErrorText(new SettingsError(message));
  assert.match(result, /^\/imports\/team\/config.jsonc:12 \/profiles\/work\nInvalid model/);
  assert.ok(result.length <= 6020);
  assert.match(result, /truncated/);
  assert.equal(result.includes('\u001b') || result.includes('\u0007'), false);
});

test('editor diagnostics redact credential assignments and URL credentials before truncation', () => {
  const result = editorErrorText(
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
  const result = editorErrorText(new Error('secret internal payload'));
  assert.equal(result, 'Could not update settings. Check the files and server connection.');
  assert.equal(editorErrorText({ apiKey: 'secret' }), result);
});
