import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

class ReleaseFailure extends Error {
  constructor(stage, error) {
    super(
      `[${stage}] ${error instanceof assert.AssertionError ? error.message.split('\n')[0] : 'request or verification failed'}`,
    );
    this.stage = stage;
  }
}
function safeFailure(stage, error) {
  return error instanceof ReleaseFailure ? error : new ReleaseFailure(stage, error);
}
export function releaseFailureMessage(error) {
  return error instanceof ReleaseFailure ? error.message : '[configuration] release operation failed';
}

export async function downloadReleaseAsset(
  { repository, token, api = 'https://api.github.com', fetch: request = globalThis.fetch },
  id,
) {
  assert.ok(Number.isSafeInteger(id) && id > 0, 'invalid asset identity');
  let response = await request(`${api}/repos/${repository}/releases/assets/${id}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/octet-stream' },
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const target = new URL(response.headers.get('location'));
    assert.ok(
      target.protocol === 'https:' &&
        ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(target.hostname),
      'unexpected asset redirect',
    );
    await response.body?.cancel();
    response = await request(target, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  }
  assert.ok(response.ok, 'GitHub asset download failed');
  return Buffer.from(await response.arrayBuffer());
}

export async function preflightDraftRelease({
  name,
  version,
  repository,
  tag,
  token,
  api = 'https://api.github.com',
  fetch: request = globalThis.fetch,
  allowPublishedReadOnly = false,
}) {
  const stage = 'draft-preflight';
  try {
    assert.match(name ?? '', /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/, 'invalid npm package name');
    assert.match(version ?? '', /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/, 'invalid stable package version');
    assert.equal(tag, `v${version}`, 'release tag must match the package version');
    assert.match(repository ?? '', /^[\w.-]+\/[\w.-]+$/, 'invalid GitHub repository');
    assert.ok(typeof token === 'string' && token.length > 0, 'GitHub token is required');
    const get = async (url, headers) => {
      const response = await request(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const target = new URL(response.headers.get('location'));
        assert.ok(
          headers?.Accept === 'application/octet-stream' &&
            target.protocol === 'https:' &&
            ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(target.hostname),
          'unexpected HTTP redirect',
        );
        await response.body?.cancel();
        return request(target, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
      }
      return response;
    };
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    const matches = [];
    for (let page = 1; ; page++) {
      const response = await get(`${api}/repos/${repository}/releases?per_page=100&page=${page}`, headers);
      assert.ok(response.ok, `GitHub draft release lookup failed (HTTP ${response.status})`);
      const releases = await response.json();
      assert.ok(Array.isArray(releases), 'invalid GitHub release listing');
      matches.push(...releases.filter((release) => release.tag_name === tag));
      if (releases.length < 100) {
        break;
      }
    }
    assert.equal(matches.length, 1, 'exactly one existing matching draft release is required');
    const release = matches[0];
    assert.equal(release.tag_name, tag, 'GitHub release tag differs');
    assert.ok(
      (allowPublishedReadOnly && release.draft === false) || release.immutable !== true,
      'GitHub release is immutable; assets cannot be attached',
    );
    assert.ok(
      typeof release.draft === 'boolean' && (release.draft || allowPublishedReadOnly),
      'GitHub release must remain a draft until assets are attached',
    );
    assert.equal(release.prerelease, false, 'GitHub release must be stable');
    assert.ok(Number.isSafeInteger(release.id) && release.id > 0, 'invalid GitHub release identity');
    return { release, headers };
  } catch (error) {
    throw safeFailure(stage, error);
  }
}

export async function attachPublishedTarball({
  name,
  version,
  repository,
  tag,
  token,
  registry = 'https://registry.npmjs.org',
  api = 'https://api.github.com',
  uploads = 'https://uploads.github.com',
  fetch: request = globalThis.fetch,
  retryDelay = 2000,
  allowPublishedReadOnly = false,
}) {
  let stage = 'configuration';
  try {
    assert.match(name ?? '', /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/, 'invalid npm package name');
    assert.match(version ?? '', /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/, 'invalid stable package version');
    assert.equal(tag, `v${version}`, 'release tag must match the package version');
    assert.match(repository ?? '', /^[\w.-]+\/[\w.-]+$/, 'invalid GitHub repository');
    assert.ok(typeof token === 'string' && token.length > 0, 'GitHub token is required');
    const get = async (url, headers) => {
      const response = await request(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const target = new URL(response.headers.get('location'));
        assert.ok(
          headers?.Accept === 'application/octet-stream' &&
            target.protocol === 'https:' &&
            ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(target.hostname),
          'unexpected HTTP redirect',
        );
        await response.body?.cancel();
        return request(target, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
      }
      return response;
    };
    stage = 'draft-preflight';
    const { release, headers } = await preflightDraftRelease({
      name,
      version,
      repository,
      tag,
      token,
      api,
      fetch: request,
      allowPublishedReadOnly,
    });
    stage = 'registry-metadata';
    const metadataURL = `${registry}/${encodeURIComponent(name)}/${version}`;
    let metadata;
    const metadataDeadline = Date.now() + 120_000;
    for (let attempt = 0; attempt < 61; attempt++) {
      const response = await get(metadataURL);
      if (response.ok) {
        metadata = await response.json();
        break;
      }
      if (
        ![404, 429, 500, 502, 503, 504].includes(response.status) ||
        attempt === 60 ||
        Date.now() >= metadataDeadline
      ) {
        assert.fail(`npm registry metadata unavailable (HTTP ${response.status})`);
      }
      await response.body?.cancel();
      await setTimeout(Math.min(retryDelay, Math.max(0, metadataDeadline - Date.now())));
    }
    assert.equal(metadata.name, name, 'npm registry package identity differs');
    assert.equal(metadata.version, version, 'npm registry package version differs');
    const tarballURL = new URL(metadata.dist.tarball);
    assert.ok(
      (tarballURL.protocol === 'https:' && tarballURL.hostname === 'registry.npmjs.org') ||
        (new URL(registry).protocol === 'http:' && tarballURL.origin === new URL(registry).origin),
      'npm tarball must use HTTPS',
    );
    stage = 'registry-tarball';
    const archive = await get(tarballURL);
    assert.ok(archive.ok, `npm tarball unavailable (HTTP ${archive.status})`);
    const bytes = Buffer.from(await archive.arrayBuffer());
    stage = 'tarball-verification';
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    assert.ok(
      typeof metadata.dist.integrity === 'string' && metadata.dist.integrity.split(/\s+/).includes(integrity),
      'npm tarball integrity differs or lacks SHA-512',
    );
    if (metadata.dist.shasum !== undefined) {
      assert.equal(createHash('sha1').update(bytes).digest('hex'), metadata.dist.shasum, 'npm tarball shasum differs');
    }
    const root = await mkdtemp(join(tmpdir(), 'published-npm-'));
    try {
      const file = join(root, 'published.tgz');
      await writeFile(file, bytes, { flag: 'wx' });
      const { stdout } = await promisify(execFile)('tar', ['-xzOf', file, 'package/package.json'], {
        timeout: 15_000,
        maxBuffer: 1_000_000,
      });
      const manifest = JSON.parse(stdout);
      assert.equal(manifest.name, name, 'tarball package identity differs');
      assert.equal(manifest.version, version, 'tarball package version differs');
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    const assetName = `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
    const find = async () => {
      stage = 'github-asset-list';
      const matching = [];
      for (let page = 1; ; page++) {
        const response = await get(
          `${api}/repos/${repository}/releases/${release.id}/assets?per_page=100&page=${page}`,
          headers,
        );
        assert.ok(response.ok, `GitHub asset listing failed (HTTP ${response.status})`);
        const assets = await response.json();
        assert.ok(Array.isArray(assets), 'invalid GitHub asset listing');
        matching.push(...assets.filter((asset) => asset.name === assetName));
        if (assets.length < 100) {
          break;
        }
      }
      assert.ok(matching.length <= 1, 'multiple existing release assets have the same name');
      return matching[0];
    };
    const compare = async (asset) => {
      stage = 'github-asset-comparison';
      assert.ok(Number.isSafeInteger(asset.id) && asset.id > 0, 'invalid GitHub asset identity');
      const response = await get(`${api}/repos/${repository}/releases/assets/${asset.id}`, {
        ...headers,
        Accept: 'application/octet-stream',
      });
      assert.ok(response.ok, `GitHub asset download failed (HTTP ${response.status})`);
      assert.ok(
        bytes.equals(Buffer.from(await response.arrayBuffer())),
        'existing release asset differs from the published npm tarball; refusing overwrite',
      );
    };
    const existing = await find();
    if (existing !== undefined) {
      await compare(existing);
      return { action: 'unchanged', name: assetName };
    }
    stage = 'github-asset-upload';
    assert.equal(release.draft, true, 'published releases cannot receive new assets');
    const response = await request(
      `${uploads}/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(assetName)}`,
      {
        method: 'POST',
        redirect: 'error',
        headers: { ...headers, 'Content-Type': 'application/gzip' },
        body: bytes,
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (response.status === 422) {
      await response.body?.cancel();
      const concurrent = await find();
      assert.ok(concurrent !== undefined, 'GitHub rejected the asset upload without an identical existing asset');
      await compare(concurrent);
      return { action: 'unchanged', name: assetName };
    }
    assert.equal(response.status, 201, `GitHub asset upload failed (HTTP ${response.status})`);
    const uploaded = await response.json();
    assert.equal(uploaded.name, assetName, 'uploaded release asset name differs');
    await compare(uploaded);
    return { action: 'uploaded', name: assetName };
  } catch (error) {
    throw safeFailure(stage, error);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const preflight = process.argv.includes('--preflight');
    const result = await (preflight ? preflightDraftRelease : attachPublishedTarball)({
      name: process.env.NPM_PACKAGE_NAME,
      version: process.env.NPM_PACKAGE_VERSION,
      tag: process.env.RELEASE_TAG,
      repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GH_TOKEN,
    });
    console.log(
      preflight ? 'Draft release preflight passed.' : `Published npm tarball ${result.name}: ${result.action}.`,
    );
  } catch (error) {
    // Deliberately omit response bodies, request URLs and credentials from release logs.
    console.error(releaseFailureMessage(error));
    process.exitCode = 1;
  }
}
