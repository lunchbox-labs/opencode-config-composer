import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const name = '@fixture/package';
const version = '1.2.3';
const assetName = 'fixture-package-1.2.3.tgz';

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'published-tarball-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'package'));
  await writeFile(join(root, 'package/package.json'), JSON.stringify({ name, version, ...overrides.manifest }));
  await promisify(execFile)('tar', ['-czf', join(root, 'package.tgz'), '-C', root, 'package']);
  const bytes = await readFile(join(root, 'package.tgz'));
  const state = {
    assets: [],
    posts: 0,
    metadataReads: 0,
    unavailable: 0,
    calls: [],
    ...overrides,
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, base);
    const path = decodeURIComponent(url.pathname);
    state.calls.push(`${request.method} ${path}`);
    const json = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (path === `/${name}/${version}`) {
      state.metadataReads++;
      assert.equal(request.headers.authorization, undefined, 'registry must never receive GitHub credentials');
      if (state.metadataReads <= state.unavailable) {
        json(404, {});
        return;
      }
      json(200, {
        name,
        version,
        ...state.metadata,
        dist: {
          tarball: `${base}/package.tgz`,
          integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
          ...state.dist,
        },
      });
      return;
    }
    if (path === '/package.tgz') {
      response.end(bytes);
      return;
    }
    assert.equal(request.headers.authorization, 'Bearer fixture-token');
    if (path === '/repos/owner/repo/releases') {
      const releases = state.releases ?? [
        {
          id: 42,
          tag_name: 'v1.2.3',
          draft: true,
          prerelease: false,
          ...state.release,
        },
      ];
      const page = Number(url.searchParams.get('page'));
      json(200, releases.slice((page - 1) * 100, page * 100));
      return;
    }
    if (path === '/repos/owner/repo/releases/42/assets' && request.method === 'GET') {
      const page = Number(url.searchParams.get('page'));
      json(
        200,
        state.assets.slice((page - 1) * 100, page * 100).map((asset) => ({ id: asset.id, name: asset.name })),
      );
      return;
    }
    if (path.startsWith('/repos/owner/repo/releases/assets/')) {
      assert.equal(request.headers.accept, 'application/octet-stream');
      const asset = state.assets.find((entry) => entry.id === Number(path.split('/').at(-1)));
      response.end(asset.bytes);
      return;
    }
    if (path === '/repos/owner/repo/releases/42/assets' && request.method === 'POST') {
      state.posts++;
      const chunks = [];
      for await (const chunk of request) {
        chunks.push(chunk);
      }
      const asset = {
        id: 99,
        name: url.searchParams.get('name'),
        bytes: Buffer.concat(chunks),
      };
      if (state.race) {
        state.assets.push({
          ...asset,
          bytes: state.race === 'different' ? Buffer.from('different') : asset.bytes,
        });
        json(422, {});
        return;
      }
      state.assets.push(asset);
      json(201, { id: asset.id, name: asset.name });
      return;
    }
    json(404, {});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    state,
    bytes,
    options: {
      name,
      version,
      tag: 'v1.2.3',
      repository: 'owner/repo',
      token: 'fixture-token',
      registry: base,
      api: base,
      uploads: base,
      retryDelay: 0,
    },
  };
}

async function attach(options) {
  const { attachPublishedTarball } = await import('../scripts/attach-published-tarball.mjs');
  return attachPublishedTarball(options);
}

test('uploads the exact verified registry tarball and an identical rerun performs no upload', async (t) => {
  const { state, bytes, options } = await fixture(t);
  assert.equal((await attach(options)).action, 'uploaded');
  assert.equal(state.posts, 1);
  assert.equal(state.assets[0].name, assetName);
  assert.deepEqual(state.assets[0].bytes, bytes);
  assert.equal((await attach(options)).action, 'unchanged');
  assert.equal(state.posts, 1);
  assert.equal(
    state.calls.some((call) => call.startsWith('DELETE')),
    false,
  );
});

test('mismatched existing assets fail without overwrite, including paginated asset lists', async (t) => {
  const { state, options } = await fixture(t);
  state.assets = Array.from({ length: 100 }, (_, id) => ({
    id,
    name: `unrelated-${id}`,
  }));
  state.assets.push({
    id: 101,
    name: assetName,
    bytes: Buffer.from('different'),
  });
  await assert.rejects(attach(options), /existing.*differs/i);
  assert.equal(state.posts, 0);
});

