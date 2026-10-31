import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateRelease } from '../scripts/validate-release.mjs';

const release = {
  name: '@lunchbox-labs/opencode-config-composer',
  version: '1.2.3',
  repository: { url: 'git+https://github.com/lunchbox-labs/opencode-config-composer.git' },
  publishConfig: { access: 'public' },
};

test('release validation accepts explicit public and scoped restricted stable releases', () => {
  assert.deepEqual(validateRelease(release, 'v1.2.3'), { name: release.name, version: '1.2.3', access: 'public' });
  assert.equal(validateRelease({ ...release, publishConfig: { access: 'restricted' } }, 'v1.2.3').access, 'restricted');
});

test('release validation rejects private, provisional, mismatched, prerelease, and misrouted packages', () => {
  for (const change of [
    { private: true },
    { private: 'false' },
    { name: 'package-name-tbd' },
    { name: 'invalid name' },
    { name: 'opencode-config-composer' },
    { name: '@other/opencode-config-composer' },
    { version: '0.0.0' },
    { version: '1.2.3-beta.1' },
    { version: '01.2.3' },
    { publishConfig: undefined },
    { publishConfig: { access: 'other' } },
    { name: 'unscoped', publishConfig: { access: 'restricted' } },
    { publishConfig: { access: 'public', registry: 'https://example.invalid' } },
    { repository: { url: 'git+https://github.com/example/other.git' } },
  ]) {
    assert.throws(() => validateRelease({ ...release, ...change }, 'v1.2.3'));
  }
  for (const tag of [undefined, '1.2.3', 'v1.2.4', 'main', 'v1.2.3;echo unexpected']) {
    assert.throws(() => validateRelease(release, tag), /release tag/);
  }
});

test('release publication verifies the tagged main commit and publishes only through npm OIDC', async () => {
  const { readFile } = await import('node:fs/promises');
  const { parse } = await import('yaml');
  const source = await readFile(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');
  const workflow = parse(source);
  assert.deepEqual(workflow.on, { release: { types: ['published'] } });
  assert.ok(!source.includes('workflow_dispatch'));
  assert.ok(!source.includes('inputs.'));
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  const verify = workflow.jobs.verify;
  assert.ok(verify.steps.some((step) => step.run === 'npm ci'));
  assert.equal(
    verify.if.replace(/\s+/g, ' ').trim(),
    "github.repository == 'lunchbox-labs/opencode-config-composer' && github.event_name == 'release' && !github.event.release.prerelease",
  );
  assert.equal(verify.env.RELEASE_TAG, '${{ github.event.release.tag_name }}');
  const checkout = verify.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, 'refs/tags/${{ github.event.release.tag_name }}');
  assert.equal(checkout.with['persist-credentials'], false);
  assert.ok(
    verify.steps.some((step) => step.run?.includes('git merge-base --is-ancestor HEAD refs/remotes/origin/main')),
  );
  assert.ok(verify.steps.some((step) => step.run === 'node scripts/validate-release.mjs'));
  assert.ok(verify.steps.some((step) => step.run === 'npm run check'));
  assert.ok(verify.steps.some((step) => step.run === 'npm run test:native'));
  const upload = verify.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
  const publish = workflow.jobs.publish;
  const download = publish.steps.find((step) => step.uses?.startsWith('actions/download-artifact@'));
  assert.equal(download.with.name, upload.with.name, 'publish consumes the verified artifact');
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.equal(publish.needs, 'verify');
  assert.equal(publish.environment, 'npm');
  assert.deepEqual(publish.permissions, { contents: 'read', 'id-token': 'write' });
  const operation = publish.steps.find((step) => step.run?.includes('npm publish'));
  assert.match(operation.run, /sha256sum --check SHA256SUMS/);
  assert.equal(operation.env.NPM_ACCESS, '${{ needs.verify.outputs.access }}');
  assert.ok(!source.includes('secrets.'));
  assert.ok(!source.includes('vars.'));
  const allowedActions = [
    'actions/checkout@',
    'actions/setup-node@',
    'actions/upload-artifact@',
    'actions/download-artifact@',
  ];
  for (const job of Object.values(workflow.jobs)) {
    if (job !== publish) {
      assert.notEqual(job.permissions, 'write-all', 'other jobs must not receive implicit OIDC write permission');
      assert.equal(job.environment, undefined, 'only the verified publish job may enter a release environment');
      assert.notEqual(job.permissions?.['id-token'], 'write', 'only the verified publish job may mint OIDC tokens');
      assert.ok(
        job.steps.every((step) => !/\bnpm\s+publish\b/.test(step.run ?? '')),
        'package publication must use the verified artifact handoff',
      );
    }
    for (const step of job.steps) {
      if (step.uses) {
        assert.ok(allowedActions.some((action) => step.uses.startsWith(action)));
        assert.match(step.uses, /@[a-f0-9]{40}$/, 'release actions must use immutable commit pins');
      }
    }
  }
});
