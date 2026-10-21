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

const commit = 'a'.repeat(40);
const other = 'b'.repeat(40);
const name = '@fixture/package';
const version = '1.2.3';
const tag = 'v1.2.3';
const assetName = 'fixture-package-1.2.3.tgz';

async function fixture(t, initial = {}) {
  const root = await mkdtemp(join(tmpdir(), 'release-lifecycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'package'));
  await writeFile(join(root, 'package/package.json'), JSON.stringify({ name, version, ...initial.manifest }));
  const tarball = join(root, 'verified.tgz');
  await promisify(execFile)('tar', ['-czf', tarball, '-C', root, 'package']);
  const bytes = await readFile(tarball);
  const state = {
    tag: undefined,
    release: undefined,
    assets: [],
    registry: false,
    publishes: 0,
    calls: [],
    writes: [],
    remoteBytes: bytes,
    metadata: {},
    ...initial,
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, base);
    const path = decodeURIComponent(url.pathname);
    state.calls.push(`${request.method} ${path}`);
    const json = (status, data) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(data));
    };
    if (path === `/${name}/${version}`) {
      state.metadataReads = (state.metadataReads ?? 0) + 1;
      if (state.metadataReads <= (state.unavailable ?? 0)) {
        json(404, {});
        return;
      }
      assert.equal(request.headers.authorization, undefined);
      json(
        state.registry ? 200 : 404,
        state.registry
          ? {
              name,
              version,
              dist: {
                tarball: `${base}/published.tgz`,
                integrity: `sha512-${createHash('sha512').update(state.remoteBytes).digest('base64')}`,
              },
              ...state.metadata,
            }
          : {},
      );
      return;
    }
    if (path === '/published.tgz') {
      if (state.redirect) {
        response.writeHead(302, { Location: state.redirect });
        response.end();
        return;
      }
      assert.equal(request.headers.authorization, undefined);
      response.end(state.remoteBytes);
      return;
    }
    assert.equal(request.headers.authorization, 'Bearer fixture-token');
    if (request.method !== 'GET') {
      state.writes.push(`${request.method} ${path}`);
    }
    let body;
    if (['POST', 'PATCH'].includes(request.method) && !url.searchParams.has('name')) {
      const chunks = [];
      for await (const chunk of request) {
        chunks.push(chunk);
      }
      body = JSON.parse(Buffer.concat(chunks).toString());
    }
    if (path.startsWith('/repos/owner/repo/commits/')) {
      const ref = path.split('/').at(-1);
      json(200, { sha: ref === 'main' ? (state.main ?? commit) : ref });
      return;
    }
    if (path === `/repos/owner/repo/compare/${commit}...main`) {
      json(200, { status: state.comparison ?? 'identical' });
      return;
    }
    if (path === `/repos/owner/repo/git/ref/tags/${tag}`) {
      json(
        state.tag ? 200 : 404,
        state.tag
          ? {
              object: {
                type: state.annotated ? 'tag' : 'commit',
                sha: state.annotated ? other : state.tag,
              },
            }
          : {},
      );
      return;
    }
    if (path === `/repos/owner/repo/git/tags/${other}`) {
      json(200, { object: { type: 'commit', sha: state.tag } });
      return;
    }
    if (path === '/repos/owner/repo/git/refs' && request.method === 'POST') {
      assert.equal(body.ref, `refs/tags/${tag}`);
      assert.equal(state.tag, undefined, 'never replace a tag');
      state.tag = state.raceWrongTag ? other : body.sha;
      json(state.tagRace ?? 201, {
        object: { type: 'commit', sha: state.tag },
      });
      return;
    }
    if (path === '/repos/owner/repo/releases' && request.method === 'GET') {
      json(200, state.release && !state.staleReleaseList ? [state.release] : []);
      return;
    }
    if (path === '/repos/owner/repo/releases/generate-notes' && request.method === 'POST') {
      assert.deepEqual(body, { tag_name: tag, target_commitish: commit });
      json(
        state.notesFailure ? 503 : 200,
        state.notes ?? {
          name: 'Generated release title',
          body: 'Generated release notes',
        },
      );
      return;
    }
    if (path === '/repos/owner/repo/releases' && request.method === 'POST') {
      assert.equal(state.release, undefined, 'never replace a release');
      state.release = {
        id: 42,
        ...body,
        ...(state.releaseRace ? { name: 'Concurrent title', body: 'Concurrent body' } : {}),
        immutable: false,
      };
      json(state.releaseRace ?? 201, {
        ...state.release,
        ...state.createdResponse,
      });
      return;
    }
    if (path === '/repos/owner/repo/releases/42' && request.method === 'PATCH') {
      assert.equal(body.draft, false);
      assert.ok(
        state.assets.some((asset) => asset.name === assetName),
        'publish only after attachment',
      );
      if (state.failFinalization) {
        json(503, { message: 'private response' });
        return;
      }
      state.release = { ...state.release, draft: false, immutable: true };
      json(200, state.release);
      return;
    }
    if (path === '/repos/owner/repo/releases/42/assets' && request.method === 'GET') {
      json(
        200,
        state.assets.map((asset) => ({ id: asset.id, name: asset.name })),
      );
      return;
    }
    if (path === '/repos/owner/repo/releases/42/assets' && request.method === 'POST') {
      if (state.failUpload) {
        json(503, {});
        return;
      }
      assert.equal(state.release.draft, true, 'cannot attach after publication');
      const chunks = [];
      for await (const chunk of request) {
        chunks.push(chunk);
      }
      const asset = {
        id: 99,
        name: url.searchParams.get('name'),
        bytes: Buffer.concat(chunks),
      };
      state.assets.push(asset);
      json(201, { id: asset.id, name: asset.name });
      return;
    }
    if (path === '/repos/owner/repo/releases/assets/99') {
      if (state.assetRedirect) {
        response.writeHead(302, { Location: state.assetRedirect });
        response.end();
        return;
      }
      response.end(state.assets.find((asset) => asset.id === 99).bytes);
      return;
    }
    json(404, {});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return {
    state,
    bytes,
    options: {
      name,
      version,
      tag,
      commit,
      repository: 'owner/repo',
      token: 'fixture-token',
      api: base,
      uploads: base,
      registry: base,
      retryDelay: 0,
      tarball,
      access: 'public',
      publish: async () => {
        state.publishes++;
        state.registry = true;
        if (state.failNpmResponse) {
          throw new Error('lost npm response');
        }
      },
    },
  };
}

