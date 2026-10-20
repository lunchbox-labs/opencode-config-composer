import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

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
}) {
  assert.match(name ?? '', /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/, 'invalid npm package name');
  assert.match(version ?? '', /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/, 'invalid stable package version');
  assert.equal(tag, `v${version}`, 'release tag must match the package version');
  assert.match(repository ?? '', /^[\w.-]+\/[\w.-]+$/, 'invalid GitHub repository');
  assert.ok(typeof token === 'string' && token.length > 0, 'GitHub token is required');
  const get = (url, headers) => request(url, { headers, signal: AbortSignal.timeout(30_000) });
  const metadataURL = `${registry}/${encodeURIComponent(name)}/${version}`;
  let metadata;
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await get(metadataURL);
    if (response.ok) {
      metadata = await response.json();
      break;
    }
    if (![404, 429, 500, 502, 503, 504].includes(response.status) || attempt === 5) {
      throw new Error(`npm registry metadata unavailable (HTTP ${response.status})`);
    }
    await response.body?.cancel();
    await setTimeout(retryDelay);
  }
  assert.equal(metadata.name, name, 'npm registry package identity differs');
  assert.equal(metadata.version, version, 'npm registry package version differs');
  const tarballURL = new URL(metadata.dist.tarball);
  assert.ok(
    tarballURL.protocol === 'https:' ||
      (new URL(registry).protocol === 'http:' && tarballURL.origin === new URL(registry).origin),
    'npm tarball must use HTTPS',
  );
  const archive = await get(tarballURL);
  assert.ok(archive.ok, `npm tarball unavailable (HTTP ${archive.status})`);
  const bytes = Buffer.from(await archive.arrayBuffer());
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

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const releaseResponse = await get(`${api}/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, headers);
  assert.ok(releaseResponse.ok, `GitHub release lookup failed (HTTP ${releaseResponse.status})`);
  const release = await releaseResponse.json();
  assert.equal(release.tag_name, tag, 'GitHub release tag differs');
  assert.equal(release.draft, false, 'GitHub release must be published');
  assert.equal(release.prerelease, false, 'GitHub release must be stable');
  assert.ok(Number.isSafeInteger(release.id) && release.id > 0, 'invalid GitHub release identity');
  const assetName = `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
  const find = async () => {
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
  const response = await request(
    `${uploads}/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(assetName)}`,
    {
      method: 'POST',
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
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await attachPublishedTarball({
      name: process.env.NPM_PACKAGE_NAME,
      version: process.env.NPM_PACKAGE_VERSION,
      tag: process.env.RELEASE_TAG,
      repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GH_TOKEN,
    });
    console.log(`Published npm tarball ${result.name}: ${result.action}.`);
  } catch (error) {
    // Deliberately omit response bodies, request URLs and credentials from release logs.
    console.error(
      error instanceof assert.AssertionError
        ? error.message.split('\n')[0]
        : 'Published tarball attachment failed; check registry and GitHub availability.',
    );
    process.exitCode = 1;
  }
}
