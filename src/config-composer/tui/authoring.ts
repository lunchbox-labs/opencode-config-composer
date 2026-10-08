import type { TuiDialogSelectOption } from '@opencode-ai/plugin/tui';
import type { Snapshot } from '../storage.ts';
import { type DefinitionChange, type DefinitionRegistry, definitionDestinations } from '../composition/authoring.ts';
import type { ConfigurationPreset, ProfileLayer } from '../composition/types.ts';
import { SettingsError, agentGroups, groupName } from '../settings.ts';

type Action = TuiDialogSelectOption<string> & { run: () => void | Promise<void> };
export interface AuthoringUi {
  menu: (title: string, actions: Action[] | (() => Action[])) => void;
  prompt: (title: string, value: string, confirmed: (value: string) => void | Promise<void>) => void;
  back: () => void;
  refresh: () => void;
  propose: (snapshot: Snapshot, change: DefinitionChange) => Promise<void>;
  groupModel: (snapshot: Snapshot, name: string) => void | Promise<void>;
  presetModel: (snapshot: Snapshot, name: string) => void | Promise<void>;
  createPreset: (selected: (choice: ConfigurationPreset) => void | Promise<void>) => void | Promise<void>;
}
const titles = {
  componentGroups: 'Component groups',
  configurationPresets: 'Configuration presets',
  profiles: 'Profiles',
} as const;

