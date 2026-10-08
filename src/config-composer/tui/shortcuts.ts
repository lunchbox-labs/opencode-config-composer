import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import { isDeepStrictEqual } from 'node:util';
import type { Snapshot } from '../storage.ts';
import { SettingsError } from '../settings.ts';
import { shortcutCommandPrefix, validateShortcutCommands } from '../composition/shortcuts.ts';

export function profileShortcutRegistration(
  api: TuiPluginApi,
  load: () => Promise<Snapshot>,
  open: (snapshot: Snapshot, name: string, validate: () => Promise<void>) => void,
  execute: (action: () => Promise<void>) => void | Promise<void>,
  checkpoint: () => () => boolean,
) {
  let generation = 0;
  let current: Snapshot | undefined;
  let remove: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  const clear = () => {
    current = undefined;
    const previous = remove;
    remove = undefined;
    previous?.();
  };
  const notify = (error: unknown) => {
    if (!api.lifecycle.signal.aborted) {
      api.ui.toast({
        variant: 'error',
        title: 'Profile shortcuts',
        message:
          error instanceof SettingsError
            ? error.message
            : 'Could not refresh profile shortcuts. Reopen Compose after checking the server connection.',
        duration: 8000,
      });
    }
  };
  const registeredNames = () =>
    api.keymap
      .getCommands({ visibility: 'registered' })
      .flatMap((command) =>
        command.name.startsWith(shortcutCommandPrefix)
          ? []
          : [
              command.slashName,
              ...(Array.isArray(command.slashAliases)
                ? command.slashAliases.filter((name: unknown): name is string => typeof name === 'string')
                : []),
            ].filter((name): name is string => typeof name === 'string'),
      );
  const assertContext = (snapshot: Snapshot, client: TuiPluginApi['client']) => {
    const path = api.state.path as { directory?: string; worktree?: string };
    if (
      api.client !== client ||
      api.lifecycle.signal.aborted ||
      (path.directory ?? snapshot.sourceContext.root) !== snapshot.nativeDirectory ||
      (path.worktree !== undefined && path.worktree !== '' && path.worktree !== '/'
        ? path.worktree
        : (path.directory ?? snapshot.root)) !== snapshot.sourceContext.root
    ) {
      throw new SettingsError('The shortcut instance or connection changed. Refresh profile shortcuts in Compose.');
    }
  };
  const validate = async (snapshot: Snapshot, client: TuiPluginApi['client']) => {
    const response = await client.command.list({ directory: snapshot.nativeDirectory });
    assertContext(snapshot, client);
    if (Boolean(response.error) || response.data === undefined) {
      throw new SettingsError('Could not check native command names. Refresh profile shortcuts before using them.');
    }
    validateShortcutCommands(snapshot.sources, [...registeredNames(), ...response.data.map((command) => command.name)]);
  };
  const refresh = async () => {
    const token = ++generation;
    clear();
    try {
      const client = api.client;
      const snapshot = await load();
      assertContext(snapshot, client);
      if (token !== generation) {
        return;
      }
      const entries = Object.entries(snapshot.sources.registry.profileShortcuts ?? {});
      if (entries.length === 0) {
        return;
      }
      await validate(snapshot, client);
      if (token !== generation) {
        return;
      }
      unsubscribe ??= api.keymap.on('state', () => {
        if (current === undefined) {
          return;
        }
        try {
          validateShortcutCommands(current.sources, registeredNames());
        } catch (error) {
          clear();
          notify(error);
        }
      });
      current = snapshot;
      remove = api.keymap.registerLayer({
        commands: entries.map(([name, shortcut]) => ({
          name: `${shortcutCommandPrefix}${name}`,
          slashName: name,
          namespace: 'palette',
          category: 'Config',
          title: `Profiles: ${shortcut.activeProfiles.length === 0 ? 'none' : shortcut.activeProfiles.join(' → ')}`,
          desc: shortcut.description ?? 'Choose destination, review, then save this profile selection',
          run: () =>
            execute(async () => {
              const isCurrent = checkpoint();
              const dialogWasOpen = api.ui.dialog.open;
              try {
                assertContext(snapshot, client);
                const fresh = await load();
                assertContext(snapshot, client);
                if (!isDeepStrictEqual(fresh.sources.registry.profileShortcuts?.[name], shortcut)) {
                  throw new SettingsError(
                    `Shortcut /${name} changed. Refresh shortcuts in Compose before reviewing its new selection.`,
                  );
                }
                const validateCurrent = async () => {
                  await validate(fresh, client);
                  if (token !== generation) {
                    throw new SettingsError('Shortcut registrations changed. Refresh shortcuts in Compose.');
                  }
                };
                await validateCurrent();
                if (!isCurrent() || api.ui.dialog.open !== dialogWasOpen) {
                  return;
                }
                open(fresh, name, validateCurrent);
              } catch (error) {
                notify(error);
              }
            }),
        })),
      });
    } catch (error) {
      if (token === generation) {
        clear();
        notify(error);
      }
    }
  };
  return {
    refresh,
    dispose: () => {
      generation++;
      clear();
      unsubscribe?.();
    },
  };
}
