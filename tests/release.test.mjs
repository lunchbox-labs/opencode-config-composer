import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import jsYaml from 'js-yaml';
import { validateRelease } from '../scripts/validate-release.mjs';
import {
  main,
  maxConsecutiveErrors,
  pollIntervalMs,
  releaseCiState,
  waitForReleaseCi,
} from '../scripts/release-ci.mjs';

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
  const { default: jsYaml } = await import('js-yaml');
  const source = await readFile(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');
  const workflow = jsYaml.safeLoad(source);
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
  assert.ok(
    verify.steps.some(
      (step) => step.env?.WORKFLOW_COMMIT === '${{ github.sha }}' && step.run?.includes('git rev-parse HEAD'),
    ),
  );
  assert.ok(verify.steps.some((step) => step.run === 'node scripts/validate-release.mjs'));
  assert.ok(verify.steps.some((step) => step.run === 'npm run check'));
  assert.ok(verify.steps.some((step) => step.run === 'npm run test:native'));
  const upload = verify.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
  const publish = workflow.jobs.publish;
  const download = publish.steps.find((step) => step.uses?.startsWith('actions/download-artifact@'));
  assert.equal(download.with.name, upload.with.name, 'publish consumes the verified artifact');
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.deepEqual(publish.needs, ['checks', 'verify']);
  const checks = workflow.jobs.checks;
  assert.equal(checks.if, verify.if);
  assert.deepEqual(checks.permissions, { contents: 'read', actions: 'read' });
  const gate = checks.steps.find((step) => step.run === 'node scripts/release-ci.mjs');
  assert.deepEqual(gate.env.REQUIRED_WORKFLOWS.split(','), ['Check', 'Integration Tests']);
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

const REQUIRED = ['Check', 'Integration Tests'];
const TRIGGERING_WORKFLOWS = { Check: 'check.yml', 'Integration Tests': 'integration.yml' };
const parseYaml = (source) => jsYaml.safeLoad(source);

const sha = '0123456789abcdef0123456789abcdef01234567';
const runOf = (name, fields = {}) => ({
  id: 100,
  name,
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  run_attempt: 1,
  created_at: '2026-11-01T22:40:00Z',
  ...fields,
});
const passing = REQUIRED.map((name, index) => runOf(name, { id: 100 + index }));

test('release commit checks accept only the latest push run of every required workflow', () => {
  const [first] = REQUIRED;
  const others = passing.filter((run) => run.name !== first);
  const state = (runs) => releaseCiState([...others, ...runs], REQUIRED);
  assert.equal(state([runOf(first)]).state, 'success');
  assert.equal(state([runOf(first, { status: 'in_progress', conclusion: null })]).state, 'pending');
  assert.equal(releaseCiState([], REQUIRED).state, 'pending');
  assert.equal(state([runOf(first, { event: 'pull_request' })]).state, 'pending');
  assert.equal(
    state([runOf(first, { run_attempt: 2, status: 'in_progress', conclusion: null })]).state,
    'pending',
    'an in-progress re-run of the latest run keeps the gate pending',
  );
  const failed = state([
    runOf(first, { id: 900, conclusion: 'success', created_at: '2026-11-01T23:59:00Z' }),
    runOf(first, { id: 901, conclusion: 'failure', created_at: '2026-11-01T22:00:00Z' }),
  ]);
  assert.equal(failed.state, 'failure', 'the run with the highest id decides, whatever its created_at says');
  assert.match(failed.detail, new RegExp(`${first} \\(failure\\)`));
  assert.deepEqual(failed.cancelled, []);
  assert.equal(
    state([
      runOf(first, { id: 901, conclusion: 'success', created_at: '2026-11-01T22:00:00Z' }),
      runOf(first, { id: 900, conclusion: 'failure', created_at: '2026-11-01T23:59:00Z' }),
    ]).state,
    'success',
    'the run with the highest id decides, whatever its created_at says',
  );
  const cancelled = state([runOf(first, { conclusion: 'cancelled' })]);
  assert.equal(cancelled.state, 'failure');
  assert.deepEqual(cancelled.cancelled, [first]);
  assert.equal(state([runOf(first, { conclusion: 'skipped' })]).state, 'failure');
  assert.equal(
    releaseCiState([...passing, runOf('Unrelated', { id: 999, conclusion: 'failure' })], REQUIRED).state,
    'success',
    'workflows the gate does not require never decide it',
  );
  assert.equal(
    state([runOf('Unrelated', { id: 999 })]).state,
    'pending',
    'workflows the gate does not require never decide it',
  );
});

function fakeGitHub(replies) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    assert.ok(replies.length > 0, 'no reply left for this request');
    const reply = replies.shift();
    if (reply instanceof Error) {
      throw reply;
    }
    const { status = 200, headers = {}, runs = [] } = reply;
    return new Response(JSON.stringify({ workflow_runs: runs }), { status, headers });
  };
  return { fetch, requests, replies };
}

