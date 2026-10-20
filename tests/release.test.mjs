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

test('manual lifecycle scopes writes and orders verify, prepare, npm, attachment and release publication', async () => {
  const { readFile } = await import('node:fs/promises');
  const { parse } = await import('yaml');
  const workflow = parse(await readFile(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.jobs.prepare.needs, 'verify');
  assert.deepEqual(workflow.jobs.prepare.permissions, { contents: 'write' });
  assert.deepEqual(workflow.jobs.publish.needs, ['verify', 'prepare']);
  assert.deepEqual(workflow.jobs.publish.permissions, { contents: 'read', 'id-token': 'write' });
  assert.deepEqual(workflow.jobs.attach.needs, ['verify', 'publish']);
  assert.deepEqual(workflow.jobs.attach.permissions, { contents: 'write' });
  for (const [job, stage] of [
    ['prepare', 'prepare'],
    ['publish', 'npm'],
    ['attach', 'finish'],
  ]) {
    const steps = workflow.jobs[job].steps;
    const checkout = steps.findIndex((step) => step.uses?.startsWith('actions/checkout@'));
    assert.equal(steps[checkout].with.ref, '${{ github.workflow_sha }}');
    assert.equal(steps[checkout].with['persist-credentials'], false);
    const operation = steps.find((step) => step.run === `node scripts/release-lifecycle.mjs ${stage}`);
    assert.equal(operation.env.RELEASE_COMMIT, '${{ needs.verify.outputs.commit }}');
    assert.equal(operation.env.NPM_PACKAGE_NAME, '${{ needs.verify.outputs.name }}');
    if (stage !== 'prepare') {
      assert.ok(steps.findIndex((step) => step.uses?.startsWith('actions/download-artifact@')) > checkout);
    }
  }
  assert.equal(workflow.jobs.verify.outputs.commit, '${{ github.sha }}');
  assert.ok(workflow.jobs.verify.steps.some((step) => step.run?.includes('cmp release/*.tgz repeated-pack/*.tgz')));
});
