import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import { dialogNavigation } from '../../tui/navigation.ts';
import type { FieldOrigin, ResolvedComposition } from '../composition/types.ts';

export interface ComposeSection {
  id: string;
  title: string;
  open: () => void | Promise<void>;
}

// The shell and legacy editors share one stack so Back/Escape cross section boundaries.
const navigations = new WeakMap<TuiPluginApi, ReturnType<typeof dialogNavigation>>();
export function composeNavigation(api: TuiPluginApi) {
  let navigation = navigations.get(api);
  if (navigation === undefined) {
    navigation = dialogNavigation(api);
    navigations.set(api, navigation);
  }
  return navigation;
}

export function registerCompose(api: TuiPluginApi, sections: readonly ComposeSection[]): () => void {
  const navigation = composeNavigation(api);
  let disposed = false;
  let opening = false;
  const active = () => !disposed && !api.lifecycle.signal.aborted;
  const unregister = api.keymap.registerLayer({
    commands: [
      {
        name: 'config-composer.compose',
        title: 'Compose configuration',
        category: 'Config',
        namespace: 'palette',
        slashName: 'compose',
        run: () => {
          if (!active()) {
            return;
          }
          navigation.menu(
            {
              title: 'Compose',
              placeholder: 'Search…',
              options: sections.map((section) => ({ title: section.title, value: section.id })),
              // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Handle failures here and allow callers to await section loading.
              onSelect: async (option) => {
                if (!active() || opening) {
                  return;
                }
                opening = true;
                try {
                  await sections.find((section) => section.id === option.value)?.open();
                } catch {
                  if (active()) {
                    api.ui.toast({
                      variant: 'error',
                      title: 'Compose',
                      message: 'Could not open this section. Check the files and server connection.',
                    });
                  }
                } finally {
                  opening = false;
                }
              },
            },
            true,
          );
        },
      },
    ],
  });
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    navigation.reset();
    unregister();
  };
  api.lifecycle.onDispose(dispose);
  return dispose;
}

/** Inspect origins, never turn effective native values into editable source documents. */
export function openEffective(api: TuiPluginApi, snapshot: ResolvedComposition): void {
  const navigation = composeNavigation(api);
  const originLabel = (origin: FieldOrigin): string => {
    const source = snapshot.sources.find((item) => item.id === origin.sourceId);
    return origin.sourceId === undefined
      ? 'Effective native · source file unavailable'
      : `Saved Composer · ${source?.path ?? origin.sourceId}`;
  };
  const describe = (origin: FieldOrigin): string =>
    [
      originLabel(origin),
      `Pointer: ${origin.pointer}`,
      `Layer: ${origin.layer} · ${origin.operation}`,
      ...(origin.references.length > 0 ? [`References: ${origin.references.join(', ')}`] : []),
      ...origin.overwritten.map((previous) => `Overwritten: ${describe(previous)}`),
    ].join('\n');
  const defaults = (['model', 'small_model', 'default_agent'] as const).map((field) => ({
    title: field,
    value: `/${field}`,
    category: 'Running native defaults',
    description: snapshot[field] ?? 'OpenCode fallback',
  }));
  const declarations = Object.entries(snapshot.provenance)
    .filter(([pointer]) => pointer.startsWith('/settings/'))
    .map(([pointer, origin]) => ({
      title: origin.pointer,
      value: pointer,
      category: 'Saved Composer declarations',
      description: originLabel(origin),
    }));
  navigation.menu({
    title: 'Effective configuration and sources',
    placeholder: 'Search fields…',
    options: [
      ...defaults,
      ...declarations,
      {
        title: 'Sources and inspection scope',
        value: '+sources',
        category: 'Sources',
        description: 'Read-only · saved declarations may differ from the running configuration',
      },
    ],
    onSelect: (option) => {
      const origin: FieldOrigin | undefined = Object.hasOwn(snapshot.provenance, option.value)
        ? snapshot.provenance[option.value]
        : undefined;
      const message =
        option.value === '+sources'
          ? snapshot.sources
              .map((source) => `${source.path}\n${source.writable ? 'Writable' : 'Read-only'} source`)
              .join('\n\n') +
            '\n\nNative defaults come from the running server. Composer declarations come from saved files. ' +
            'Agent-level applied provenance and applied revision are not available in this view. ' +
            'Command and skill composition are not supported.'
          : origin === undefined
            ? 'Effective native · OpenCode fallback · source file unavailable'
            : describe(origin);
      navigation.alert({ title: option.title, message });
    },
  });
}