async function lifecycle() {
  return import('../scripts/release-lifecycle.mjs');
}
const draft = (change = {}) => ({
  id: 42,
  tag_name: tag,
  target_commitish: 'main',
  draft: true,
  prerelease: false,
  immutable: false,
  ...change,
});

test('one lifecycle creates exact tag and draft, publishes npm, attaches bytes, then publishes immutable release; rerun is read-only', async (t) => {
  const { prepareRelease, publishNpmRelease, finishRelease } = await lifecycle();
  const { state, bytes, options } = await fixture(t);
  await prepareRelease(options);
  assert.equal(state.tag, commit);
  assert.equal(state.release.draft, true);
  await publishNpmRelease(options);
  assert.equal(state.publishes, 1);
  await finishRelease(options);
  assert.deepEqual(state.assets[0].bytes, bytes);
  assert.equal(state.release.draft, false);
  assert.equal(state.release.immutable, true);
  assert.equal(state.release.name, 'Generated release title');
  assert.equal(state.release.body, 'Generated release notes');
  const writes = state.writes.length;
  await prepareRelease(options);
  await publishNpmRelease(options);
  await finishRelease(options);
  assert.equal(state.publishes, 1);
  assert.equal(state.writes.length, writes);
});

test('user draft targeting main with no tag is reused with the exact intended commit', async (t) => {
  const { prepareRelease } = await lifecycle();
  const { state, options } = await fixture(t, {
    release: draft({ name: 'User title', body: 'User notes' }),
  });
  await prepareRelease(options);
  assert.equal(state.tag, commit);
  assert.deepEqual(state.writes, ['POST /repos/owner/repo/git/refs']);
  assert.equal(state.release.name, 'User title');
  assert.equal(state.release.body, 'User notes');
});

for (const initial of [
  { tag: other },
  { release: draft({ target_commitish: other }) },
  { release: draft({ prerelease: true }) },
  { comparison: 'diverged' },
]) {
  test(`preparation rejects conflicting state without mutation ${JSON.stringify(initial)}`, async (t) => {
    const { prepareRelease } = await lifecycle();
    const { state, options } = await fixture(t, initial);
    await assert.rejects(prepareRelease(options));
    assert.equal(state.writes.length, 0);
  });
}

