import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

// No check reads these files, so a pull request that changes nothing else cannot
// change a native result. Every other path keeps the native matrix: workflows,
// scripts, package metadata, bundled skills and the documented examples all feed
// at least one native or integration check.
export const documentationFiles = Object.freeze(['README.md', 'AGENTS.md', 'LICENSE', '.github/CODEOWNERS']);

export function nativeChecksRequired(changedFiles) {
  // An empty comparison means the diff did not describe the pull request; run everything.
  return changedFiles.length === 0 || changedFiles.some((file) => !documentationFiles.includes(file));
}

async function git(args, cwd) {
  const { stdout } = await promisify(execFile)('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

export async function pullRequestChanges({ head, cwd = process.cwd() }) {
  // actions/checkout provides the pull request's merge commit: its first parent is the
  // base branch and its second parent is the pull request head. Checking the head
  // guards against diffing an unrelated commit, which would under-report the changes.
  const parents = (await git(['rev-list', '--parents', '--max-count=1', 'HEAD'], cwd)).trim().split(' ');
  assert.equal(parents.length, 3, 'expected HEAD to be the pull request merge commit with two parents');
  assert.equal(parents[2], head, 'HEAD does not merge the pull request head');
  const output = await git(['diff', '--name-only', '--no-renames', '-z', parents[1], 'HEAD'], cwd);
  return output.split('\0').filter((file) => file !== '');
}

export async function main(env = process.env) {
  const event = env.GITHUB_EVENT_NAME ?? 'local';
  let native = true;
  let reason = `${event} runs every check`;
  if (event === 'pull_request') {
    assert.ok(env.PULL_REQUEST_HEAD, 'PULL_REQUEST_HEAD must name the pull request head commit');
    const changed = await pullRequestChanges({ head: env.PULL_REQUEST_HEAD });
    console.log(['Changed files:', ...changed.map((file) => `  ${file}`)].join('\n'));
    native = nativeChecksRequired(changed);
    reason = native
      ? 'the pull request changes files that native checks use'
      : 'the pull request changes only documentation';
  }
  console.log(`native=${native} (${reason})`);
  if (env.GITHUB_OUTPUT !== undefined) {
    await appendFile(env.GITHUB_OUTPUT, `native=${native}\n`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