function fakeClock() {
  let time = Date.parse('2026-11-02T10:00:00Z');
  const sleeps = [];
  return {
    sleeps,
    now: () => time,
    sleep: async (ms) => {
      sleeps.push(ms);
      time += ms;
    },
  };
}

async function waitWith(replies, options = {}) {
  const github = fakeGitHub(replies);
  const clock = fakeClock();
  const logs = [];
  const outcome = await waitForReleaseCi({
    api: 'https://api.github.example',
    repository: 'lunchbox-labs/example',
    sha,
    token: 'test-token',
    required: REQUIRED,
    fetch: github.fetch,
    sleep: clock.sleep,
    now: clock.now,
    log: (line) => logs.push(line),
    ...options,
  });
  return { outcome, logs, requests: github.requests, sleeps: clock.sleeps };
}

const pendingRuns = passing.map((run, index) => (index === 0 ? { ...run, status: 'queued', conclusion: null } : run));

test("the release commit gate lists the commit's push runs with a request timeout", async () => {
  const { outcome, requests } = await waitWith([{ runs: passing }]);
  assert.equal(outcome, 'success');
  assert.equal(requests.length, 1);
  const url = new URL(requests[0].url);
  assert.equal(url.origin + url.pathname, 'https://api.github.example/repos/lunchbox-labs/example/actions/runs');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    head_sha: sha,
    event: 'push',
    per_page: '100',
  });
  assert.equal(requests[0].init.headers.authorization, 'Bearer test-token');
  assert.ok(requests[0].init.signal instanceof AbortSignal);
});

test('the release commit gate polls while runs are pending and stops on success', async () => {
  const { outcome, requests, sleeps, logs } = await waitWith([
    { runs: pendingRuns },
    { runs: pendingRuns },
    { runs: passing },
  ]);
  assert.equal(outcome, 'success');
  assert.equal(requests.length, 3);
  assert.deepEqual(sleeps, [pollIntervalMs, pollIntervalMs]);
  assert.match(logs.at(-1), /^Passed: /);
});

test('the release commit gate fails on a failed run and hints at re-running a cancelled one', async () => {
  const failed = await waitWith([{ runs: [{ ...passing[0], conclusion: 'failure' }, ...passing.slice(1)] }]);
  assert.equal(failed.outcome, 'failure');
  assert.deepEqual(failed.sleeps, []);
  assert.ok(!failed.logs.some((line) => line.startsWith('Hint:')));
  const cancelled = await waitWith([{ runs: [{ ...passing[0], conclusion: 'cancelled' }, ...passing.slice(1)] }]);
  assert.equal(cancelled.outcome, 'failure');
  assert.equal(cancelled.logs.at(-1), `Hint: re-run ${REQUIRED[0]} for the release commit, then re-run Publish.`);
});

test('the release commit gate times out at the deadline', async () => {
  const { outcome, requests, logs } = await waitWith(
    Array.from({ length: 10 }, () => ({ runs: pendingRuns })),
    { waitMinutes: 1 },
  );
  assert.equal(outcome, 'timeout');
  assert.equal(requests.length, 3, 'polls at 0, 30 and 60 seconds; the last one is at the deadline');
  assert.equal(logs.at(-1), 'Timed out waiting for the release commit checks.');
});

test('the release commit gate keeps waiting through transient API errors', async () => {
  const { outcome, requests, logs } = await waitWith([
    { status: 502 },
    new TypeError('fetch failed'),
    { status: 429 },
    { status: 403, headers: { 'retry-after': '60' } },
    { runs: pendingRuns },
    { status: 403, headers: { 'x-ratelimit-remaining': '0' } },
    new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    { status: 500 },
    { status: 503 },
    { runs: passing },
  ]);
  assert.equal(outcome, 'success');
  assert.equal(requests.length, 10);
  assert.equal(logs.filter((line) => line.endsWith('Polling again.')).length, 8);
});

test('the release commit gate fails after five consecutive transient errors', async () => {
  const { outcome, requests, logs } = await waitWith(Array.from({ length: 10 }, () => ({ status: 503 })));
  assert.equal(outcome, 'error');
  assert.equal(requests.length, maxConsecutiveErrors);
  assert.match(logs.at(-1), /Giving up after 5 consecutive errors\.$/);
});

