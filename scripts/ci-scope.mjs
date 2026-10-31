import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

// A pull request that changes only these files skips the native suites. The suites
// install the packed package, which ships README.md and LICENSE, and the packed-package
// test in the ungated check job makes the same assertions about those files, so such a
// pull request cannot pass Check while breaking a native suite. Every other path keeps
// the suites: workflows, scripts, package metadata, bundled skills and the documented
// examples all feed at least one of them.
export const documentationFiles = Object.freeze(['README.md', 'AGENTS.md', 'LICENSE', '.github/CODEOWNERS']);

export function nativeChecksRequired(changedFiles) {
  // An empty comparison means the diff did not describe the pull request; run everything.
  return changedFiles.length === 0 || changedFiles.some((file) => !documentationFiles.includes(file));
}

async function git(args, cwd) {
  const { stdout } = await promisify(execFile)('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

// Returns the files the pull request changes, or undefined when HEAD is not the merge of
// the given head into the base branch and nothing can be proven about the change.
export async function pullRequestChanges({ head, cwd = process.cwd() }) {
  // actions/checkout provides the pull request's merge commit: its first parent is the
  // base branch and its second parent is the pull request head. GitHub can start a run
  // before it has refreshed that merge commit, in which case it merges an older head.
  const parents = (await git(['rev-list', '--parents', '--max-count=1', 'HEAD'], cwd)).trim().split(' ');
  if (parents.length !== 3 || parents[2] !== head) {
    return undefined;
  }
  const output = await git(['diff', '--name-only', '--no-renames', '-z', parents[1], 'HEAD'], cwd);
  return output.split('\0').filter((file) => file !== '');
}

export async function main(env = process.env, cwd = process.cwd()) {
  const event = env.GITHUB_EVENT_NAME ?? 'local';
  let native = true;
  let reason = `${event} runs every check`;
  if (event === 'pull_request') {
    const head = env.PULL_REQUEST_HEAD;
    assert.ok(head, 'PULL_REQUEST_HEAD must name the pull request head commit');
    const changed = await pullRequestChanges({ head, cwd });
    if (changed === undefined) {
      console.log(`::warning::HEAD is not the merge of pull request head ${head}; running every check`);
      reason = 'the checkout does not show what the pull request changes';
    } else {
      console.log(['Changed files:', ...changed.map((file) => `  ${file}`)].join('\n'));
      native = nativeChecksRequired(changed);
      reason = native
        ? 'the pull request changes files that native checks use'
        : 'the pull request changes only documentation';
    }
  }
  console.log(`native=${native} (${reason})`);
  if (env.GITHUB_OUTPUT !== undefined) {
    await appendFile(env.GITHUB_OUTPUT, `native=${native}\n`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
