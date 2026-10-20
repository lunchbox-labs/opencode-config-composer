import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

/** Serve the packed package through a scoped npm registry, retaining its normal identity. */
export async function npmRegistration(t: TestContext, directory: string, home: string) {
  const files = await readdir(join(directory, 'tarballs'));
  assert.equal(files.length, 1);
  const bytes = await readFile(join(directory, 'tarballs', files[0]));
  const manifest = JSON.parse(
    await readFile(join(directory, 'node_modules/@lunchbox-labs/opencode-config-composer/package.json'), 'utf8'),
  ) as { name: string; version: string };
  let registry = '';
  const server = createServer((request, response) => {
    if (request.url === '/package.tgz') {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      response.end(bytes);
      return;
    }
    if (decodeURIComponent(request.url ?? '') !== `/${manifest.name}`) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        name: manifest.name,
        'dist-tags': { latest: manifest.version },
        versions: {
          [manifest.version]: { ...manifest, dist: { tarball: `${registry}/package.tgz` } },
        },
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
  registry = `http://127.0.0.1:${address.port}`;
  await writeFile(join(home, '.npmrc'), `@lunchbox-labs:registry=${registry}\n`);
  return `${manifest.name}@${manifest.version}`;
}
