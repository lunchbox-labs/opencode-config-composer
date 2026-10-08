import { CompositionValidationError } from './document.ts';
import type { LoadedSources } from './sources.ts';

export const shortcutCommandPrefix = 'config-composer.shortcut.';
export const reservedShortcuts = new Set(['compose', 'agent-models', 'agent-groups', 'reload-configs']);

/** Check native prompt commands and all registered TUI slash names/aliases without overriding them. */
export function validateShortcutCommands(
  sources: Pick<LoadedSources, 'registry' | 'provenance'>,
  commands: Iterable<string>,
): void {
  const existing = new Set(commands);
  for (const name of Object.keys(sources.registry.profileShortcuts ?? {})) {
    if (reservedShortcuts.has(name) || existing.has(name)) {
      const pointer = `/profileShortcuts/${name}`;
      throw new CompositionValidationError({
        code: 'shortcut-command-conflict',
        sourceId: sources.provenance[pointer].sourceId,
        pointer,
        message: `Shortcut /${name} conflicts with ${reservedShortcuts.has(name) ? 'a reserved Composer action' : 'an existing command or alias'}. Choose a different shortcut name.`,
      });
    }
  }
}
