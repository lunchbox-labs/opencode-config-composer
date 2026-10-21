import { moveToPosition } from './move-to-position.ts';
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
  propose: (snapshot: Snapshot, change: DefinitionChange, details?: string) => Promise<void>;
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
  const availability = (name: string) => {
    const pending = { ...snapshot.sources.registry.profiles?.[name].agentAvailability };
    ui.menu(`${name}: agent availability`, () => [
      {
        title: 'Save availability…',
        value: '+save',
        description: 'Preserve definitions and history; applying waits for an idle instance',
        run: () =>
          ui.propose(snapshot, {
            operation: 'patch',
            registry: 'profiles',
            name,
            path: ['agentAvailability'],
            value: pending,
          }),
      },
      ...Object.entries(snapshot.resolved.agentAvailability)
        .filter(([, state]) => !state.internal)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([agent, state]) => ({
          title: agent,
          value: `agent:${agent}`,
          description: `This profile: ${!Object.hasOwn(pending, agent) ? 'inherit' : pending[agent] ? 'enable' : 'disable'} · saved: ${state.status} · ${state.mode}`,
          run: () =>
            ui.menu(`${name}: ${agent}`, [
              ...(['enable', 'disable', 'inherit'] as const).map((action) => ({
                title:
                  action === 'inherit'
                    ? 'Inherit earlier/native availability'
                    : action === 'enable'
                      ? 'Enable agent'
                      : 'Disable agent',
                value: action,
                run: () => {
                  if (action === 'inherit') {
                    Reflect.deleteProperty(pending, agent);
                  } else {
                    pending[agent] = action === 'enable';
                  }
                  ui.back();
                },
              })),
            ]),
        })),
    ]);
  };
  const members = (name: string, kind: 'agents' | 'skills' | 'commands') => {
    const pending = [...(snapshot.sources.registry.componentGroups?.[name][kind] ?? [])];
    const available =
      kind === 'agents'
        ? snapshot.agents.map((agent) => agent.name)
        : [
            ...new Set([
              ...Object.keys(snapshot.sources.registry.components?.[kind] ?? {}),
              ...(kind === 'commands' ? (snapshot.nativeModels.commandNames ?? []) : []),
              ...(snapshot.nativeModels.componentInventory?.[kind] ?? []).map((item) => item.name),
            ]),
          ];
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
    const targets = (layer: Extract<ProfileLayer, { configurationPreset: string }>) => {
      const original = layer.target;
      const agents = [...(original.agents ?? [])];
      const groups = [...(original.componentGroups ?? [])];
      const availableAgents = snapshot.agents.map((agent) => agent.name);
      const availableGroups = Object.keys(snapshot.sources.registry.componentGroups ?? {});
      const ordered = (authored: string[] | undefined, selected: string[]) => [
        ...(authored ?? []).filter((name) => selected.includes(name)),
        ...selected.filter((name) => !(authored ?? []).includes(name)),
      ];
      const choices = (
        kind: 'agent' | 'group',
        selected: string[],
        available: string[],
        authored: string[],
      ): Action[] =>
        [...new Set([...available, ...authored])].map((name) => ({
          title: `${selected.includes(name) ? '✓ ' : ''}${name}`,
          value: `${kind}:${name}`,
          category: kind === 'agent' ? 'Agents' : 'Groups',
          description: available.includes(name)
            ? 'Explicit preset target'
            : 'Unavailable or disabled existing target; select to toggle',
          run: () => {
            const index = selected.indexOf(name);
            if (index < 0) {
              selected.push(name);
            } else {
              selected.splice(index, 1);
            }
            ui.refresh();
          },
        }));
      // Keep unavailable references visible even after deselection so they can be restored.
      ui.menu('Edit preset targets', () => [
        {
          title: 'Save targets to layer draft',
          value: '+save',
          disabled: agents.length + groups.length === 0,
          description: 'Choose at least one agent or group; Save layers reviews and writes the changes',
          run: () => {
            if (agents.length + groups.length === 0) {
              return;
            }
            layer.target = {
              ...original,
              ...(original.agents !== undefined || agents.length > 0
                ? { agents: ordered(original.agents, agents) }
                : {}),
              ...(original.componentGroups !== undefined || groups.length > 0
                ? { componentGroups: ordered(original.componentGroups, groups) }
                : {}),
            };
            ui.back();
          },
        },
        ...choices('agent', agents, availableAgents, original.agents ?? []),
        ...choices('group', groups, availableGroups, original.componentGroups ?? []),
      ]);
    };
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
            ...(layer.componentGroup === undefined
              ? [{ title: 'Edit targets', value: 'targets', run: () => targets(layer) }]
              : []),
            {
              title: 'Move to position…',
              value: 'position',
              run: () => moveToPosition(ui, pending, index),
            },
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
        ...(['agents', 'skills', 'commands'] as const).map((kind) => ({
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
      actions.push({ title: 'Agent availability', value: 'availability', run: () => availability(name) });
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
    if (registry !== 'componentGroups') {
      actions.push({
        title: 'Duplicate as…',
        value: 'duplicate',
        description: 'Copy authored settings; keep references, original and active selection',
        run: () =>
          ui.prompt('Duplicate as', '', (value) => {
            const nextName = groupName(value.trim());
            if (Object.hasOwn(snapshot.sources.registry[registry] ?? {}, nextName)) {
              throw new SettingsError('That definition already exists.');
            }
            const destinations = definitionDestinations(snapshot);
            if (destinations.length === 0) {
              throw new SettingsError('No writable composition source is available.');
            }
            const authored = structuredClone(snapshot.sources.registry[registry]?.[name]);
            const dependencies = new Set<string>();
            const modelReference = (configuration: ConfigurationPreset | undefined) => {
              if (configuration?.modelRef !== undefined) {
                dependencies.add(configuration.modelRef);
              }
            };
            if (registry === 'profiles') {
              const profile = snapshot.sources.registry.profiles?.[name];
              if (profile?.extends !== undefined) {
                dependencies.add(`profile:${profile.extends}`);
              }
              for (const layer of profile?.layers ?? []) {
                if (layer.componentGroup !== undefined) {
                  dependencies.add(`group:${layer.componentGroup}`);
                } else {
                  dependencies.add(`preset:${layer.configurationPreset}`);
                  for (const group of layer.target.componentGroups ?? []) {
                    dependencies.add(`group:${group}`);
                  }
                  for (const agent of layer.target.agents ?? []) {
                    dependencies.add(`agent:${agent}`);
                  }
                }
              }
              for (const [agent, configuration] of Object.entries(profile?.overrides?.agents ?? {})) {
                dependencies.add(`agent:${agent}`);
                modelReference(configuration);
              }
              for (const agent of Object.keys(profile?.agentAvailability ?? {})) {
                dependencies.add(`agent:${agent}`);
              }
            } else {
              modelReference(snapshot.sources.registry.configurationPresets?.[name]);
            }
            const details =
              `Copy of ${name}. Original and active selection stay unchanged.\n` +
              `The copy still depends on its referenced definitions/native settings: ${dependencies.size === 0 ? 'none' : [...dependencies].join(', ')}.\n` +
              'Copies authored semantic fields only; attached comments are not copied.';
            ui.menu(
              'Save duplicate in…',
              destinations.map((file) => ({
                title: file.path,
                value: file.path,
                run: () =>
                  ui.propose(
                    snapshot,
                    {
                      operation: 'create',
                      registry,
                      name: nextName,
                      sourceId: file.path,
                      value: authored,
                    },
                    details,
                  ),
              })),
            );
          }),
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
