import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { validateBaseline, validateCliVersion, validateTestVersion } from '../scripts/opencode.mjs';

function fixture() {
  const manifest = {
    engines: { node: '>=22.18.0' },
    devDependencies: { '@opencode-ai/plugin': '4.5.6', '@opencode-ai/sdk': '7.8.9' },
  };
  const lock = {
    packages: {
      '': structuredClone(manifest),
      'node_modules/@opencode-ai/plugin': { version: '4.5.6' },
      'node_modules/@opencode-ai/sdk': { version: '7.8.9' },
    },
  };
  return { manifest, lock, testConfig: { range: '1.2.x', floor: '1.2.3' } };
}

test('the CLI baseline and independently pinned host libraries can use different versions', () => {
  const { manifest, lock, testConfig } = fixture();
  assert.equal(validateBaseline(manifest, lock, testConfig), '1.2.3');
});

test('a range or a stale lockfile cannot select the tested CLI', () => {
  const { manifest, lock, testConfig } = fixture();
  testConfig.floor = '^1.2.3';
  assert.throws(() => validateBaseline(manifest, lock, testConfig), /exact stable CLI version/);
  testConfig.floor = '1.3.0';
  assert.throws(() => validateBaseline(manifest, lock, testConfig), /outside the tested host range/);
  testConfig.floor = '1.2.3';
  lock.packages[''].engines.node = '>=24';
  assert.throws(() => validateBaseline(manifest, lock, testConfig), /lockfile engine declarations differ/);
});

test('host library drift is rejected without treating its version as a CLI release', () => {
  const { manifest, lock, testConfig } = fixture();
  lock.packages['node_modules/@opencode-ai/sdk'].version = '7.8.10';
  assert.throws(() => validateBaseline(manifest, lock, testConfig), /@opencode-ai\/sdk locked version differs/);
});

test('native checks require the actual binary to report the declared CLI baseline', () => {
  validateCliVersion('1.2.3\n', '1.2.3');
  assert.throws(() => validateCliVersion('4.5.6\n', '1.2.3'), /native OpenCode binary differs/);
});

test('supported patch boundaries include the floor and latest and exclude adjacent minors', () => {
  for (const version of ['1.19.0', '1.19.3']) {
    assert.equal(validateTestVersion(version, '1.19.x'), version);
  }
  for (const version of ['1.18.34', '1.20.0']) {
    assert.throws(() => validateTestVersion(version, '1.19.x'), /outside the tested host range/);
  }
});

test('latest-compatible selection queries fresh metadata each invocation and ignores newer incompatible releases', async () => {
  const { resolveNativeVersion } = await import('../scripts/opencode.mjs');
  const manifest = { range: '1.19.x' };
  let calls = 0;
  const readVersions = async () => {
    calls++;
    return calls === 1 ? ['1.19.0', '1.19.9', '1.19.10-beta.1', '1.20.0'] : ['1.19.0', '1.19.9', '1.19.10', '2.0.0'];
  };
  assert.equal(await resolveNativeVersion(manifest, { readVersions, override: undefined }), '1.19.9');
  assert.equal(await resolveNativeVersion(manifest, { readVersions, override: undefined }), '1.19.10');
  assert.equal(calls, 2);
});

test('native selection rejects empty metadata, malformed metadata and incompatible explicit versions', async () => {
  const { resolveNativeVersion } = await import('../scripts/opencode.mjs');
  const manifest = { range: '1.19.x' };
  await assert.rejects(
    resolveNativeVersion(manifest, { readVersions: async () => ['1.20.0'], override: undefined }),
    /no stable published/,
  );
  await assert.rejects(
    resolveNativeVersion(manifest, { readVersions: async () => '1.19.3', override: undefined }),
    /versions must be an array/,
  );
  await assert.rejects(resolveNativeVersion(manifest, { override: '1.20.0' }), /outside the tested host range/);
  assert.equal(
    await resolveNativeVersion(manifest, {
      override: '1.19.0',
      readVersions: () => {
        throw new Error('floor must not query registry');
      },
    }),
    '1.19.0',
  );
});

