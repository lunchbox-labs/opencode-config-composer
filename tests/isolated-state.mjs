import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Each test process owns its state, including when the caller has personal state configured.
const directory = mkdtempSync(join(tmpdir(), 'composer-test-state-'));
process.env.XDG_STATE_HOME = directory;
process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