test('the release commit gate fails at once on errors a retry cannot fix', async () => {
  for (const reply of [{ status: 404 }, { status: 401 }, { status: 403 }, { status: 422 }]) {
    const { outcome, requests, sleeps, logs } = await waitWith([reply, { runs: passing }]);
    assert.equal(outcome, 'error', String(reply.status));
    assert.equal(requests.length, 1);
    assert.deepEqual(sleeps, []);
    assert.equal(logs.at(-1), `Listing workflow runs failed with HTTP ${reply.status}.`);
  }
});

test('the release commit gate reads its settings from the environment', async () => {
  const env = {
    GITHUB_API_URL: 'https://api.github.example',
    GITHUB_REPOSITORY: 'lunchbox-labs/example',
    GITHUB_SHA: sha,
    GITHUB_TOKEN: 'test-token',
    REQUIRED_WORKFLOWS: REQUIRED.join(' , '),
  };
  const run = async (replies, overrides = {}) => {
    const github = fakeGitHub(replies);
    const clock = fakeClock();
    const ok = await main({ ...env, ...overrides }, { ...clock, fetch: github.fetch, log: () => {} });
    return { ok, requests: github.requests };
  };
  const passed = await run([{ runs: passing }]);
  assert.equal(passed.ok, true);
  assert.match(passed.requests[0].url, /^https:\/\/api\.github\.example\/repos\/lunchbox-labs\/example\//);
  assert.equal((await run([{ status: 404 }])).ok, false);
  assert.equal(
    (
      await run(
        Array.from({ length: 4 }, () => ({ runs: pendingRuns })),
        { WAIT_MINUTES: '1' },
      )
    ).ok,
    false,
  );
  for (const broken of [
    { GITHUB_SHA: 'main' },
    { GITHUB_TOKEN: '' },
    { REQUIRED_WORKFLOWS: ' , ' },
    { WAIT_MINUTES: 'forty' },
  ]) {
    await assert.rejects(run([], broken), /Set GITHUB_REPOSITORY/);
  }
});

async function workflowFile(name) {
  const source = await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
  return { source, workflow: parseYaml(source) };
}

test('the release commit gate names workflows that run on every push to main', async () => {
  const { workflow: publish } = await workflowFile('publish.yml');
  const gate = publish.jobs.checks.steps.find((step) => step.run === 'node scripts/release-ci.mjs');
  assert.deepEqual(gate.env.REQUIRED_WORKFLOWS.split(','), Object.keys(TRIGGERING_WORKFLOWS));
  for (const [name, file] of Object.entries(TRIGGERING_WORKFLOWS)) {
    const { workflow } = await workflowFile(file);
    assert.equal(workflow.name, name, file);
    assert.ok(workflow.on.push.branches.includes('main'), file);
    for (const filter of ['branches-ignore', 'paths', 'paths-ignore']) {
      assert.equal(workflow.on.push[filter], undefined, `${file} push ${filter}`);
    }
  }
});

// Where the workflow mentions the GitHub token: the workflow, a job or a step.
function tokenLocations(workflow) {
  const holds = (value) => /github\.token|\bGITHUB_TOKEN\b|\bGH_TOKEN\b/.test(JSON.stringify(value));
  const { jobs, ...top } = workflow;
  const locations = holds(top) ? ['workflow'] : [];
  for (const [id, { steps = [], ...job }] of Object.entries(jobs)) {
    if (holds(job)) {
      locations.push(id);
    }
    steps.forEach((step, index) => {
      if (holds(step)) {
        locations.push(`${id}.steps.${index}`);
      }
    });
  }
  return locations;
}

test('only the release commit gate step receives the GitHub token', async () => {
  const { source, workflow } = await workflowFile('publish.yml');
  const { checks } = workflow.jobs;
  const checkout = checks.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with['persist-credentials'], false);
  const gate = checks.steps.findIndex((step) => step.run === 'node scripts/release-ci.mjs');
  assert.ok(gate >= 0);
  assert.deepEqual(tokenLocations(workflow), [`checks.steps.${gate}`]);
  assert.deepEqual(Object.keys(checks.steps[gate].env).sort(), ['GITHUB_TOKEN', 'REQUIRED_WORKFLOWS']);
  assert.equal(checks.steps[gate].env.GITHUB_TOKEN, '${{ github.token }}');
  assert.equal(source.match(/github\.token/g)?.length, 1);
});