test('selection honors a narrowed support range and propagates registry failures', async () => {
  const { resolveNativeVersion, npmInvocation } = await import('../scripts/opencode.mjs');
  assert.equal(
    await resolveNativeVersion(
      { range: '>=1.19.0 <1.19.3' },
      {
        readVersions: async () => ['1.19.2', '1.19.3', '1.20.0'],
      },
    ),
    '1.19.2',
  );
  await assert.rejects(
    resolveNativeVersion(
      { range: '1.19.x' },
      {
        readVersions: async () => {
          throw new Error('registry unavailable');
        },
      },
    ),
    /registry unavailable/,
  );
  assert.deepEqual(npmInvocation('C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js', 'win32'), {
    command: process.execPath,
    args: ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'],
  });
});

test(
  'real npm metadata is fresh on repeated resolution and registry failure cannot reuse stale data',
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'composer-metadata-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    let requests = 0;
    let phase = 1;
    const server = createServer((request, response) => {
      if (request.url === '/advance') {
        phase++;
        response.end();
        return;
      }
      if (request.url !== '/opencode-ai') {
        response.writeHead(404);
        response.end();
        return;
      }
      requests++;
      if (phase > 2) {
        response.writeHead(503);
        response.end('registry unavailable');
        return;
      }
      const versions = phase === 1 ? ['1.19.0', '1.19.2', '1.20.0'] : ['1.19.0', '1.19.2', '1.19.10', '2.0.0'];
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          name: 'opencode-ai',
          'dist-tags': { latest: versions.at(-1) },
          versions: Object.fromEntries(versions.map((version) => [version, { name: 'opencode-ai', version }])),
        }),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const address = server.address();
    assert.ok(address !== null && typeof address !== 'string');
    const source = `import assert from 'node:assert/strict';
    import { resolveNativeVersion } from ${JSON.stringify(new URL('../scripts/opencode.mjs', import.meta.url).href)};
    const manifest = { range: '1.19.x' };
    const options = { override: undefined };
    assert.equal(await resolveNativeVersion(manifest, options), '1.19.2');
    await fetch('http://127.0.0.1:${address.port}/advance');
    assert.equal(await resolveNativeVersion(manifest, options), '1.19.10');
    await fetch('http://127.0.0.1:${address.port}/advance');
    await assert.rejects(resolveNativeVersion(manifest, options), /503|E503/);
    console.log('fresh registry resolution verified');`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], {
      cwd: root,
      env: {
        ...process.env,
        npm_config_registry: `http://127.0.0.1:${address.port}`,
        NPM_CONFIG_REGISTRY: `http://127.0.0.1:${address.port}`,
        npm_config_fetch_retries: '0',
        NPM_CONFIG_FETCH_RETRIES: '0',
        npm_config_userconfig: join(root, '.npmrc'),
        NPM_CONFIG_USERCONFIG: join(root, '.npmrc'),
      },
      timeout: 45_000,
    });
    assert.match(stdout, /fresh registry resolution verified/);
    assert.ok(requests >= 3);
  },
);

test('published metadata preserves Node engines and keeps the OpenCode range test-only', async () => {
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(manifest.engines.node, '>=22.18.0');
  assert.equal(Object.hasOwn(manifest.engines, 'opencode'), false);
  assert.deepEqual(lock.packages[''].engines, manifest.engines);
  assert.equal(Object.hasOwn(manifest, 'opencodeTestVersion'), false);
  const testConfig = JSON.parse(await readFile(new URL('./opencode.json', import.meta.url), 'utf8'));
  assert.deepEqual(testConfig, { range: '1.19.x', floor: '1.19.0' });
});

test('minimum coverage selects the configured test floor without querying npm', async () => {
  const { resolveNativeVersion } = await import('../scripts/opencode.mjs');
  assert.equal(
    await resolveNativeVersion(
      { range: '1.19.x', floor: '1.19.0' },
      {
        override: 'minimum',
        readVersions: () => {
          throw new Error('minimum must not query registry');
        },
      },
    ),
    '1.19.0',
  );
});
