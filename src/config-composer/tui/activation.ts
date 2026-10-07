import type { TuiDialogSelectOption } from '@opencode-ai/plugin/tui';
import type { SourceSnapshot } from '../storage.ts';
import {
  type CompositionScope,
  type ScopeChange,
  type ScopeDestination,
  scopeDestinations,
} from '../composition/activation.ts';

type Action = TuiDialogSelectOption<string> & { run: () => void | Promise<void> };
interface ActivationUi {
  menu: (title: string, actions: Action[] | (() => Action[])) => void;
  back: () => void;
  propose: (scope: CompositionScope, change: ScopeChange) => Promise<void>;
}
const label = (profiles: string[]) => (profiles.length === 0 ? 'none' : profiles.join(' → '));

export function openActivation(snapshot: SourceSnapshot, ui: ActivationUi): void {
  const ordered = (destination: ScopeDestination) => {
    const pending = [...(destination.selection ?? destination.inherited)];
    ui.menu(`${destination.scope}: ordered active profiles`, () => [
      {
        title: 'Save selection…',
        value: '+save',
        run: () => ui.propose(destination.scope, { operation: 'selection', profiles: [...pending] }),
      },
      ...pending.map((name, index) => ({
        title: `${index + 1}. ${name}`,
        value: String(index),
        run: () =>
          ui.menu(`Profile occurrence ${index + 1}`, [
            {
              title: 'Remove occurrence',
              value: 'remove',
              run: () => {
                pending.splice(index, 1);
                ui.back();
              },
            },
            ...(index === 0
              ? []
              : [
                  {
                    title: 'Move earlier',
                    value: 'earlier',
                    run: () => {
                      pending.splice(index, 1);
                      pending.splice(index - 1, 0, name);
                      ui.back();
                    },
                  },
                ]),
            ...(index === pending.length - 1
              ? []
              : [
                  {
                    title: 'Move later',
                    value: 'later',
                    run: () => {
                      pending.splice(index, 1);
                      pending.splice(index + 1, 0, name);
                      ui.back();
                    },
                  },
                ]),
          ]),
      })),
      {
        title: 'Add profile occurrence',
        value: '+add',
        run: () =>
          ui.menu(
            'Choose profile',
            Object.keys(snapshot.sources.registry.profiles ?? {})
              .filter((name) => !pending.includes(name))
              .map((name) => ({
                title: name,
                value: name,
                run: () => {
                  pending.push(name);
                  ui.back();
                },
              })),
          ),
      },
    ]);
  };
  const scopeMenu = (destination: ScopeDestination) =>
    ui.menu(`${destination.scope} profile selection`, [
      {
        title: 'Edit ordered selection',
        value: 'ordered',
        description: `Current: ${label(destination.selection ?? destination.inherited)}`,
        run: () => ordered(destination),
      },
      {
        title: 'Select no profiles',
        value: 'none',
        description: 'An explicit empty list overrides earlier scopes',
        run: () => ui.propose(destination.scope, { operation: 'selection', profiles: [] }),
      },
      {
        title: 'Inherit earlier selection',
        value: 'inherit',
        description: `Remove this scope’s activeProfiles key; inherits ${label(destination.inherited)}`,
        run: () => ui.propose(destination.scope, { operation: 'selection' }),
      },
      ...(destination.file !== undefined
        ? []
        : [
            {
              title: 'Create empty composition source',
              value: 'create',
              description: 'Add a destination for definitions without changing selection',
              run: () => ui.propose(destination.scope, { operation: 'create' }),
            },
          ]),
    ]);
  ui.menu(
    'Profile activation and scope files',
    scopeDestinations(snapshot).map((destination) => ({
      title: destination.scope,
      value: destination.scope,
      description: `${destination.path} · ${destination.selection === undefined ? `inherits ${label(destination.inherited)}` : label(destination.selection)}${destination.maskedBy === undefined ? '' : ` · masked by ${destination.maskedBy}`}${destination.writable ? '' : ' · read-only'}`,
      run: () => scopeMenu(destination),
    })),
  );
}
