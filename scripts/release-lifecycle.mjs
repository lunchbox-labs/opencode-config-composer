import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import { attachPublishedTarball, downloadReleaseAsset, preflightDraftRelease } from './attach-published-tarball.mjs';

class LifecycleHttpError extends Error {
  constructor(status) {
    super(`GitHub request failed (HTTP ${status})`);
    this.status = status;
  }
}

function client(options) {
  const { repository, token, api = 'https://api.github.com', fetch: request = globalThis.fetch } = options;
  assert.match(repository ?? '', /^[\w.-]+\/[\w.-]+$/, 'invalid repository');
  assert.match(options.name ?? '', /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/, 'invalid npm package name');
  assert.match(options.version ?? '', /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/, 'invalid stable version');
  assert.match(options.commit ?? '', /^[a-f0-9]{40}$/, 'invalid release commit');
  assert.equal(options.tag, `v${options.version}`, 'release tag differs from version');
  assert.ok(token, 'GitHub token required');
  return async (path, method = 'GET', body, allowConflict = false) => {
    const phase = path.startsWith('/commits/')
      ? 'commit'
      : path.startsWith('/compare/')
        ? 'main'
        : path === '/git/refs' && method === 'POST'
          ? 'tag-create'
          : path.startsWith('/git/')
            ? 'tag'
            : path === '/releases/generate-notes'
              ? 'notes'
              : method === 'POST' && path === '/releases'
                ? 'draft-create'
                : 'release';
    options.onPhase?.(phase);
    const response = await request(`${api}/repos/${repository}${path}`, {
      method,
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404 && method === 'GET') {
      return undefined;
    }
    if (allowConflict && [409, 422].includes(response.status)) {
      await response.body?.cancel();
      return { conflictStatus: response.status };
    }
    if (!response.ok) {
      throw new LifecycleHttpError(response.status);
    }
    return response.json();
  };
}

async function exactTag(options, create = false) {
  const api = client(options);
  let ref = await api(`/git/ref/tags/${encodeURIComponent(options.tag)}`);
  if (!ref && create) {
    const creation = await api('/git/refs', 'POST', { ref: `refs/tags/${options.tag}`, sha: options.commit }, true);
    ref = await api(`/git/ref/tags/${encodeURIComponent(options.tag)}`);
    if (!ref && creation?.conflictStatus) {
      options.onPhase?.('tag-create');
      throw new LifecycleHttpError(creation.conflictStatus);
    }
  }
  assert.ok(ref, 'release tag is missing');
  let object = ref.object;
  for (let depth = 0; object?.type === 'tag' && depth < 10; depth++) {
    object = (await api(`/git/tags/${object.sha}`))?.object;
  }
  assert.equal(object?.type, 'commit', 'tag must resolve to a commit');
  assert.equal(object.sha, options.commit, 'existing tag points to another commit; refusing to move it');
  return api;
}

async function matchingRelease(options) {
  const api = client(options);
  const matches = [];
  for (let page = 1; ; page++) {
    const releases = await api(`/releases?per_page=100&page=${page}`);
    assert.ok(Array.isArray(releases), 'invalid release listing');
    matches.push(...releases.filter((release) => release.tag_name === options.tag));
    if (releases.length < 100) {
      break;
    }
  }
  assert.ok(matches.length <= 1, 'duplicate matching releases');
  return matches[0];
}

export async function prepareRelease(options) {
  const api = client(options);
  const commit = await api(`/commits/${options.commit}`);
  assert.equal(commit?.sha, options.commit, 'release commit does not exist');
  const comparison = await api(`/compare/${options.commit}...main`);
  assert.ok(['ahead', 'identical'].includes(comparison?.status), 'release commit must belong to main');
  let release = await matchingRelease(options);
  const existingTag = await api(`/git/ref/tags/${encodeURIComponent(options.tag)}`);
  if (!release || !existingTag) {
    const request = options.fetch ?? globalThis.fetch;
    const registry = options.registry ?? 'https://registry.npmjs.org';
    options.onPhase?.('registry');
    const response = await request(`${registry}/${encodeURIComponent(options.name)}/${options.version}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(
      response.status,
      404,
      'npm version already exists or lookup failed; missing GitHub state requires manual recovery',
    );
    await response.body?.cancel();
  }
  if (release) {
    assert.equal(release.prerelease, false, 'release must be stable');
  }
  if (release?.draft && !existingTag) {
    const target = await api(`/commits/${encodeURIComponent(release.target_commitish)}`);
    assert.equal(target?.sha, options.commit, 'existing draft targets another commit');
    assert.ok(release, 'matching release is missing');
    assert.equal(release.prerelease, false, 'release must be stable');
    assert.notEqual(release.immutable, true, 'draft must be mutable');
  }
  assert.ok(!release || release.draft || existingTag, 'published release is missing its tag');
  await exactTag(options, true);
  if (!release) {
    const notes = await api('/releases/generate-notes', 'POST', {
      tag_name: options.tag,
      target_commitish: options.commit,
    });
    assert.ok(typeof notes?.name === 'string' && typeof notes?.body === 'string', 'invalid generated release notes');
    const created = await api(
      '/releases',
      'POST',
      {
        tag_name: options.tag,
        target_commitish: options.commit,
        name: notes.name,
        body: notes.body,
        draft: true,
        prerelease: false,
      },
      true,
    );
    if (created?.conflictStatus !== undefined) {
      release = await matchingRelease(options);
      if (!release) {
        options.onPhase?.('draft-create');
        throw new LifecycleHttpError(created.conflictStatus);
      }
    } else {
      release = created;
      assert.equal(release?.draft, true, 'new release must be a draft');
    }
  }
  assert.ok(release, 'matching release is missing');
  assert.ok(Number.isSafeInteger(release.id) && release.id > 0, 'invalid release identity');
  assert.equal(release.tag_name, options.tag, 'release tag differs');
  assert.equal(typeof release.draft, 'boolean', 'invalid release draft state');
  assert.equal(release.prerelease, false, 'release must be stable');
  if (release.draft) {
    assert.notEqual(release.immutable, true, 'draft must be mutable');
  }
  return { action: release.draft ? 'draft' : 'published', id: release.id };
}

export async function publishNpmRelease(options) {
  await exactTag(options);
  // A published release is allowed only for an already-published exact npm match.
  const release = await preflightDraftRelease({
    ...options,
    allowPublishedReadOnly: true,
  });
  const { registry = 'https://registry.npmjs.org', fetch: request = globalThis.fetch } = options;
  const bytes = await readFile(options.tarball);
  const { stdout } = await promisify(execFile)('tar', ['-xzOf', options.tarball, 'package/package.json'], {
    timeout: 15_000,
    maxBuffer: 1_000_000,
  });
  const manifest = JSON.parse(stdout);
  assert.equal(manifest.name, options.name, 'local tarball name differs');
  assert.equal(manifest.version, options.version, 'local tarball version differs');
  const api = client(options);
  for (let page = 1; ; page++) {
    const assets = await api(`/releases/${release.release.id}/assets?per_page=100&page=${page}`);
    assert.ok(Array.isArray(assets), 'invalid asset listing');
    const assetName = `${options.name.replace(/^@/, '').replace('/', '-')}-${options.version}.tgz`;
    for (const asset of assets.filter((asset) => asset.name === assetName)) {
      assert.ok(
        bytes.equals(await downloadReleaseAsset(options, asset.id)),
        'existing asset differs from verified build',
      );
    }
    if (assets.length < 100) {
      break;
    }
  }
  let response;
  const deadline = Date.now() + 120_000;
  for (let attempt = 0; ; attempt++) {
    response = await request(`${registry}/${encodeURIComponent(options.name)}/${options.version}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (
      !options.waitForRegistry ||
      response.ok ||
      ![404, 429, 500, 502, 503, 504].includes(response.status) ||
      attempt >= 60 ||
      Date.now() >= deadline
    ) {
      break;
    }
    await response.body?.cancel();
    await setTimeout(options.retryDelay ?? 2000);
  }
  if (response.ok) {
    const metadata = await response.json();
    assert.equal(metadata.name, options.name, 'published npm identity differs');
    assert.equal(metadata.version, options.version, 'published npm version differs');
    if (metadata.gitHead !== undefined) {
      assert.equal(metadata.gitHead, options.commit, 'published npm commit differs');
    }
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    assert.ok(metadata.dist?.integrity?.split(/\s+/).includes(integrity), 'published npm integrity differs');
    const tarballURL = new URL(metadata.dist.tarball);
    assert.ok(
      (tarballURL.protocol === 'https:' && tarballURL.hostname === 'registry.npmjs.org') ||
        (new URL(registry).protocol === 'http:' && tarballURL.origin === new URL(registry).origin),
      'npm tarball must use HTTPS',
    );
    const archive = await request(tarballURL, {
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    assert.ok(archive.ok, 'published npm tarball unavailable');
    assert.ok(bytes.equals(Buffer.from(await archive.arrayBuffer())), 'published npm tarball bytes differ');
    return { action: 'unchanged' };
  }
  assert.equal(response.status, 404, 'npm lookup failed; refusing publication');
  assert.equal(release.release.draft, true, 'cannot publish npm for an already-published release');
  assert.equal(release.release.immutable === true, false, 'draft must be mutable');
  if (options.publish) {
    await options.publish();
  } else {
    assert.ok(['public', 'restricted'].includes(options.access), 'invalid npm access');
    const npmEnvironment = { ...process.env };
    delete npmEnvironment.GH_TOKEN;
    delete npmEnvironment.GITHUB_TOKEN;
    await promisify(execFile)(
      'npm',
      ['publish', options.tarball, '--ignore-scripts', '--access', options.access, '--tag', 'latest'],
      { timeout: 120_000, env: npmEnvironment },
    );
  }
  return { action: 'published' };
}

export async function finishRelease(options) {
  const api = await exactTag(options);
  await publishNpmRelease({
    ...options,
    waitForRegistry: true,
    publish: () => {
      throw new Error('npm version missing after publication');
    },
  });
  const before = await matchingRelease(options);
  const result = await attachPublishedTarball({
    ...options,
    allowPublishedReadOnly: true,
  });
  const release = await matchingRelease(options);
  assert.equal(release.id, before.id, 'release identity changed during attachment');
  assert.equal(release.prerelease, false, 'release must be stable');
  if (release.draft) {
    assert.notEqual(release.immutable, true, 'draft must be mutable');
    await api(`/releases/${release.id}`, 'PATCH', { draft: false });
  }
  return result;
}

export function lifecycleFailureMessage(stage, phase, error) {
  const safeStage = ['prepare', 'npm', 'finish'].includes(stage) ? stage : 'configuration';
  const safePhase = [
    'configuration',
    'commit',
    'main',
    'tag',
    'tag-create',
    'notes',
    'draft-create',
    'release',
    'registry',
  ].includes(phase)
    ? phase
    : 'operation';
  const status =
    error instanceof LifecycleHttpError && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599
      ? error.status
      : undefined;
  const code = status ? 'http' : error instanceof assert.AssertionError ? 'validation' : 'request';
  const hint =
    safePhase === 'tag-create' && status ? ' Check tag-creation rulesets and workflow token permissions.' : '';
  return `Release lifecycle ${safeStage} failed: phase=${safePhase} code=${code}${status ? ` status=${status}` : ''}; no response details logged.${hint}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const stage = process.argv[2];
  let phase = 'configuration';
  try {
    const options = {
      onPhase: (value) => {
        phase = value;
      },
      name: process.env.NPM_PACKAGE_NAME,
      version: process.env.NPM_PACKAGE_VERSION,
      tag: process.env.RELEASE_TAG,
      commit: process.env.RELEASE_COMMIT,
      repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GH_TOKEN,
      access: process.env.NPM_ACCESS,
    };
    if (stage === 'npm' || stage === 'finish') {
      const files = (await readdir('release')).filter((name) => name.endsWith('.tgz'));
      assert.equal(files.length, 1, 'exactly one verified tarball required');
      options.tarball = join(process.cwd(), 'release', files[0]);
    }
    const operation = {
      prepare: prepareRelease,
      npm: publishNpmRelease,
      finish: finishRelease,
    }[stage];
    assert.ok(operation, 'invalid lifecycle stage');
    const result = await operation(options);
    console.log(`Release ${stage}: ${result.action}.`);
  } catch (error) {
    console.error(lifecycleFailureMessage(stage, phase, error));
    process.exitCode = 1;
  }
}
