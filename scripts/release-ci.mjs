import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

// Reports whether the push-event runs of every required workflow succeeded for
// one commit. Only the latest run of each workflow counts, so a successful
// re-run replaces an earlier failure.
export function releaseCiState(runs, required) {
  const latest = new Map();
  for (const run of runs) {
    if (run.event !== 'push' || !required.includes(run.name)) {
      continue;
    }
    const known = latest.get(run.name);
    if (known === undefined || Date.parse(run.created_at) > Date.parse(known.created_at)) {
      latest.set(run.name, run);
    }
  }
  const failed = [];
  const pending = [];
  for (const name of required) {
    const run = latest.get(name);
    if (run === undefined || run.status !== 'completed') {
      pending.push(name);
    } else if (run.conclusion !== 'success') {
      failed.push(`${name} (${run.conclusion})`);
    }
  }
  if (failed.length > 0) {
    return { state: 'failure', detail: `Failed: ${failed.join(', ')}.` };
  }
  if (pending.length > 0) {
    return { state: 'pending', detail: `Waiting for: ${pending.join(', ')}.` };
  }
  return { state: 'success', detail: `Passed: ${required.join(', ')}.` };
}

async function workflowRuns({ api, repository, sha, token }) {
  const url = `${api}/repos/${repository}/actions/runs?head_sha=${sha}&event=push&per_page=100`;
  const response = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response.ok) {
    throw new Error(`Listing workflow runs failed with HTTP ${response.status}.`);
  }
  return (await response.json()).workflow_runs;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_TOKEN, REQUIRED_WORKFLOWS } = process.env;
  const required = (REQUIRED_WORKFLOWS ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (!GITHUB_REPOSITORY || !/^[0-9a-f]{40}$/.test(GITHUB_SHA ?? '') || !GITHUB_TOKEN || required.length === 0) {
    throw new Error('Set GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_TOKEN and REQUIRED_WORKFLOWS.');
  }
  const deadline = Date.now() + Number(process.env.WAIT_MINUTES ?? 40) * 60_000;
  for (;;) {
    const runs = await workflowRuns({
      api: GITHUB_API_URL ?? 'https://api.github.com',
      repository: GITHUB_REPOSITORY,
      sha: GITHUB_SHA,
      token: GITHUB_TOKEN,
    });
    const { state, detail } = releaseCiState(runs, required);
    console.log(detail);
    if (state === 'success') {
      break;
    }
    if (state === 'failure') {
      process.exitCode = 1;
      break;
    }
    if (Date.now() >= deadline) {
      console.log('Timed out waiting for the release commit checks.');
      process.exitCode = 1;
      break;
    }
    await sleep(30_000);
  }
}
