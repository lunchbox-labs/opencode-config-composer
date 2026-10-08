import assert from 'node:assert/strict';
import { once } from 'node:events';
import { type ServerResponse, createServer, request as forwardRequest } from 'node:http';
import type { TestContext } from 'node:test';

export interface RelayRequest {
  method: string;
  path: string;
  directory?: string;
  body: Buffer;
  status?: number;
}

/** Records and delays transport while forwarding to the genuine native host or local provider. */
export async function httpRelay(t: TestContext, upstream: () => string) {
  const requests: RelayRequest[] = [];
  let intercept: ((request: RelayRequest, response: ServerResponse) => Promise<void>) | undefined;
  let interceptResponse: ((request: RelayRequest) => Promise<void>) | undefined;
  const server = createServer((incoming, outgoing) => {
    const forward = async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) {
        chunks.push(Buffer.from(chunk as Uint8Array));
      }
      const url = new URL(incoming.url ?? '/', 'http://127.0.0.1');
      const directory = url.searchParams.get('directory') ?? incoming.headers['x-opencode-directory'];
      const record: RelayRequest = {
        method: incoming.method ?? 'GET',
        path: url.pathname,
        ...(typeof directory === 'string' ? { directory } : {}),
        body: Buffer.concat(chunks),
      };
      requests.push(record);
      await intercept?.(record, outgoing);
      if (outgoing.writableEnded || outgoing.destroyed) {
        record.status = outgoing.statusCode;
        return;
      }
      const target = new URL(incoming.url ?? '/', upstream());
      const forwarded = forwardRequest(target, { method: record.method, headers: incoming.headers }, (response) => {
        record.status = response.statusCode;
        Promise.resolve()
          .then(() => interceptResponse?.(record))
          .then(() => {
            outgoing.writeHead(response.statusCode ?? 502, response.headers);
            response.pipe(outgoing);
          })
          .catch((error: unknown) => outgoing.destroy(error instanceof Error ? error : undefined));
      });
      outgoing.on('close', () => forwarded.destroy());
      forwarded.on('error', (error) => outgoing.destroy(error));
      forwarded.end(record.body);
    };
    void forward().catch((error: unknown) => outgoing.destroy(error instanceof Error ? error : undefined));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    intercept(next?: typeof intercept) {
      intercept = next;
    },
    interceptResponse(next?: typeof interceptResponse) {
      interceptResponse = next;
    },
  };
}
