import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

// Separate from configuration.ts so the TUI entry can locate the directory without loading the JSONC parser.
export function configurationDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.OPENCODE_CONFIG_DIR;
  if (configured !== undefined && configured !== '') {
    return resolve(configured);
  }
  const xdg = environment.XDG_CONFIG_HOME;
  return xdg !== undefined && isAbsolute(xdg) ? join(xdg, 'opencode') : join(homedir(), '.config', 'opencode');
}
