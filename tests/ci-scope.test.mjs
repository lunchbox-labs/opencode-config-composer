import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { documentationFiles, nativeChecksRequired, pullRequestChanges } from '../scripts/ci-scope.mjs';

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

test('pull request changes are read from the merge commit against its base', async (t) => {
  const repository = await mkdtemp(join(tmpdir(), 'ci-scope-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
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
  await assert.rejects(
    pullRequestChanges({ head: git('rev-parse', 'main^1'), cwd: repository }),
    /does not merge the pull request head/,
  );
  git('checkout', '--quiet', 'docs');
  await assert.rejects(pullRequestChanges({ head, cwd: repository }), /merge commit with two parents/);
});
