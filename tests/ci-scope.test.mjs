import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { documentationFiles, main, nativeChecksRequired, pullRequestChanges } from '../scripts/ci-scope.mjs';

test('pull requests that change only documentation skip the native matrix', () => {
  assert.equal(nativeChecksRequired(['README.md']), false);
  assert.equal(nativeChecksRequired([...documentationFiles]), false);
});

test('every other change keeps the native matrix', () => {
  const files = [
    'src/server.ts',
    'tests/config-composer.native.ts',
    'scripts/integration.mjs',
    'package.json',
    'package-lock.json',
    'schema.json',
    '.github/workflows/integration.yml',
    'docs/examples/review-programming/opencode.jsonc',
    'skills/config-composer-create/SKILL.md',
    'docs/README.md',
  ];
  for (const file of files) {
    assert.equal(nativeChecksRequired([file]), true, file);
    assert.equal(nativeChecksRequired(['README.md', file]), true, `README.md with ${file}`);
  }
});

test('an empty comparison runs every check', () => {
  assert.equal(nativeChecksRequired([]), true);
});

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return directory;
}

async function outputOf(run) {
  const output = join(await mkdtemp(join(tmpdir(), 'ci-scope-output-')), 'output');
  try {
    await run(output);
    return await readFile(output, 'utf8');
  } finally {
    await rm(output, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test('pushes run every check without inspecting the checkout', async (t) => {
  const directory = await temporaryDirectory(t, 'ci-scope-push-');
  const output = await outputOf((file) => main({ GITHUB_EVENT_NAME: 'push', GITHUB_OUTPUT: file }, directory));
  assert.equal(output, 'native=true\n');
});

test('pull request changes are read from the merge commit against its base', async (t) => {
  const repository = await temporaryDirectory(t, 'ci-scope-');
  const git = (...args) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  const commit = async (file, content, message) => {
    await mkdir(join(repository, file, '..'), { recursive: true });
    await writeFile(join(repository, file), content);
    git('add', '--all');
    git('commit', '--quiet', '--message', message);
  };
  const scope = (env) =>
    outputOf((file) => main({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_OUTPUT: file, ...env }, repository));

  git('init', '--quiet', '--initial-branch=main');
  await commit('src/server.ts', 'export {};\n', 'base');
  await commit('README.md', '# Base\n', 'readme');
  git('checkout', '--quiet', '-b', 'docs');
  await commit('README.md', '# Updated\n', 'update the readme');
  const head = git('rev-parse', 'HEAD');
  git('checkout', '--quiet', 'main');
  await commit('src/server.ts', 'export const moved = true;\n', 'base moves on');
  // GitHub tests the merge of the pull request into the current base, exactly as
  // actions/checkout provides it: base first, pull request head second.
  git('merge', '--quiet', '--no-ff', '--no-edit', 'docs');

  assert.deepEqual(await pullRequestChanges({ head, cwd: repository }), ['README.md']);
  assert.equal(await scope({ PULL_REQUEST_HEAD: head }), 'native=false\n');
  await assert.rejects(scope({}), /PULL_REQUEST_HEAD/);

  // A merge commit of an older head, or no merge commit at all, proves nothing about
  // the pull request, so every check runs.
  const staleHead = git('rev-parse', 'main^1');
  assert.equal(await pullRequestChanges({ head: staleHead, cwd: repository }), undefined);
  assert.equal(await scope({ PULL_REQUEST_HEAD: staleHead }), 'native=true\n');
  git('checkout', '--quiet', 'docs');
  assert.equal(await pullRequestChanges({ head, cwd: repository }), undefined);
  assert.equal(await scope({ PULL_REQUEST_HEAD: head }), 'native=true\n');
});
