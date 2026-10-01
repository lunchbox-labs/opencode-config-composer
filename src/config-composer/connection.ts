import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import { SettingsError } from './settings.ts';

export async function verifySharedFilesystem(api: TuiPluginApi, root: string, serverRoot: string) {
  const client = api.client;
  const probe = await mkdtemp(join(root, '.config-composer-probe-'));
  try {
    const content = randomBytes(32).toString('hex');
    await writeFile(join(probe, 'proof.txt'), content, { mode: 0o600, flag: 'wx' });
    const response = await client.file.read(
      { directory: serverRoot, path: join(serverRoot, basename(probe), 'proof.txt') },
      { signal: AbortSignal.any([api.lifecycle.signal, AbortSignal.timeout(5000)]) },
    );
    if (response.error !== undefined || response.data.type !== 'text' || response.data.content !== content) {
      throw new Error('Filesystem challenge failed.');
    }
  } catch {
    throw new SettingsError(
      'Could not verify a shared filesystem with this OpenCode server. Settings were not changed. Use the editor on the server machine.',
    );
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
  if (api.client !== client || api.lifecycle.signal.aborted) {
    throw new SettingsError('The server connection changed. Reopen the settings editor.');
  }
  return client;
}
