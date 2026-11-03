import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export const pollIntervalMs = 30_000;
export const requestTimeoutMs = 30_000;
export const maxConsecutiveErrors = 5;

// Reports whether the push-event runs of every required workflow succeeded for
// one commit. Only the latest run of each workflow counts. A re-run reuses its
// run object (same id and created_at, higher run_attempt), so the listed object
// already shows the newest attempt; separate runs get increasing ids, so the
// highest id is the latest.
export function releaseCiState(runs, required) {
  const latest = new Map();
  for (const run of runs) {
    if (run.event !== 'push' || !required.includes(run.name)) {
      continue;
    }
    const known = latest.get(run.name);
    if (known === undefined || run.id > known.id) {
      latest.set(run.name, run);
    }
  }
  const failed = [];
  const cancelled = [];
  const pending = [];
  for (const name of required) {
    const run = latest.get(name);
    if (run === undefined || run.status !== 'completed') {
      pending.push(name);
    } else if (run.conclusion !== 'success') {
      failed.push(`${name} (${run.conclusion})`);
      if (run.conclusion === 'cancelled') {
        cancelled.push(name);
      }
    }
  }
  if (failed.length > 0) {
    return {
      state: 'failure',
      detail: `Failed: ${failed.join(', ')}.`,
      cancelled,
    };
  }
  if (pending.length > 0) {
    return { state: 'pending', detail: `Waiting for: ${pending.join(', ')}.` };
  }
  return { state: 'success', detail: `Passed: ${required.join(', ')}.` };
}

// A listing error that polling again may outlast (transient), or one that a
// retry will not change, such as a bad token or a missing repository.
export class RequestError extends Error {
  constructor(message, transient) {
    super(message);
    this.transient = transient;
  }
}

function transientStatus(response) {
  if (response.status >= 500 || response.status === 429) {
    return true;
  }
  return (
    response.status === 403 &&
    (response.headers.get('retry-after') !== null || response.headers.get('x-ratelimit-remaining') === '0')
  );
}

export async function listWorkflowRuns({ api, repository, sha, token, fetch = globalThis.fetch }) {
  const url = new URL(`${api}/repos/${repository}/actions/runs`);
  url.search = new URLSearchParams({
    head_sha: sha,
    event: 'push',
    per_page: '100',
  }).toString();
  let response;
  let body;
  try {
    response = await fetch(url, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (response.ok) {
      body = await response.json();
    }
  } catch (error) {
    // Network failures, timeouts and bodies cut off mid-read.
    throw new RequestError(
      `Listing workflow runs failed: ${error instanceof Error ? error.message : String(error)}.`,
      true,
    );
  }
  if (!response.ok) {
    throw new RequestError(`Listing workflow runs failed with HTTP ${response.status}.`, transientStatus(response));
  }
  if (!Array.isArray(body?.workflow_runs)) {
    throw new RequestError('Listing workflow runs returned no run list.', false);
  }
  return body.workflow_runs;
}

// Polls until every required workflow succeeded, one failed, the deadline
// passed, or the API failed fatally or too many times in a row. Returns
// "success", "failure", "timeout" or "error".
export async function waitForReleaseCi({
  api,
  repository,
  sha,
  token,
  required,
  waitMinutes = 40,
  fetch = globalThis.fetch,
  sleep = delay,
  now = Date.now,
  log = console.log,
}) {
  const deadline = now() + waitMinutes * 60_000;
  let errors = 0;
  for (;;) {
    let runs;
    try {
      runs = await listWorkflowRuns({ api, repository, sha, token, fetch });
      errors = 0;
    } catch (error) {
      if (!(error instanceof RequestError)) {
        throw error;
      }
      if (!error.transient) {
        log(error.message);
        return 'error';
      }
      errors += 1;
      if (errors >= maxConsecutiveErrors) {
        log(`${error.message} Giving up after ${errors} consecutive errors.`);
        return 'error';
      }
      log(`${error.message} Polling again.`);
    }
    if (runs !== undefined) {
      const { state, detail, cancelled } = releaseCiState(runs, required);
      log(detail);
      if (state === 'success') {
        return 'success';
      }
      if (state === 'failure') {
        if (cancelled.length > 0) {
          log(`Hint: re-run ${cancelled.join(' and ')} for the release commit, then re-run Publish.`);
        }
        return 'failure';
      }
    }
    if (now() >= deadline) {
      log('Timed out waiting for the release commit checks.');
      return 'timeout';
    }
    await sleep(pollIntervalMs);
  }
}

export async function main(env = process.env, options = {}) {
  const required = (env.REQUIRED_WORKFLOWS ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const waitMinutes = Number(env.WAIT_MINUTES ?? 40);
  if (
    !env.GITHUB_REPOSITORY ||
    !/^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? '') ||
    !env.GITHUB_TOKEN ||
    required.length === 0 ||
    !Number.isFinite(waitMinutes) ||
    waitMinutes < 0
  ) {
    throw new Error(
      'Set GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_TOKEN and REQUIRED_WORKFLOWS, and WAIT_MINUTES to a number of minutes if set.',
    );
  }
  const outcome = await waitForReleaseCi({
    ...options,
    api: env.GITHUB_API_URL ?? 'https://api.github.com',
    repository: env.GITHUB_REPOSITORY,
    sha: env.GITHUB_SHA,
    token: env.GITHUB_TOKEN,
    required,
    waitMinutes,
  });
  return outcome === 'success';
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!(await main())) {
    process.exitCode = 1;
  }
}