for (const mismatch of ['metadata-name', 'metadata-version', 'integrity', 'archive-name', 'archive-version']) {
  test(`rejects ${mismatch} before any GitHub write`, async (t) => {
    const overrides = { metadata: {}, manifest: {}, dist: {} };
    if (mismatch === 'metadata-name') {
      overrides.metadata.name = '@wrong/package';
    }
    if (mismatch === 'metadata-version') {
      overrides.metadata.version = '9.9.9';
    }
    if (mismatch === 'integrity') {
      overrides.dist.integrity = 'sha512-invalid';
    }
    if (mismatch === 'archive-name') {
      overrides.manifest.name = '@wrong/package';
    }
    if (mismatch === 'archive-version') {
      overrides.manifest.version = '9.9.9';
    }
    const { state, options } = await fixture(t, overrides);
    await assert.rejects(attach(options));
    assert.equal(state.posts, 0);
  });
}

for (const release of [{ tag_name: 'v9.9.9' }, { draft: false }, { prerelease: true }, { immutable: true }]) {
  test(`rejects an unsuitable GitHub release ${JSON.stringify(release)}`, async (t) => {
    const { state, options } = await fixture(t, { release });
    await assert.rejects(attach(options), /release/i);
    assert.equal(state.posts, 0);
    assert.equal(state.metadataReads, 0);
  });
}

test('bounded registry propagation retries allow a just-published version but stop when unavailable', async (t) => {
  const { state, options } = await fixture(t, { unavailable: 2 });
  assert.equal((await attach(options)).action, 'uploaded');
  assert.equal(state.metadataReads, 3);
  const missing = await fixture(t, { unavailable: 99 });
  await assert.rejects(attach(missing.options), /registry/i);
  assert.ok(missing.state.metadataReads === 61);
  assert.equal(missing.state.posts, 0);
});

for (const race of ['same', 'different']) {
  test(`concurrent upload ${race} bytes is compared without overwriting`, async (t) => {
    const { state, options } = await fixture(t, { race });
    if (race === 'same') {
      assert.equal((await attach(options)).action, 'unchanged');
    } else {
      await assert.rejects(attach(options), /existing.*differs/i);
    }
    assert.equal(state.posts, 1);
  });
}

test('CLI failures omit assertion diffs from logs', async () => {
  const { stderr } = await promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL('../scripts/attach-published-tarball.mjs', import.meta.url))],
    {
      env: {
        ...process.env,
        NPM_PACKAGE_NAME: name,
        NPM_PACKAGE_VERSION: version,
        RELEASE_TAG: 'v9.9.9-sensitive-response',
        GITHUB_REPOSITORY: 'owner/repo',
        GH_TOKEN: 'fixture-token',
      },
    },
  ).catch((error) => error);
  assert.match(stderr, /release tag must match the package version/);
  assert.doesNotMatch(stderr, /sensitive-response/);
});

test('draft preflight reads GitHub only and requires an existing draft', async (t) => {
  const { preflightDraftRelease } = await import('../scripts/attach-published-tarball.mjs');
  const { state, options } = await fixture(t);
  await preflightDraftRelease(options);
  assert.equal(state.metadataReads, 0);
  assert.equal(state.posts, 0);
  assert.ok(state.calls.every((call) => call.startsWith('GET /repos/')));
});

test('draft lookup finds paginated tags and rejects missing or duplicate matches', async (t) => {
  const { preflightDraftRelease } = await import('../scripts/attach-published-tarball.mjs');
  const releases = Array.from({ length: 100 }, (_, id) => ({
    id: id + 100,
    tag_name: `v0.0.${id}`,
    draft: false,
  }));
  const target = { id: 42, tag_name: 'v1.2.3', draft: true, prerelease: false };
  const { state, options } = await fixture(t, {
    releases: [...releases, target],
  });
  assert.equal((await preflightDraftRelease(options)).release.id, 42);
  assert.equal(state.metadataReads, 0);
  state.releases = [];
  await assert.rejects(preflightDraftRelease(options), /exactly one/);
  state.releases = [target, { ...target, id: 43 }];
  await assert.rejects(preflightDraftRelease(options), /exactly one/);
  assert.equal(state.posts, 0);
});

test('stage diagnostics omit arbitrary transport errors and response details', async (t) => {
  const { preflightDraftRelease, attachPublishedTarball, releaseFailureMessage } =
    await import('../scripts/attach-published-tarball.mjs');
  const { options } = await fixture(t);
  const secret = 'response-body-and-token-must-not-be-logged';
  const failing = async () => {
    throw new Error(secret);
  };
  await assert.rejects(preflightDraftRelease({ ...options, fetch: failing }), (error) => {
    const message = releaseFailureMessage(error);
    assert.match(message, /\[draft-preflight\]/);
    assert.doesNotMatch(message, /response-body-and-token/);
    return true;
  });
  await assert.rejects(
    attachPublishedTarball({
      ...options,
      fetch: (url, init) => (String(url).startsWith(`${options.registry}/%40`) ? failing() : fetch(url, init)),
    }),
    (error) => {
      const message = releaseFailureMessage(error);
      assert.match(message, /\[registry-metadata\]/);
      assert.doesNotMatch(message, /response-body-and-token/);
      return true;
    },
  );
});
