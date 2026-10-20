import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

/** A real npm tarball specification: native Npm.add and engine validation remain active. */
export async function npmRegistration(t: TestContext, root: string) {
  const files = await readdir(join(root, 'tarballs'));
  assert.equal(files.length, 1);
  const bytes = await readFile(join(root, 'tarballs', files[0]));
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    response.end(bytes);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}/${files[0]}`;
}
