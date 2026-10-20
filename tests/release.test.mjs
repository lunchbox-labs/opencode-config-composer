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

test('release attachment runs after publication with isolated write permission and verified identity', async () => {
  const { readFile } = await import('node:fs/promises');
  const { parse } = await import('yaml');
  const workflow = parse(await readFile(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  const steps = workflow.jobs.publish.steps;
  const checkoutIndex = steps.findIndex((step) => step.uses?.startsWith('actions/checkout@'));
  const downloadIndex = steps.findIndex((step) => step.uses?.startsWith('actions/download-artifact@'));
  assert.ok(checkoutIndex >= 0 && checkoutIndex < downloadIndex);
  const preflight = steps.findIndex((step) => step.run === 'node scripts/attach-published-tarball.mjs --preflight');
  const publish = steps.findIndex((step) => step.run?.includes('npm publish'));
  assert.ok(preflight >= 0 && preflight < publish);
  assert.equal(steps[preflight].env.GH_TOKEN, '${{ github.token }}');
  assert.equal(steps[publish].env.GH_TOKEN, undefined);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(workflow.jobs.publish.permissions.contents, 'read');
  assert.deepEqual(workflow.jobs.attach.needs, ['verify', 'publish']);
  assert.deepEqual(workflow.jobs.attach.permissions, { contents: 'write' });
  const checkout = workflow.jobs.attach.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, '${{ github.workflow_sha }}');
  assert.equal(checkout.with['persist-credentials'], false);
  const attachment = workflow.jobs.attach.steps.find(
    (step) => step.run === 'node scripts/attach-published-tarball.mjs',
  );
  assert.equal(attachment.env.NPM_PACKAGE_NAME, '${{ needs.verify.outputs.name }}');
  assert.equal(attachment.env.NPM_PACKAGE_VERSION, '${{ needs.verify.outputs.version }}');
  assert.equal(workflow.jobs.verify.outputs.name, '${{ steps.release.outputs.name }}');
  assert.equal(workflow.jobs.verify.outputs.version, '${{ steps.release.outputs.version }}');
});
