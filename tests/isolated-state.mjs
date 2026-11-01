import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Each test process owns its state and profile selection, including when the caller has personal state or a
// process profile configured. Tests that need a process profile set it themselves.
const directory = mkdtempSync(join(tmpdir(), 'composer-test-state-'));
process.env.XDG_STATE_HOME = directory;
delete process.env.OPENCODE_CONFIG_COMPOSER_PROFILE;
process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