export function openAuthoring(snapshot: Snapshot, ui: AuthoringUi): void {
  const members = (name: string, kind: 'agents' | 'skills' | 'commands' | 'prompts') => {
    const pending = [...(snapshot.sources.registry.componentGroups?.[name][kind] ?? [])];
    const available =
      kind === 'agents'
        ? snapshot.agents.map((agent) => agent.name)
        : Object.keys(snapshot.sources.registry.components?.[kind] ?? {});
    ui.menu(`${name}: ${kind}`, () => [
      {
        title: 'Save members…',
        value: '+save',
        run: () =>
          ui.propose(snapshot, {
            operation: 'patch',
            registry: 'componentGroups',
            name,
            path: [kind],
            value: [...pending],
          }),
      },
      ...[...new Set([...available, ...pending])].map((member) => ({
        title: `${pending.includes(member) ? '✓ ' : ''}${member}`,
        value: `member:${member}`,
        description: !available.includes(member)
          ? 'Unavailable or disabled existing member; select to remove'
          : kind === 'agents' &&
              snapshot.agents.some((agent) => agent.name === member && agentGroups(agent.settings).includes(name))
            ? 'Also a member through native JSON or component frontmatter'
            : 'Explicit JSONC membership',
        run: () => {
          const index = pending.indexOf(member);
          if (index < 0) {
            pending.push(member);
          } else {
            pending.splice(index, 1);
          }
          ui.refresh();
        },
      })),
    ]);
  };
  const layers = (name: string) => {
    const pending = structuredClone(snapshot.sources.registry.profiles?.[name].layers ?? []);
    const append = (layer: ProfileLayer) => {
      pending.push(layer);
      ui.back();
    };
    ui.menu(`${name}: ordered layers`, () => [
      {
        title: 'Save layers…',
        value: '+save',
        run: () =>
          ui.propose(snapshot, { operation: 'patch', registry: 'profiles', name, path: ['layers'], value: pending }),
      },
      ...pending.map((layer, index) => ({
        title: `${index + 1}. ${layer.componentGroup ?? layer.configurationPreset}`,
        value: String(index),
        description:
          layer.componentGroup === undefined
            ? `Preset → ${[...(layer.target.agents ?? []), ...(layer.target.componentGroups ?? []).map((group) => `group:${group}`)].join(', ')}`
            : 'Component group',
        run: () =>
          ui.menu(`Layer ${index + 1}`, [
            {
              title: 'Remove layer',
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
                      pending.splice(index - 1, 0, layer);
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
                      pending.splice(index + 1, 0, layer);
                      ui.back();
                    },
                  },
                ]),
          ]),
      })),
      {
        title: 'Add component group layer',
        value: '+group',
        run: () =>
          ui.menu(
            'Choose component group',
            Object.keys(snapshot.sources.registry.componentGroups ?? {}).map((componentGroup) => ({
              title: componentGroup,
              value: componentGroup,
              run: () => append({ componentGroup }),
            })),
          ),
      },
      {
        title: 'Add configuration preset layer',
        value: '+preset',
        run: () =>
          ui.menu(
            'Choose configuration preset',
            Object.keys(snapshot.sources.registry.configurationPresets ?? {}).map((configurationPreset) => ({
              title: configurationPreset,
              value: configurationPreset,
              run: () =>
                ui.menu('Choose preset target', [
                  ...Object.keys(snapshot.sources.registry.componentGroups ?? {}).map((group) => ({
                    title: group,
                    value: `group:${group}`,
                    category: 'Groups',
                    run: () => {
                      pending.push({ configurationPreset, target: { componentGroups: [group] } });
                      ui.back();
                      ui.back();
                    },
                  })),
                  ...snapshot.agents.map((agent) => ({
                    title: agent.name,
                    value: `agent:${agent.name}`,
                    category: 'Agents',
                    run: () => {
                      pending.push({ configurationPreset, target: { agents: [agent.name] } });
                      ui.back();
                      ui.back();
                    },
                  })),
                ]),
            })),
          ),
      },
    ]);
  };
  const definition = (registry: DefinitionRegistry, name: string) => {
    const actions: Action[] = [];
    if (registry === 'componentGroups') {
      actions.push(
        ...(['agents', 'skills', 'commands', 'prompts'] as const).map((kind) => ({
          title: `Edit ${kind}`,
          value: kind,
          run: () => members(name, kind),
        })),
      );
      actions.push({ title: 'Model and variant settings', value: 'model', run: () => ui.groupModel(snapshot, name) });
    } else if (registry === 'configurationPresets') {
      actions.push({ title: 'Model and variant settings', value: 'model', run: () => ui.presetModel(snapshot, name) });
    } else {
      actions.push({ title: 'Ordered layers', value: 'layers', run: () => layers(name) });
      actions.push({
        title: 'Parent profile',
        value: 'parent',
        run: () =>
          ui.menu('Choose parent profile', [
            {
              title: 'No parent',
              value: '',
              run: () =>
                ui.propose(snapshot, { operation: 'patch', registry, name, path: ['extends'], value: undefined }),
            },
            ...Object.keys(snapshot.sources.registry.profiles ?? {})
              .filter((profile) => profile !== name)
              .map((profile) => ({
                title: profile,
                value: profile,
                run: () =>
                  ui.propose(snapshot, { operation: 'patch', registry, name, path: ['extends'], value: profile }),
              })),
          ]),
      });
    }
    actions.push({
      title: 'Rename with references…',
      value: 'rename',
      run: () =>
        ui.prompt('Rename definition', name, (value) =>
          ui.propose(snapshot, { operation: 'rename', registry, name, nextName: groupName(value.trim()) }),
        ),
    });
    actions.push({
      title: 'Delete unused definition…',
      value: 'delete',
      run: () => ui.propose(snapshot, { operation: 'delete', registry, name }),
    });
    ui.menu(`${titles[registry]}: ${name}`, actions);
  };
  const registryMenu = (registry: DefinitionRegistry) =>
    ui.menu(titles[registry], [
      ...Object.keys(snapshot.sources.registry[registry] ?? {})
        .sort()
        .map((name) => ({
          title: name,
          value: name,
          description: snapshot.sources.provenance[`/${registry}/${name}`].sourceId,
          run: () => definition(registry, name),
        })),
      {
        title: 'Create definition…',
        value: '+create',
        run: () =>
          ui.prompt(`New ${titles[registry].toLowerCase()} name`, '', (value) => {
            const name = groupName(value.trim());
            if (Object.hasOwn(snapshot.sources.registry[registry] ?? {}, name)) {
              throw new SettingsError('That definition already exists.');
            }
            const destinations = definitionDestinations(snapshot);
            if (destinations.length === 0) {
              throw new SettingsError('No writable composition source is available.');
            }
            ui.menu(
              'Save new definition in…',
              destinations.map((file) => ({
                title: file.path,
                value: file.path,
                run: () =>
                  registry === 'configurationPresets'
                    ? ui.createPreset((value) =>
                        ui.propose(snapshot, { operation: 'create', registry, name, sourceId: file.path, value }),
                      )
                    : ui.propose(snapshot, { operation: 'create', registry, name, sourceId: file.path }),
              })),
            );
          }),
      },
    ]);
  ui.menu(
    'Composition definitions',
    (['componentGroups', 'configurationPresets', 'profiles'] as const).map((registry) => ({
      title: titles[registry],
      value: registry,
      run: () => registryMenu(registry),
    })),
  );
}
