import { resolve } from 'node:path';
import type { TuiPluginApi, TuiPluginModule } from '@opencode-ai/plugin/tui';
import { dialogNavigation } from '../tui/navigation.ts';
import { verifySharedFilesystem } from './connection.ts';
import { SettingsError, catalogModels } from './settings.ts';
import {
  type EditorConnection,
  type EditorContext,
  loadEditorContext,
  previewSelection,
  saveSelectionGuarded,
} from './storage.ts';
import { readRuntimeRevision } from './composition/runtime-baseline.ts';
import { applySavedComposition } from './composition/apply.ts';
import { retainedSession, sessionNotice } from './tui/running.ts';
import type { Selection } from './composition/document-types.ts';
export function registerSettings(api: TuiPluginApi): void {
  const navigation = dialogNavigation(api);
  let busy = false;
  const run = (action: () => Promise<void>) => {
    if (busy || api.lifecycle.signal.aborted) {
      return;
    }
    busy = true;
    void action()
      .catch((error: unknown) => {
        navigation.alert({ title: 'Config Composer', message: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        busy = false;
      });
  };
  const connection = (): EditorConnection => {
    const client = api.client;
    const directory = resolve(api.state.path.directory);
    const worktree = api.state.path.worktree;
    const root = resolve(worktree !== '' && worktree !== '/' ? worktree : directory);
    const assertCurrent = () => {
      if (
        api.client !== client ||
        api.lifecycle.signal.aborted ||
        resolve(api.state.path.directory) !== directory ||
        api.state.path.worktree !== worktree
      ) {
        throw new SettingsError('The server connection changed. Reopen Config Composer.');
      }
    };
    return {
      location: { root, directory },
      assertCurrent,
      config: async () => {
        const response = await client.config.get({ directory });
        if (response.error !== undefined) {
          throw new SettingsError('Could not read server configuration.');
        }
        return response.data;
      },
      proveFilesystem: async () => {
        await verifySharedFilesystem(api, root, root);
        assertCurrent();
      },
    };
  };
  const apply = async (context: EditorContext) => {
    const client = api.client;
    const directory = context.connection.location.directory;
    await applySavedComposition(context, context.runtime, {
      assertCurrent: () => context.connection.assertCurrent(),
      activity: async () => {
        const result = await client.session.status({ directory });
        if (result.error !== undefined) {
          throw new SettingsError('Could not check instance activity. Selection saved and pending.');
        }
        return result.data;
      },
      dispose: async () => {
        const result = await client.instance.dispose({ directory });
        if (result.error !== undefined || !result.data) {
          throw new SettingsError('Instance apply failed. Selection saved and pending.');
        }
      },
      refresh: async () => {
        const config = await context.connection.config();
        const views = await Promise.all([
          client.config.providers({ directory }),
          client.app.agents({ directory }),
          client.command.list({ directory }),
        ]);
        if (views.some((view) => view.error !== undefined)) {
          throw new SettingsError('Could not refresh server views. Selection saved and pending.');
        }
        return readRuntimeRevision(config, context.connection.location);
      },
    });
    navigation.alert({ title: 'Composer revision applied', message: sessionNotice });
  };
  const offerApply = (context: EditorContext) =>
    navigation.menu({
      title: 'Selection saved',
      options: [
        { title: 'Apply now', value: 'apply', description: 'Apply to this idle instance; conversations remain saved' },
        { title: 'Apply on next restart', value: 'later', description: 'Keep the saved selection pending' },
      ],
      onSelect: (option) => {
        if (option.value === 'apply') {
          run(() => apply(context));
        } else {
          navigation.close();
        }
      },
    });
  const choose = async (context: EditorContext, choice: Selection) => {
    const preview = await previewSelection(context, choice, async () => {
      const response = await api.client.config.providers({ directory: context.connection.location.directory });
      if (response.error !== undefined) {
        throw new SettingsError('Provider catalog unavailable. Review again.');
      }
      return catalogModels(response.data.providers);
    });
    const effects = Object.entries(preview.candidate.decisions)
      .map(
        ([path, decision]) =>
          `${path}: ${JSON.stringify(decision.value)} ← ${decision.origin.source ?? decision.origin.kind}${decision.blockedComposer === undefined ? '' : ` (blocked Composer: ${JSON.stringify(decision.blockedComposer.value)})`}`,
      )
      .join('\n');
    navigation.confirm({
      title: 'Save profile selection?',
      message: `Preview: ${preview.candidate.profile ?? 'none'}\nAll root groups remain active. Shared definitions: ${context.source.path}\nSelection for this worktree: ${context.runtime.location.root}\n\n${effects}`,
      onConfirm: () => run(async () => offerApply(await saveSelectionGuarded(context, preview))),
    });
  };
  const profiles = (context: EditorContext) =>
    navigation.menu({
      title: 'Profile',
      options: [
        {
          title: 'Follow default',
          value: 'default',
          description: context.source.document.defaultProfile ?? 'No default profile',
        },
        { title: 'None', value: 'none', description: 'Apply root groups and root named settings' },
        ...Object.entries(context.source.document.profiles).map(([name, profile]) => ({
          title: name,
          value: `profile:${name}`,
          description: profile.description ?? 'Select this profile',
        })),
      ],
      onSelect: (option) =>
        run(() =>
          choose(
            context,
            option.value === 'default' ? undefined : option.value === 'none' ? null : option.value.slice(8),
          ),
        ),
    });
  const open = async () => {
    const context = await loadEditorContext(connection());
    navigation.menu(
      {
        title: 'Compose configs',
        options: [
          {
            title: 'Profile',
            value: 'profile',
            description: `${context.selection.choice === undefined ? 'Follow default' : (context.selection.choice ?? 'None')} · current worktree`,
          },
          { title: 'Groups', value: 'groups', description: 'Always active · shared definition file' },
          {
            title: 'Effective',
            value: 'effective',
            description:
              context.runtime.status === 'error'
                ? context.runtime.diagnostic
                : 'Applied fields, origins and blocked Composer settings',
          },
          { title: 'Apply saved selection', value: 'apply', description: 'Retry a saved pending selection' },
        ],
        onSelect: (option) => {
          if (option.value === 'profile') {
            profiles(context);
          } else if (option.value === 'groups') {
            navigation.alert({
              title: 'Groups · always active',
              message: `Shared across projects: ${context.source.path}\n\n${context.source.document.groups.length === 0 ? 'No groups configured.' : context.source.document.groups.map((group) => `${group.name}: ${JSON.stringify(group.members)}${group.description !== undefined && group.description !== '' ? `\n${group.description}` : ''}`).join('\n')}\n\nEdit definitions directly in the JSONC file.`,
            });
          } else if (option.value === 'effective') {
            run(() => {
              const decisions = context.runtime.candidate?.decisions ?? {};
              navigation.menu({
                title: 'Effective configuration',
                options: [
                  {
                    title: 'Runtime status',
                    value: 'status',
                    description: context.runtime.diagnostic ?? 'Composer applied',
                  },
                  {
                    title: 'Retained session selection',
                    value: 'session',
                    description: 'Configured effects and current sessions can differ',
                  },
                  ...Object.entries(decisions).map(([path, value]) => ({
                    title: path,
                    value: path,
                    description: `${JSON.stringify(value.value)} · ${value.origin.source ?? value.origin.kind}`,
                  })),
                ],
                onSelect: (field) => {
                  if (field.value === 'session') {
                    run(async () =>
                      navigation.alert({ title: 'Retained session selection', message: await retainedSession(api) }),
                    );
                  } else {
                    navigation.alert({
                      title: field.title,
                      message:
                        field.value === 'status'
                          ? (context.runtime.diagnostic ??
                            `Applied revision: ${context.runtime.revision?.sources}\nShared source: ${context.source.path}`)
                          : JSON.stringify(decisions[field.value], null, 2),
                    });
                  }
                },
              });
              return Promise.resolve();
            });
          } else {
            run(() => apply(context));
          }
        },
      },
      true,
    );
  };
  const unregister = api.keymap.registerLayer({
    commands: [
      {
        name: 'config-composer.compose',
        title: 'Compose configuration',
        category: 'Config',
        namespace: 'palette',
        slashName: 'compose-configs',
        run: () => run(open),
      },
    ],
  });
  api.lifecycle.onDispose(unregister);
}
export default {
  id: 'config-composer',
  tui: async (api) => {
    registerSettings(api);
    await Promise.resolve();
  },
} satisfies TuiPluginModule;