for (const metadata of [
  { name: '@wrong/package' },
  { version: '9.9.9' },
  { gitHead: other },
  {
    dist: {
      integrity: 'sha512-invalid',
      tarball: 'https://example.invalid/package.tgz',
    },
  },
]) {
  test(`npm existing mismatch is never republished ${JSON.stringify(metadata)}`, async (t) => {
    const { publishNpmRelease } = await lifecycle();
    const { state, options } = await fixture(t, {
      tag: commit,
      release: draft(),
      registry: true,
      metadata,
    });
    await assert.rejects(publishNpmRelease(options));
    assert.equal(state.publishes, 0);
    assert.equal(state.writes.length, 0);
  });
}

test('lost npm response can resume from exact registry bytes without a second publish', async (t) => {
  const { publishNpmRelease } = await lifecycle();
  const { state, options } = await fixture(t, {
    tag: commit,
    release: draft(),
    failNpmResponse: true,
  });
  await assert.rejects(publishNpmRelease(options));
  state.failNpmResponse = false;
  await publishNpmRelease(options);
  assert.equal(state.publishes, 1);
});

test('attachment failure leaves draft unpublished and finalization retry reuses identical asset', async (t) => {
  const { finishRelease } = await lifecycle();
  const { state, options } = await fixture(t, {
    tag: commit,
    release: draft(),
    registry: true,
    failUpload: true,
  });
  await assert.rejects(finishRelease(options));
  assert.equal(state.release.draft, true);
  assert.equal(
    state.writes.some((call) => call.startsWith('PATCH')),
    false,
  );
  state.failUpload = false;
  state.failFinalization = true;
  await assert.rejects(finishRelease(options));
  assert.equal(state.assets.length, 1);
  assert.equal(state.release.draft, true);
  state.failFinalization = false;
  await finishRelease(options);
  assert.equal(state.assets.length, 1);
  assert.equal(state.release.draft, false);
});

test('published immutable release without the expected asset fails without writes', async (t) => {
  const { finishRelease } = await lifecycle();
  const { state, options } = await fixture(t, {
    tag: commit,
    release: draft({ draft: false, immutable: true }),
    registry: true,
  });
  await assert.rejects(finishRelease(options));
  assert.equal(state.writes.length, 0);
});

test('finalization rejects published registry bytes differing from the verified artifact', async (t) => {
  const { finishRelease } = await lifecycle();
  const { state, options } = await fixture(t, {
    tag: commit,
    release: draft(),
    registry: true,
  });
  state.remoteBytes = Buffer.from('different archive bytes');
  await assert.rejects(finishRelease(options));
  assert.equal(state.writes.length, 0);
});

test('existing draft asset mismatch blocks npm publication before any mutation', async (t) => {
  const { publishNpmRelease } = await lifecycle();
  const { state, options } = await fixture(t, {
    tag: commit,
    release: draft(),
    assets: [{ id: 99, name: assetName, bytes: Buffer.from('different') }],
  });
  await assert.rejects(publishNpmRelease(options));
  assert.equal(state.publishes, 0);
  assert.equal(state.writes.length, 0);
});

test('published release with a missing tag cannot be rebound to a new commit', async (t) => {
  const { prepareRelease } = await lifecycle();
  const { state, options } = await fixture(t, {
    release: draft({ draft: false, immutable: true, target_commitish: other }),
  });
  await assert.rejects(prepareRelease(options));
  assert.equal(state.writes.length, 0);
});

test('invalid local package identity is rejected before npm publication', async (t) => {
  const { publishNpmRelease } = await lifecycle();
  const { state, options } = await fixture(t, {
    tag: commit,
    release: draft(),
    manifest: { name: '@wrong/package' },
  });
  await assert.rejects(publishNpmRelease(options));
  assert.equal(state.publishes, 0);
});

test('registry foreign-host archive URLs are rejected before requesting that host', async (t) => {
  const { publishNpmRelease } = await lifecycle();
  const { bytes, state, options } = await fixture(t, {
    tag: commit,
    release: draft(),
    registry: true,
  });
  state.metadata.dist = {
    tarball: 'https://foreign.invalid/archive.tgz',
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  };
  let foreignRequests = 0;
  await assert.rejects(
    publishNpmRelease({
      ...options,
      fetch: (url, init) => {
        if (!String(url).startsWith(`${options.api}/`)) {
          foreignRequests++;
          throw new Error('foreign request');
        }
        return fetch(url, init);
      },
    }),
  );
  assert.equal(foreignRequests, 0);
  assert.equal(state.publishes, 0);
});

