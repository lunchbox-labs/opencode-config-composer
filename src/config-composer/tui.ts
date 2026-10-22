import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { TuiPluginApi, TuiPluginModule } from '@opencode-ai/plugin/tui';
import { dialogNavigation } from '../tui/navigation.ts';
import { verifySharedFilesystem } from './connection.ts';
import { SettingsError, catalogModels } from './settings.ts';
import {
  type DocumentPreview,
  type EditorConnection,
  type EditorContext,
  type Preview,
  loadEditorContext,
  previewDocument,
  previewSelection,
  saveDocumentGuarded,
  saveSelectionGuarded,
  verifyContext,
} from './storage.ts';
import { readRuntimeRevision } from './composition/runtime-baseline.ts';
import { applySavedComposition } from './composition/apply.ts';
import { sessionNotice } from './tui/running.ts';
import { diagnosticPages, diagnosticText, editorErrorText } from './tui/editor-error.ts';
import { openProfiles } from './tui/profile.ts';
import { openGroups } from './tui/groups.ts';
import { openEffective } from './tui/effective.ts';
import { type EditorView, fieldDetail } from './tui/view.ts';
import type { Selection } from './composition/document-types.ts';
import { pointer, readCompositionDocument } from './composition/document.ts';
import { parseConfiguration } from './configuration.ts';
const readDocument = (text: string) => readCompositionDocument(parseConfiguration(text));
function authoredChanges(before: unknown, after: unknown, path = ''): string[] {
  if (isDeepStrictEqual(before, after)) {
    return [];
  }
  if (before !== null && after !== null && typeof before === 'object' && typeof after === 'object') {
    const old = Object.fromEntries(Object.entries(before));
    const next = Object.fromEntries(Object.entries(after));
    return [...new Set([...Object.keys(old), ...Object.keys(next)])].flatMap((key) =>
      authoredChanges(old[key], next[key], `${path}/${pointer(key)}`),
    );
  }
  return [`${path}: ${after === undefined ? 'Inherit/remove' : JSON.stringify(after)}`];
}
export function registerSettings(api: TuiPluginApi): void {
  const nav = dialogNavigation(api);
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
          nav.alert({ title: 'Config Composer', message: editorErrorText(error) });
        }
      })
      .finally(() => {
        busy = false;
      });
  };
  const defer = (action: () => void | Promise<void>) => queueMicrotask(() => run(action));
  const connection = (): EditorConnection => {
    const client = api.client;
    const directory = resolve(api.state.path.directory);
    const worktree = api.state.path.worktree;
    const route = JSON.stringify(api.route.current);
    const root = resolve(worktree !== '' && worktree !== '/' ? worktree : directory);
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
        await verifySharedFilesystem(api, root, root);
        assertCurrent();
      },
    };
  };
  const details = (title: string, text: string) => {
    api.ui.dialog.setSize('xlarge');
    const pages = diagnosticPages(diagnosticText(text), 95, 22);
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
  const apply = async (context: EditorContext) => {
    const client = api.client;
    const directory = context.connection.location.directory;
    await applySavedComposition(context, context.runtime, {
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
        return readRuntimeRevision(config, context.connection.location);
      },
    });
  };
  const reloadSaved = async (context: EditorContext) => {
    const current = await loadEditorContext(context.connection);
    if (
      !isDeepStrictEqual(current.source, context.source) ||
      !isDeepStrictEqual(current.selection, context.selection) ||
      !isDeepStrictEqual(current.runtime.native, context.runtime.native) ||
      !isDeepStrictEqual(current.runtime.observation, context.runtime.observation)
    ) {
      throw new SettingsError('Saved inputs changed. Reopen Config Composer and review again.');
    }
    return current;
  };
  const finish = async (context: EditorContext, current = nav.checkpoint()) => {
    try {
      await apply(context);
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
      nav.menu({
        title: 'Saved; not applied',
        options: [
          { title: 'Reason', value: 'reason', description: editorErrorText(error) },
          {
            title: 'Retry apply',
            value: 'retry',
            description: 'Uses the saved source and choice; stale native inputs require restart',
          },
          { title: 'Close', value: 'close' },
        ],
        onSelect: (option) => {
          if (option.value === 'reason') {
            details('Saved; not applied', editorErrorText(error));
          } else if (option.value === 'retry') {
            run(async () => {
              const current = nav.checkpoint();
              await finish(await reloadSaved(context), current);
            });
          } else {
            nav.close();
          }
        },
      });
    }
  };
  const open = async () => {
    const context = await loadEditorContext(connection());
    const confirm = (view: EditorView, preview: Preview | DocumentPreview, title: string, destination: string) => {
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
      const effects = [
        effective === '' ? '' : `Effective changes:\n${effective}`,
        pinned === '' ? '' : `Pinned members retain frontmatter:\n${pinned}`,
      ]
        .filter(Boolean)
        .join('\n\n');
      const authored = 'text' in preview ? authoredChanges(context.source.document, readDocument(preview.text)) : [];
      // Show authored document changes separately from the currently selected profile's effects.
      const message = diagnosticText(
        `${destination}\nSource: ${context.source.path}\nWorktree choice: ${preview.choice === undefined ? 'Use configured default' : (preview.choice ?? 'No profile')} · effective ${preview.candidate.profile ?? 'none'}\nShared groups remain active. Frontmatter pins remain unchanged.\n\n${authored.length === 0 ? '' : `Authored changes:\n${authored.join('\n')}\n\n`}${effects === '' ? 'No effective managed fields change for the current choice.' : effects}\n\nApply saves then refreshes this idle instance. Existing session model/variant choices remain native.`,
      );
      const commit = () =>
        defer(async () => {
          const current = nav.checkpoint();
          const saved =
            'text' in preview
              ? await saveDocumentGuarded(context, preview)
              : await saveSelectionGuarded(context, preview);
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
    const view: EditorView = {
      api,
      nav,
      context,
      run,
      defer,
      details,
      catalog: async () => {
        const checkpoint = nav.checkpoint();
        await verifyContext(context);
        const response = await api.client.config.providers({ directory: context.connection.location.directory });
        await verifyContext(context);
        if (!checkpoint()) {
          throw new SettingsError('The editor view changed. Reopen Config Composer.');
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
      review: async (text: string, destination: string, choice: Selection = context.selection.choice) => {
        const checkpoint = nav.checkpoint();
        const preview = await previewDocument(context, text, () => view.catalog(), choice);
        if (checkpoint()) {
          confirm(view, preview, 'Apply document changes?', destination);
        }
      },
      retry: async () => {
        const current = nav.checkpoint();
        await finish(await reloadSaved(context), current);
      },
    };
    nav.menu(
      {
        title: 'Compose configs',
        options: [
          {
            title: 'Profile',
            value: 'profile',
            description: `Stored mode: ${context.selection.choice === undefined ? 'Use configured default' : (context.selection.choice ?? 'No profile')} · ${context.runtime.diagnostic ?? 'this worktree'}`,
          },
          { title: 'Groups', value: 'groups', description: 'Always active · shared definition file' },
          {
            title: 'Effective',
            value: 'effective',
            description: 'Configured fields, verified applied values and raw frontmatter pins',
          },
        ],
        onSelect: (option) =>
          run(() => {
            if (option.value === 'profile') {
              openProfiles(view);
            } else if (option.value === 'groups') {
              openGroups(view);
            } else {
              openEffective(view);
            }
          }),
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
