import { definitionDescription } from './definition-description.ts';
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
        description: definitionDescription(snapshot, 'profiles', name),
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
                description: definitionDescription(snapshot, 'profiles', name),
                run: () => {
                  pending.push(name);
                  ui.back();
                },
              })),
          ),
      },
    ]);
  };
  const state = snapshot.sources.selectionState;
  const destination: ScopeDestination = {
    scope: 'project',
    path: state?.path ?? 'Selection state unavailable',
    selection: snapshot.sources.activeProfiles,
    inherited: snapshot.sources.selectionPolicy.defaultProfiles,
    writable: state !== undefined,
  };
  ui.menu('Project profile selection', [
    ...scopeDestinations(snapshot)
      .filter((item) => item.file === undefined && item.writable)
      .map((item): Action => ({
        title: `Create ${item.scope} composition source`,
        value: `create:${item.scope}`,
        run: () => ui.propose(item.scope, { operation: 'create' }),
      })),
    {
      title: 'Edit ordered selection',
      value: 'ordered',
      description: label(snapshot.sources.activeProfiles),
      run: () => ordered(destination),
    },
    {
      title: 'Select no profiles',
      value: 'none',
      run: () => ui.propose('project', { operation: 'selection', profiles: [] }),
    },
    {
      title: 'Use configured defaults',
      value: 'inherit',
      description: label(destination.inherited),
      run: () => ui.propose('project', { operation: 'selection' }),
    },
  ]);
}
