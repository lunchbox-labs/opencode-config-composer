import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { TuiPluginApi, TuiPluginModule } from '@opencode-ai/plugin/tui';
import { type FixedMenu, dialogNavigation } from '../tui/navigation.ts';
import { verifySharedFilesystem } from './connection.ts';
import { SettingsError, catalogModels } from './settings.ts';
import {
  type ConfigurationConnection,
  type ConfigurationContext,
  type Preview,
  loadConfigurationContext,
  previewSelection,
  saveSelectionGuarded,
} from './storage.ts';
import { readRuntimeContext } from './composition/runtime-baseline.ts';
import { type ApplyPort, applySavedComposition } from './composition/apply.ts';
import { sessionNotice } from './tui/running.ts';
import { configurationErrorText, diagnosticPages, inspectionText } from './tui/configuration-error.ts';
import { openProfiles, selectionLabel } from './tui/profile.ts';
import { loadInspection } from './tui/inspection.ts';
import { openEffective } from './tui/effective.ts';
import { type ConfigurationView, fieldDetail, modelParameterDetail } from './tui/view.ts';
import type { Selection } from './composition/document-types.ts';
export function registerConfiguration(api: TuiPluginApi, fixedMenu: FixedMenu): void {
  const nav = dialogNavigation(api, fixedMenu);
  let busy = false;
  const run = (action: () => void | Promise<void>) => {
    if (busy || api.lifecycle.signal.aborted) {
      return;
    }
    busy = true;
    const client = api.client;
    const route = JSON.stringify(api.route.current);
    let current = nav.checkpoint();
    void Promise.resolve()
      .then(() => {
        current = nav.checkpoint();
        return action();
      })
      .catch((error: unknown) => {
        if (
          current() &&
          !api.lifecycle.signal.aborted &&
          client === api.client &&
          route === JSON.stringify(api.route.current)
        ) {
          nav.alert({ title: 'Config Composer', message: configurationErrorText(error) });
        }
      })
      .finally(() => {
        busy = false;
      });
  };
  const defer = (action: () => void | Promise<void>) => queueMicrotask(() => run(action));
  const connection = (): ConfigurationConnection => {
    const client = api.client;
    const directory = resolve(api.state.path.directory);
    const worktree = api.state.path.worktree;
    const route = JSON.stringify(api.route.current);
    const root = resolve(worktree !== '' && worktree !== '/' ? worktree : directory);
    let filesystemProof: ReturnType<typeof verifySharedFilesystem> | undefined;
    const assertCurrent = () => {
      if (
        api.client !== client ||
        api.lifecycle.signal.aborted ||
        resolve(api.state.path.directory) !== directory ||
        api.state.path.worktree !== worktree ||
        JSON.stringify(api.route.current) !== route
      ) {
        throw new SettingsError('The server connection or session changed. Reopen Config Composer.');
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
        filesystemProof ??= verifySharedFilesystem(api, root, root);
        await filesystemProof;
        assertCurrent();
      },
    };
  };
  const details = (title: string, text: string) => {
    api.ui.dialog.setSize('xlarge');
    const pages = diagnosticPages(inspectionText(text), 95, 22);
    if (pages.length <= 1) {
      nav.alert({ title, message: pages[0] ?? '' });
      return;
    }
    nav.menu({
      title,
      options: pages.map((page, index) => ({
        title: `Page ${index + 1} of ${pages.length}`,
        value: String(index),
        description: page.split('\n')[0],
      })),
      onSelect: (option) =>
        nav.alert({
          title: `${title} · ${Number(option.value) + 1}/${pages.length}`,
          message: pages[Number(option.value)],
        }),
    });
  };
  const port = (context: ConfigurationContext): ApplyPort => {
    const client = api.client;
    const directory = context.connection.location.directory;
    return {
      assertCurrent: () => context.connection.assertCurrent(),
      activity: async () => {
        const result = await client.session.status({ directory });
        if (result.error !== undefined) {
          throw new SettingsError('Could not check instance activity.');
        }
        return result.data;
      },
      dispose: async () => {
        const result = await client.instance.dispose({ directory });
        if (result.error !== undefined || !result.data) {
          throw new SettingsError('Instance apply failed.');
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
          throw new SettingsError('Could not refresh server views.');
        }
        return readRuntimeContext(config, context.connection.location);
      },
    };
  };
  const revalidateSaved = async (context: ConfigurationContext) => {
    const current = await loadConfigurationContext(context.connection);
    if (
      current.runtime.definitionId !== context.runtime.definitionId ||
      !isDeepStrictEqual(current.runtime.selectionLocator, context.runtime.selectionLocator) ||
      !isDeepStrictEqual(current.source, context.source) ||
      !isDeepStrictEqual(current.selection, context.selection) ||
      !isDeepStrictEqual(current.runtime.native, context.runtime.native) ||
      !isDeepStrictEqual(current.runtime.observation, context.runtime.observation)
    ) {
      throw new SettingsError('Saved inputs changed. Reopen Config Composer and review again.');
    }
    return current;
  };
  const finish = async (context: ConfigurationContext, current = nav.checkpoint()) => {
    try {
      await applySavedComposition(context, context.runtime, port(context));
      if (!current()) {
        return;
      }
      nav.reset();
      nav.alert({ title: 'Composer revision applied', message: sessionNotice });
    } catch (error) {
      if (!current()) {
        return;
      }
      nav.reset();
      nav.fixed({
        title: 'Saved; not applied',
        options: [
          { title: 'Reason', value: 'reason', description: configurationErrorText(error) },
          {
            title: 'Retry apply',
            value: 'retry',
            description: 'Uses the loaded definitions and saved choice',
          },
          { title: 'Close', value: 'close' },
        ],
        onSelect: (option) => {
          if (option.value === 'reason') {
            details('Saved; not applied', configurationErrorText(error));
          } else if (option.value === 'retry') {
            run(async () => {
              const current = nav.checkpoint();
              await finish(await revalidateSaved(context), current);
            });
          } else {
            nav.close();
          }
        },
      });
    }
  };
  const open = async (mode: 'profiles' | 'inspect') => {
    if (mode === 'inspect') {
      const snapshot = await loadInspection(api, connection());
      openEffective({ api, nav, run, details, snapshot });
      return;
    }
    const context = await loadConfigurationContext(connection());
    const confirm = (view: ConfigurationView, preview: Preview, title: string, destination: string) => {
      api.ui.dialog.setSize('xlarge');
      const previous = context.runtime.candidate?.decisions ?? {};
      const proposed = preview.candidate.decisions;
      const changes = [...new Set([...Object.keys(previous), ...Object.keys(proposed)])]
        .map((path) => [path, Object.hasOwn(proposed, path) ? proposed[path] : undefined] as const)
        .filter(
          ([path, decision]) => !isDeepStrictEqual(decision, previous[path]) || decision?.blockedComposer !== undefined,
        );
      const describe = (entries: typeof changes) =>
        entries
          .map(
            ([path, decision]) =>
              `${path}\n${
                decision === undefined
                  ? `Removed contribution: inherit/native fallback.\nNative inheritance remains host-owned.\nPreviously configured:\n${fieldDetail(view, path, previous[path])}`
                  : fieldDetail(view, path, decision)
              }`,
          )
          .join('\n\n');
      const effective = describe(changes.filter(([, decision]) => decision?.origin.kind !== 'frontmatter'));
      const pinned = describe(changes.filter(([, decision]) => decision?.origin.kind === 'frontmatter'));
      const previousParameters = new Map(Object.entries(context.runtime.candidate?.modelParameters ?? {}));
      const proposedParameters = new Map(Object.entries(preview.candidate.modelParameters ?? {}));
      const parameterChanges = [...new Set([...previousParameters.keys(), ...proposedParameters.keys()])]
        .filter((name) => !isDeepStrictEqual(previousParameters.get(name), proposedParameters.get(name)))
        .map(
          (name) =>
            `${name}\n${
              proposedParameters.has(name)
                ? modelParameterDetail(
                    preview.candidate,
                    context.runtime.observation.authority,
                    name,
                    context.source.path,
                  )
                : `Removed model-bound defaults; native request defaults apply.\nPreviously configured: ${JSON.stringify(previousParameters.get(name)?.parameters)}`
            }`,
        )
        .join('\n\n');
      const effects = [
        effective === '' ? '' : `Effective changes:\n${effective}`,
        pinned === '' ? '' : `Final frontmatter contributions:\n${pinned}`,
        parameterChanges === '' ? '' : `Model-bound parameter changes:\n${parameterChanges}`,
      ]
        .filter(Boolean)
        .join('\n\n');
      const message = inspectionText(
        `${destination}\nSource: ${context.source.path}\nWorktree choice: ${selectionLabel(preview.choice)} · effective ${preview.candidate.profile ?? 'none'}\nShared groups remain active. Frontmatter pins remain unchanged.\n\n${effects === '' ? 'No effective managed fields change for the current choice.' : effects}\n\nApply saves then refreshes this idle instance. Existing session model/variant choices remain native.`,
      );
      const commit = () =>
        defer(async () => {
          const current = nav.checkpoint();
          const saved = await saveSelectionGuarded(context, preview);
          await finish(saved, current);
        });
      const pages = diagnosticPages(message, 95, 22);
      if (pages.length <= 1) {
        nav.confirm({ title, message, onConfirm: commit });
        return;
      }
      nav.menu({
        title,
        options: [
          ...pages.map((page, index) => ({
            title: `Review page ${index + 1} of ${pages.length}`,
            value: String(index),
            description: page.split('\n')[0],
          })),
          { title: 'Apply', value: 'apply', description: 'Save reviewed changes and apply to this idle instance' },
        ],
        onSelect: (option) => {
          if (option.value === 'apply') {
            nav.confirm({
              title: 'Apply reviewed changes?',
              message: `${destination}\n${context.source.path}\n${pages.length} preview pages. Saved changes remain pending if this instance is busy.`,
              onConfirm: commit,
            });
          } else {
            nav.alert({
              title: `Preview · ${Number(option.value) + 1}/${pages.length}`,
              message: pages[Number(option.value)],
            });
          }
        },
      });
    };
    const view: ConfigurationView = {
      api,
      nav,
      context,
      run,
      details,
      catalog: async () => {
        const checkpoint = nav.checkpoint();
        const response = await api.client.config.providers({ directory: context.connection.location.directory });
        if (!checkpoint()) {
          throw new SettingsError('The configuration view changed. Reopen Config Composer.');
        }
        if (response.error !== undefined) {
          throw new SettingsError('Provider catalog unavailable. Review again.');
        }
        return catalogModels(response.data.providers);
      },
      choose: async (choice: Selection) => {
        const checkpoint = nav.checkpoint();
        const preview = await previewSelection(context, choice, () => view.catalog());
        if (checkpoint()) {
          confirm(view, preview, 'Apply profile selection?', 'Profile selection');
        }
      },
    };
    openProfiles(view);
  };
  const unregister = api.keymap.registerLayer({
    commands: [
      {
        name: 'config-composer.profiles',
        title: 'Choose configuration profile',
        category: 'Config',
        namespace: 'palette',
        slashName: 'profiles',
        run: () => run(() => open('profiles')),
      },
      {
        name: 'config-composer.view',
        title: 'View configuration',
        category: 'Config',
        namespace: 'palette',
        slashName: 'view-configs',
        run: () => run(() => open('inspect')),
      },
    ],
  });
  api.lifecycle.onDispose(unregister);
}
export default {
  id: 'config-composer',
  tui: async (api) => {
    const { fixedMenu, registerProfileSlot } = await import('./tui/widgets.js');
    const { registerErrorNotice } = await import('./tui/notice.js');
    registerConfiguration(api, (props) => fixedMenu(api, props));
    registerProfileSlot(api);
    api.lifecycle.onDispose(registerErrorNotice(api));
  },
} satisfies TuiPluginModule;