test('registry archive redirects are refused before contacting the redirect host', async (t) => {
  const { publishNpmRelease } = await lifecycle();
  const { state, options } = await fixture(t, {
    tag: commit,
    release: draft(),
    registry: true,
  });
  let foreignRequests = 0;
  const foreign = createServer((request, response) => {
    foreignRequests++;
    assert.equal(request.headers.authorization, undefined);
    response.end('foreign');
  });
  foreign.listen(0, '127.0.0.1');
  await once(foreign, 'listening');
  t.after(() => {
    foreign.closeAllConnections();
    foreign.close();
  });
  state.redirect = `http://127.0.0.1:${foreign.address().port}/archive.tgz`;
  await assert.rejects(publishNpmRelease(options));
  assert.equal(foreignRequests, 0);
  assert.equal(state.publishes, 0);
});

test('finish waits through initial registry propagation misses before final publication', async (t) => {
  const { finishRelease } = await lifecycle();
  const { state, options } = await fixture(t, {
    tag: commit,
    release: draft(),
    registry: true,
    unavailable: 2,
  });
  await finishRelease(options);
  assert.equal(state.publishes, 0);
  assert.equal(state.release.draft, false);
  assert.ok(state.metadataReads >= 3);
});

test('realistic GitHub asset redirect downloads without forwarding GitHub credentials', async (t) => {
  const { finishRelease } = await lifecycle();
  const { bytes, state, options } = await fixture(t, {
    tag: commit,
    release: draft({ draft: false, immutable: true }),
    registry: true,
    assetRedirect: 'https://release-assets.githubusercontent.com/fixture.tgz',
  });
  state.assets = [{ id: 99, name: assetName, bytes }];
  let redirected = 0;
  await finishRelease({
    ...options,
    fetch: (url, init) => {
      if (String(url).startsWith('https://release-assets.githubusercontent.com/')) {
        redirected++;
        assert.equal(new Headers(init?.headers).has('authorization'), false);
        return Promise.resolve(new Response(bytes));
      }
      return fetch(url, init);
    },
  });
  assert.ok(redirected > 0);
  assert.equal(state.writes.length, 0);
});

test('GitHub asset redirects to foreign hosts are rejected without leaking credentials', async (t) => {
  const { finishRelease } = await lifecycle();
  const { bytes, state, options } = await fixture(t, {
    tag: commit,
    release: draft({ draft: false, immutable: true }),
    registry: true,
    assetRedirect: 'https://foreign.invalid/fixture.tgz',
  });
  state.assets = [{ id: 99, name: assetName, bytes }];
  let foreign = 0;
  await assert.rejects(
    finishRelease({
      ...options,
      fetch: (url, init) => {
        if (String(url).startsWith('https://foreign.invalid/')) {
          foreign++;
          return Promise.resolve(new Response(bytes));
        }
        return fetch(url, init);
      },
    }),
  );
  assert.equal(foreign, 0);
  assert.equal(state.writes.length, 0);
});

test('annotated existing tag is dereferenced and reused without moving it', async (t) => {
  const { prepareRelease } = await lifecycle();
  const { state, options } = await fixture(t, {
    tag: commit,
    annotated: true,
    release: draft(),
  });
  await prepareRelease(options);
  assert.equal(state.writes.length, 0);
});

for (const status of [409, 422]) {
  test(`matching tag and draft creation races HTTP${status} are reread safely`, async (t) => {
    const { prepareRelease } = await lifecycle();
    const { state, options } = await fixture(t, {
      tagRace: status,
      releaseRace: status,
    });
    await prepareRelease(options);
    assert.equal(state.tag, commit);
    assert.equal(state.release.draft, true);
    assert.equal(state.release.name, 'Concurrent title');
    assert.equal(state.release.body, 'Concurrent body');
    const writes = state.writes.length;
    await prepareRelease(options);
    assert.equal(state.writes.length, writes);
  });
}

test('conflicting concurrent tag creation fails without moving the tag', async (t) => {
  const { prepareRelease } = await lifecycle();
  const { state, options } = await fixture(t, {
    tagRace: 422,
    raceWrongTag: true,
  });
  await assert.rejects(prepareRelease(options));
  assert.equal(state.tag, other);
  assert.equal(state.release, undefined);
  assert.equal(state.writes.length, 1);
});

test('release note generation failure stops before draft creation or npm publication', async (t) => {
  const { prepareRelease } = await lifecycle();
  const { state, options } = await fixture(t, { notesFailure: true });
  await assert.rejects(prepareRelease(options), /HTTP 503/);
  assert.equal(state.release, undefined);
  assert.equal(state.publishes, 0);
  assert.ok(!state.writes.includes('POST /repos/owner/repo/releases'));
});

