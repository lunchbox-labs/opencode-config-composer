import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { installPackage } from './install-package.ts';

test('OpenCode renders packaged compose inspection and legacy menus', { timeout: 140_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'composer-tui-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configRoot = join(root, 'config', 'opencode');
  const project = join(root, 'project');
  await mkdir(configRoot, { recursive: true });
  await mkdir(project);
  const installed = await installPackage(configRoot);
  let requests = 0;
  const provider = createServer((_request, response) => {
    requests++;
    response.writeHead(500);
    response.end('The terminal check must not send a model request.');
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  t.after(() => {
    provider.closeAllConnections();
    provider.close();
  });
  const address = provider.address();
  assert.ok(address !== null && typeof address !== 'string');
  await writeFile(
    join(configRoot, 'opencode.jsonc'),
    JSON.stringify({
      plugin: [installed.directory],
      model: 'fixture/model',
      small_model: 'fixture/model',
      default_agent: 'worker',
      enabled_providers: ['fixture'],
      provider: {
        fixture: {
          name: 'Fixture',
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'synthetic-test-key' },
          models: { model: { name: 'Fixture model', limit: { context: 8192, output: 256 } } },
        },
      },
      agent: { worker: { mode: 'primary', groups: ['workers'], prompt: 'Reply briefly.' } },
    }),
  );
  await writeFile(
    join(configRoot, 'config-composer.jsonc'),
    JSON.stringify({ agent: { groups: { workers: { model: 'fixture/model' } } }, command: {}, skill: {} }),
  );
  await writeFile(join(configRoot, 'tui.jsonc'), JSON.stringify({ plugin: [installed.directory] }));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CACHE_HOME: join(root, 'cache'),
    OPENCODE_TEST_HOME: root,
    OPENCODE_DB: join(root, 'db.sqlite'),
    OPENCODE_CONFIG: '',
    OPENCODE_CONFIG_CONTENT: '',
    OPENCODE_SERVER_PASSWORD: '',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: 'true',
  };
  delete env.OPENCODE_CONFIG_DIR;
  delete env.OPENCODE_DISABLE_PROJECT_CONFIG;
  const result = await promisify(execFile)(
    'python3',
    [fileURLToPath(new URL('./native-tui.py', import.meta.url)), process.env.OPENCODE_BIN ?? 'opencode', project],
    { env, timeout: 130_000, maxBuffer: 1_000_000 },
  );
  assert.match(result.stdout, /native TUI rendered both Composer menus/);
  assert.match(result.stdout, /native TUI rendered compose inspection and nested navigation/);
  assert.equal(requests, 0, 'opening Composer menus must not send a model prompt');
});
