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
  assert.equal(workflow.name, 'Publish');
  assert.deepEqual(workflow.on, { workflow_dispatch: null });
  assert.equal(workflow['run-name'], undefined);
  assert.equal(workflow.jobs.prepare.name, 'Prepare ${{ needs.verify.outputs.tag }}');
  assert.equal(workflow.jobs.publish.name, 'Publish npm ${{ needs.verify.outputs.tag }}');
  assert.equal(workflow.jobs.attach.name, 'Publish GitHub ${{ needs.verify.outputs.tag }}');
  assert.equal(workflow.jobs.verify.env, undefined);
  assert.equal(workflow.jobs.verify.outputs.tag, '${{ steps.release.outputs.tag }}');
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.jobs.prepare.needs, 'verify');
  assert.deepEqual(workflow.jobs.prepare.permissions, { contents: 'read' });
  assert.deepEqual(workflow.jobs.publish.needs, ['verify', 'prepare']);
  assert.deepEqual(workflow.jobs.publish.permissions, { contents: 'read', 'id-token': 'write' });
  assert.deepEqual(workflow.jobs.attach.needs, ['verify', 'publish']);
  assert.deepEqual(workflow.jobs.attach.permissions, { contents: 'read' });
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
    assert.equal(operation.env.RELEASE_TAG, '${{ needs.verify.outputs.tag }}');
    assert.equal(operation.env.RELEASE_COMMIT, '${{ needs.verify.outputs.commit }}');
    assert.equal(operation.env.NPM_PACKAGE_NAME, '${{ needs.verify.outputs.name }}');
    if (stage !== 'prepare') {
      assert.ok(steps.findIndex((step) => step.uses?.startsWith('actions/download-artifact@')) > checkout);
    }
  }
  assert.equal(workflow.jobs.verify.outputs.commit, '${{ github.sha }}');
  assert.ok(workflow.jobs.verify.steps.some((step) => step.run?.includes('cmp release/*.tgz repeated-pack/*.tgz')));
});

test('release CLI derives its tag from package.json without a tag input', async (t) => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = await mkdtemp(join(tmpdir(), 'release-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'output');
  await promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL('../scripts/validate-release.mjs', import.meta.url))],
    {
      env: { ...process.env, RELEASE_TAG: undefined, GITHUB_OUTPUT: output },
    },
  );
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL('../scripts/validate-release.mjs', import.meta.url))],
      {
        env: { ...process.env, RELEASE_TAG: 'v9.9.9', GITHUB_OUTPUT: output },
      },
    ),
    /release tag must equal/,
  );
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok((await readFile(output, 'utf8')).split('\n').includes(`tag=v${manifest.version}`));
});

test('App credentials are scoped only to just-in-time release API steps', async () => {
  const { readFile } = await import('node:fs/promises');
  const { parse } = await import('yaml');
  const source = await readFile(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');
  const workflow = parse(source);
  const action = 'actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510';
  assert.deepEqual(workflow.on, { workflow_dispatch: null });
  assert.equal(workflow.env, undefined);
  let tokenSteps = 0;
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    assert.equal(job.env, undefined);
    assert.ok(!JSON.stringify(job.outputs ?? {}).includes('app-token'));
    for (const [index, step] of job.steps.entries()) {
      const text = JSON.stringify(step);
      if (step.uses === action) {
        tokenSteps++;
        assert.ok(['prepare', 'attach'].includes(jobName));
        assert.equal(job.environment, 'release');
        assert.equal(step.id, 'app-token');
        assert.deepEqual(step.with, {
          'client-id': '${{ vars.LUNCHBOX_LABS_APP_CLIENT_ID }}',
          'private-key': '${{ secrets.LUNCHBOX_LABS_APP_PRIVATE_KEY }}',
          owner: '${{ github.repository_owner }}',
          repositories: '${{ github.event.repository.name }}',
          'permission-contents': 'write',
        });
        assert.match(job.steps[index + 1].run, /^node scripts\/release-lifecycle\.mjs (prepare|finish)$/);
        assert.equal(job.steps[index + 1].env.GH_TOKEN, '${{ steps.app-token.outputs.token }}');
      } else {
        assert.ok(!text.includes('LUNCHBOX_LABS_APP_'));
        if (text.includes('steps.app-token.outputs.token')) {
          assert.ok(['prepare', 'attach'].includes(jobName));
          assert.equal(job.steps[index - 1].uses, action);
          assert.ok(!step.uses);
        }
      }
    }
  }
  assert.equal(tokenSteps, 2);
  const npm = workflow.jobs.publish.steps.find((step) => step.run === 'node scripts/release-lifecycle.mjs npm');
  assert.equal(workflow.jobs.publish.environment, 'npm');
  assert.equal(workflow.jobs.verify.environment, undefined);
  assert.equal(npm.env.GH_TOKEN, '${{ github.token }}');
  assert.deepEqual(workflow.jobs.publish.permissions, { contents: 'read', 'id-token': 'write' });
});