test('malformed generated notes stop before draft creation', async (t) => {
  const { prepareRelease } = await lifecycle();
  const { state, options } = await fixture(t, {
    notes: { name: 'Title', body: null },
  });
  await assert.rejects(prepareRelease(options), /invalid generated release notes/);
  assert.equal(state.release, undefined);
  assert.equal(state.publishes, 0);
});

for (const initial of [{ registry: true }, { registry: true, tag: commit }, { registry: true, release: draft() }]) {
  test(`existing npm version with incomplete GitHub state fails without writes ${JSON.stringify(initial)}`, async (t) => {
    const { prepareRelease } = await lifecycle();
    const { state, options } = await fixture(t, initial);
    await assert.rejects(prepareRelease(options), /missing GitHub state requires manual recovery/);
    assert.equal(state.writes.length, 0);
    assert.equal(state.publishes, 0);
  });
}

test('lifecycle diagnostics expose controlled phase and typed HTTP status without response details', async (t) => {
  const { prepareRelease, lifecycleFailureMessage } = await lifecycle();
  const { options } = await fixture(t, { notesFailure: true });
  let phase;
  let failure;
  try {
    await prepareRelease({
      ...options,
      onPhase: (value) => {
        phase = value;
      },
    });
  } catch (error) {
    failure = error;
  }
  assert.equal(phase, 'notes');
  assert.match(lifecycleFailureMessage('prepare', phase, failure), /phase=notes code=http status=503/);
  const unsafe = Object.assign(new Error('token-secret-response'), {
    status: 403,
  });
  assert.equal(
    lifecycleFailureMessage('secret-stage', 'secret-phase', unsafe),
    'Release lifecycle configuration failed: phase=operation code=request; no response details logged.',
  );
});

for (const status of [403, 422]) {
  test(`tag creation rejection HTTP${status} keeps safe status and ruleset diagnostic`, async (t) => {
    const { prepareRelease, lifecycleFailureMessage } = await lifecycle();
    const { options } = await fixture(t);
    let phase;
    let failure;
    const request = async (url, init) =>
      String(url).endsWith('/git/refs') && init?.method === 'POST'
        ? new Response(JSON.stringify({ message: 'secret-body' }), { status })
        : fetch(url, init);
    try {
      await prepareRelease({
        ...options,
        fetch: request,
        onPhase: (value) => {
          phase = value;
        },
      });
    } catch (error) {
      failure = error;
    }
    assert.equal(phase, 'tag-create');
    const diagnostic = lifecycleFailureMessage('prepare', phase, failure);
    assert.match(diagnostic, new RegExp(`phase=tag-create code=http status=${status}`));
    assert.match(diagnostic, /tag-creation rulesets/);
    assert.ok(!diagnostic.includes('secret-body'));
  });
}

test('successful draft creation uses its response even while the release list is stale', async (t) => {
  const { prepareRelease } = await lifecycle();
  const { state, options } = await fixture(t, { staleReleaseList: true });
  assert.deepEqual(await prepareRelease(options), { action: 'draft', id: 42 });
  assert.equal(state.release.tag_name, tag);
  assert.equal(state.release.draft, true);
  assert.equal(state.calls.filter((call) => call === 'GET /repos/owner/repo/releases').length, 1);
});

for (const createdResponse of [
  { id: 0 },
  { id: '42' },
  { id: 1.5 },
  { tag_name: 'v9.9.9' },
  { draft: false },
  { prerelease: true },
  { immutable: true },
]) {
  test(`invalid successful draft creation response is rejected ${JSON.stringify(createdResponse)}`, async (t) => {
    const { prepareRelease } = await lifecycle();
    const { state, options } = await fixture(t, { createdResponse });
    await assert.rejects(prepareRelease(options));
    assert.equal(state.publishes, 0);
  });
}

for (const releaseRace of [409, 422]) {
  test(`draft creation conflict HTTP${releaseRace} with stale listing preserves typed rejection`, async (t) => {
    const { prepareRelease, lifecycleFailureMessage } = await lifecycle();
    const { options } = await fixture(t, {
      releaseRace,
      staleReleaseList: true,
    });
    let phase;
    await assert.rejects(
      prepareRelease({
        ...options,
        onPhase: (value) => {
          phase = value;
        },
      }),
      (error) => {
        assert.match(
          lifecycleFailureMessage('prepare', phase, error),
          new RegExp(`phase=draft-create code=http status=${releaseRace}`),
        );
        return true;
      },
    );
  });
}
