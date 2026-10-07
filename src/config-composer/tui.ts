import { verifyNativeAgents } from './composition/native-baseline.ts';
import { isDeepStrictEqual } from 'node:util';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { TuiDialogSelectOption, TuiPlugin, TuiPluginApi, TuiPluginModule } from '@opencode-ai/plugin/tui';
import type { Config, SessionStatus } from '@opencode-ai/sdk/v2';
import { dialogNavigation } from '../tui/navigation.ts';
import {
  type CatalogModel,
  type GroupChoice,
  type ModelChoice,
  type NativeModels,
  type ResolutionContext,
  SettingsError,
  catalogModels,
  groupName,
  presetName,
  record,
  resolveGroup,
  validateChoice,
} from './settings.ts';
import {
  type Change,
  type FilePlan,
  type Snapshot,
  type StoredAgent,
  affectedGroups,
  groupNames,
  loadSnapshot,
  memberships,
  planChange,
  plannedChoices,
  previewFilePlan,
  reloadConfiguration,
  saveFilePlan,
  savePlan,
} from './storage.ts';
import { configurationDirectory } from './configuration.ts';
import { verifySharedFilesystem } from './connection.ts';
import { type EditorNativeBaseline, readRuntimeBaseline } from './composition/runtime-baseline.ts';
import { editorSettings } from './composition/editor.ts';
import { resolveProfileRuntime } from './composition/runtime.ts';
import { openEffective } from './tui/compose.ts';
import { openAuthoring } from './tui/authoring.ts';
import { type DefinitionChange, planDefinition } from './composition/authoring.ts';
import { planScope } from './composition/activation.ts';
import { openParameters } from './tui/parameters.ts';
import { planParameter } from './composition/parameter-authoring.ts';
import { parameterReview, validateParameterChoice } from './composition/parameter-review.ts';
import { openActivation } from './tui/activation.ts';
import { openPermissions } from './tui/permissions.ts';
import { permissionStatus, planPermissions, previewPermission } from './composition/permission-authoring.ts';

type Action = TuiDialogSelectOption<string> & { run: () => void | Promise<void> };
const label = (choice: ModelChoice) =>
  typeof choice.model === 'string' && choice.model !== ''
    ? `${choice.model}${typeof choice.variant === 'string' && choice.variant !== '' ? ` (${choice.variant})` : ''}`
    : 'OpenCode fallback';

// The directory argument also lets tests exercise the real file editor in an isolated installation.
export function registerSettings(
  api: TuiPluginApi,
  directory = configurationDirectory(),
  globalDirectory = join(
    process.env.XDG_CONFIG_HOME !== undefined &&
      process.env.XDG_CONFIG_HOME !== '' &&
      isAbsolute(process.env.XDG_CONFIG_HOME)
      ? process.env.XDG_CONFIG_HOME
      : join(homedir(), '.config'),
    'opencode',
  ),
): void {
  const navigation = dialogNavigation(api);
  let busy = false;
  const native = new WeakMap<Snapshot, NativeModels>();
  const context = (snapshot: Snapshot): ResolutionContext => ({
    modelPresets: snapshot.modelPresets,
    native: native.get(snapshot) ?? { model: snapshot.resolved.model, small_model: snapshot.resolved.small_model },
  });
  const readNative = async (): Promise<EditorNativeBaseline> => {
    const response: { error?: unknown; data?: Config | null } = await api.client.config.get();
    if (Boolean(response.error) || response.data === undefined || response.data === null) {
      throw new SettingsError(
        'Could not read effective workspace defaults. Reopen the editor after checking the server.',
      );
    }
    const path = api.state.path as { worktree?: string; directory?: string };
    const root =
      typeof path.worktree === 'string' && path.worktree !== '' && path.worktree !== '/'
        ? path.worktree
        : (path.directory ?? directory);
    return readRuntimeBaseline(response.data, { root, directory: path.directory ?? root }, directory);
  };
  const refreshNative = async (snapshot: Snapshot) => {
    const models = await readNative();
    if (!isDeepStrictEqual(snapshot.nativeModels.agent, models.agent)) {
      throw new SettingsError(
        'Native agent settings changed on the server. Reopen the editor and review the new preview.',
      );
    }
    if (models.agent !== undefined) {
      verifyNativeAgents(snapshot.nativeSourceAgents, models.agent);
      snapshot.nativeAgents = models.agent;
    }
    snapshot.nativeModels = models;
    snapshot.settings = editorSettings(snapshot.sources, models);
    snapshot.modelPresets = snapshot.settings.modelPresets;
    snapshot.resolved = await resolveProfileRuntime(
      snapshot.sources,
      { ...models, agent: snapshot.nativeAgents },
      new Map(snapshot.files.map((file) => [file.path, file.text])),
    );
    native.set(snapshot, { model: snapshot.resolved.model, small_model: snapshot.resolved.small_model });
  };
  const run = (action: () => void | Promise<void>) => {
    if (busy || api.lifecycle.signal.aborted) {
      return;
    }
    busy = true;
    return Promise.resolve()
      .then(action)
      .catch((error: unknown) => {
        if (!api.lifecycle.signal.aborted) {
          api.ui.toast({
            variant: 'error',
            title: 'Agent settings',
            message:
              error instanceof SettingsError
                ? error.message
                : 'Could not update settings. Check the files and server connection.',
            duration: 8000,
          });
        }
      })
      .finally(() => {
        busy = false;
      });
  };
  const menu = (title: string, options: Action[] | (() => Action[]), current?: string, root = false) => {
    if (api.lifecycle.signal.aborted) {
      return;
    }
    navigation.menu(
      {
        title,
        placeholder: 'Search…',
        current,
        get options() {
          return typeof options === 'function' ? options() : options;
        },
        // eslint-disable-next-line @typescript-eslint/no-misused-promises -- run handles rejection; return its Promise so callers can await completion.
        onSelect: (option) =>
          run(() =>
            (typeof options === 'function' ? options() : options).find((item) => item.value === option.value)?.run(),
          ),
      },
      root,
    );
  };
  const confirm = (title: string, message: string, action: () => Promise<void>) => {
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- run handles rejection; return its Promise so callers can await completion.
    navigation.confirm({ title, message, onConfirm: () => run(action) });
  };
  const connection = async (expectedRoot?: string) => {
    const serverPath = api.state.path.config;
    const root = await realpath(directory);
    if (expectedRoot !== undefined && root !== expectedRoot) {
      throw new SettingsError('The configuration directory changed. Reopen the settings editor.');
    }
    const serverDirectory = await realpath(serverPath).catch(() => undefined);
    if (root !== serverDirectory) {
      // V1 reports the global path even when it loads OPENCODE_CONFIG_DIR.
      const custom = process.env.OPENCODE_CONFIG_DIR;
      const customDirectory =
        custom !== undefined && custom !== '' ? await realpath(custom).catch(() => undefined) : undefined;
      const localGlobal = await realpath(globalDirectory).catch(() => undefined);
      if (
        serverDirectory === undefined ||
        serverDirectory === '' ||
        serverDirectory !== localGlobal ||
        root !== customDirectory
      ) {
        throw new SettingsError(
          "Install the editor in this server's global configuration directory or its local " +
            'OPENCODE_CONFIG_DIR. Remote files are not supported.',
        );
      }
    }
    const client = await verifySharedFilesystem(api, root, root === serverDirectory ? serverPath : root);
    const assertCurrent = () => {
      if (api.client !== client || api.state.path.config !== serverPath || api.lifecycle.signal.aborted) {
        throw new SettingsError('The server connection changed. Reopen the settings editor.');
      }
    };
    assertCurrent();
    return { root, client, assertCurrent };
  };
  const currentProject = (root: string) => {
    const path = api.state.path as { worktree?: string; directory?: string };
    return resolve(
      typeof path.worktree === 'string' && path.worktree !== '' && path.worktree !== '/'
        ? path.worktree
        : (path.directory ?? root),
    );
  };
  const authorizePlan = async (plan: FilePlan) => {
    const { assertCurrent, client } = await connection(plan.snapshot.root);
    const projectWrite = plan.edits.some(
      (edit) => edit.file.writeRoot !== undefined && edit.file.writeRoot !== plan.snapshot.root,
    );
    const assertProject = () => {
      assertCurrent();
      if (projectWrite && currentProject(plan.snapshot.root) !== plan.snapshot.sourceContext.root) {
        throw new SettingsError('The current project changed. Reopen the settings editor.');
      }
    };
    assertProject();
    if (projectWrite) {
      const verified = await verifySharedFilesystem(api, plan.snapshot.scopeRoot, plan.snapshot.sourceContext.root);
      if (verified !== client) {
        throw new SettingsError('The server connection changed. Reopen the editor.');
      }
    }
    assertProject();
    return assertProject;
  };
  const load = async (reloading = false) => {
    const { root } = await connection();
    const path = api.state.path as { worktree?: string; directory?: string };
    const project = currentProject(root);
    const baseline = await readNative();
    const snapshot = await loadSnapshot(
      root,
      project,
      reloading ? { model: baseline.model, small_model: baseline.small_model } : baseline,
      path.directory ?? project,
      typeof path.worktree === 'string' && path.worktree !== '' ? path.worktree : project,
    );
    native.set(snapshot, { model: snapshot.resolved.model, small_model: snapshot.resolved.small_model });
    return snapshot;
  };
  const models = async () => {
    const response: { error?: unknown; data?: { providers: unknown } | null } = await api.client.config.providers();
    const failed = Boolean(response.error);
    if (failed) {
      throw new SettingsError('Could not load provider models. Check your connection and try again.');
    }
    const result = catalogModels(response.data?.providers);
    if (result.length === 0) {
      throw new SettingsError('No provider models are available. Connect a provider with /connect first.');
    }
    return result;
  };
  const resolvedLabel = (snapshot: Snapshot, choice: GroupChoice) => {
    let suffix = '';
    if (choice.modelRef?.startsWith('opencode:') === true) {
      const field = choice.modelRef === 'opencode:model' ? 'model' : 'small_model';
      if (context(snapshot).native?.[field] !== snapshot.config[field]) {
        suffix = ' · running workspace differs from saved global';
      }
    }
    return `${choice.modelRef !== undefined && choice.modelRef !== '' ? `${choice.modelRef} → ` : ''}${label(choice)}${suffix}`;
  };
  const describeGroup = (snapshot: Snapshot, choice: GroupChoice) => {
    try {
      return resolvedLabel(snapshot, resolveGroup(choice, context(snapshot)));
    } catch (error) {
      if (!(error instanceof SettingsError)) {
        throw error;
      }
      return `${choice.modelRef ?? 'Group'} → Invalid: ${error.message}`;
    }
  };
  const describeAgent = (snapshot: Snapshot, agent: StoredAgent) => {
    try {
      const choice = snapshot.resolved.choices[agent.name] ?? {
        model: agent.settings.model,
        variant: agent.settings.variant,
      };
      return `${resolvedLabel(snapshot, choice)} · ${snapshot.resolved.selectedAgents.includes(agent.name) ? 'Active profile settings' : 'Native fallback'}`;
    } catch (error) {
      if (!(error instanceof SettingsError)) {
        throw error;
      }
      return `Invalid: ${error.message}`;
    }
  };
  const selectModel = async (
    title: string,
    current: ModelChoice,
    selected: (choice: ModelChoice) => void | Promise<void>,
    variants = true,
    extra: Action[] = [],
    inheritedVariant?: ModelChoice,
  ) => {
    const isCurrent = navigation.checkpoint();
    const available = await models();
    if (!isCurrent()) {
      return;
    }
    menu(
      title,
      [
        ...extra,
        ...available.map((model: CatalogModel) => ({
          title: model.name,
          value: model.id,
          description: model.id,
          category: model.provider,
          run: () => {
            const names = Object.keys(model.variants);
            if (!variants || names.length === 0) {
              return selected({ model: model.id });
            }
            menu(
              `${model.name}: variant`,
              [
                {
                  title:
                    inheritedVariant?.model === model.id && inheritedVariant.variant !== undefined
                      ? `Inherit authored variant (${inheritedVariant.variant})`
                      : 'Model default',
                  value: '',
                  run: () => selected({ model: model.id }),
                },
                ...names.map((variant) => ({
                  title: variant,
                  value: variant,
                  run: () => selected({ model: model.id, variant }),
                })),
              ],
              current.model === model.id ? (current.variant ?? '') : '',
            );
          },
        })),
      ],
      current.model,
    );
  };
  const reload = async () => {
    const status: { error?: unknown; data?: Record<string, SessionStatus> | null } = await api.client.session.status();
    if (Boolean(status.error) || status.data === undefined || status.data === null) {
      throw new SettingsError('Could not check running agents. Settings are saved; restart when idle.');
    }
    if (Object.values(status.data).some((item) => item.type !== 'idle')) {
      throw new SettingsError(
        'Agents are still running in this workspace. Settings are saved; reload when they finish.',
      );
    }
    // Saved native edits legitimately differ from the still-running server until this reload.
    const snapshot = await load(true);
    if ((await realpath(globalDirectory).catch(() => undefined)) !== snapshot.root) {
      throw new SettingsError(
        'Settings are saved. Restart OpenCode to apply edits in a custom configuration directory.',
      );
    }
    if (api.lifecycle.signal.aborted) {
      return;
    }
    // Complete the network proof before reloadConfiguration's final stale-file checks.
    const { client, assertCurrent } = await connection(snapshot.root);
    await reloadConfiguration(snapshot, async (plugins) => {
      const plugin = plugins.map((entry): string | [string, Record<string, unknown>] => {
        if (typeof entry === 'string') {
          return entry;
        }
        if (Array.isArray(entry) && typeof entry[0] === 'string' && record(entry[1])) {
          return [entry[0], entry[1]];
        }
        throw new SettingsError('Settings were saved, but a plugin entry is invalid. Fix it before reloading.');
      });
      assertCurrent();
      const result = await client.global.config.update({ config: { plugin } });
      const failed = Boolean(result.error);
      if (failed) {
        throw new SettingsError('Settings were saved, but reload failed. Restart OpenCode to apply them.');
      }
    });
    navigation.close();
    api.ui.toast({
      variant: 'success',
      title: 'Settings reloaded',
      message: 'New agent calls use the saved defaults. A session model selection can still override them.',
      duration: 8000,
    });
  };
  const offerReload = (root = false) =>
    menu(
      'Settings saved',
      [
        {
          title: 'Reload now…',
          value: 'reload',
          description: 'Apply saved settings to this OpenCode server',
          run: () =>
            confirm(
              'Reload OpenCode settings?',
              'This reloads ALL workspaces on this server. Wait for agents in every workspace to finish first.\n\n' +
                'Existing session model selections remain; use /models to change the current session.',
              reload,
            ),
        },
        { title: 'Apply on next restart', value: 'later', run: navigation.close },
        // eslint-disable-next-line @typescript-eslint/no-use-before-define -- Mutually linked menu callbacks run after all handlers initialize.
        { title: 'Agent groups', value: 'groups', run: () => groupsMenu(false) },
        // eslint-disable-next-line @typescript-eslint/no-use-before-define -- Mutually linked menu callbacks run after all handlers initialize.
        { title: 'Agent models', value: 'models', run: () => modelsMenu(false) },
      ],
      undefined,
      root,
    );
  const propose = async (snapshot: Snapshot, change: Change) => {
    const isCurrent = navigation.checkpoint();
    const plan = planChange(snapshot, change);
    const preview = await plannedChoices(plan, context(snapshot).native);
    if (!isCurrent()) {
      return;
    }
    const affected = affectedGroups(snapshot, change);
    const members = snapshot.agents.filter((agent) =>
      memberships(snapshot, agent).some((group) => affected.includes(group)),
    );
    const pinned = members.filter(
      (agent) => typeof agent.settings.model === 'string' && agent.settings.model !== '',
    ).length;
    const impact =
      affected.length > 0
        ? `\n${affected.length} linked or selected groups; ` +
          `${members.length - pinned} agents use inherited settings; ${pinned} explicit model overrides are retained.`
        : '';
    const choiceLabel =
      change.kind === 'group'
        ? describeGroup(snapshot, change.choice)
        : change.kind === 'global'
          ? label({ model: change.model })
          : change.kind === 'all' || change.kind === 'preset' || change.kind === 'override'
            ? label(change.choice)
            : '';
    const scope =
      change.kind === 'global' || change.kind === 'all'
        ? '\nOther native fallback consumers can also change. Workspace overrides and session selections still apply.'
        : '';
    const modelsPreview = [
      ...new Set(
        preview.map(
          (choice) =>
            `${label(choice)}${choice.parameters === undefined ? '' : ` · parameters ${JSON.stringify(choice.parameters).slice(0, 1200)}`}`,
        ),
      ),
    ].join(', ');
    confirm(
      'Save agent settings?',
      `${plan.description}\n${choiceLabel}${impact}${scope}\nModels to validate: ${modelsPreview === '' ? 'Native fallback' : modelsPreview}\n\n` +
        `${plan.edits.length} file(s) will change. Reload settings after saving to apply them.`,
      async () => {
        if (native.has(snapshot)) {
          await refreshNative(snapshot);
        }
        const choices = await plannedChoices(plan, context(snapshot).native);
        if (JSON.stringify(choices) !== JSON.stringify(preview)) {
          throw new SettingsError(
            'Effective model defaults changed while the dialog was open. Reopen it and review the new models.',
          );
        }
        if (choices.some((choice) => typeof choice.model === 'string' && choice.model !== '')) {
          const available = await models();
          for (const choice of choices) {
            validateParameterChoice(choice, available);
          }
        }
        if (api.lifecycle.signal.aborted) {
          return;
        }
        await savePlan(plan, () => authorizePlan(plan));
        offerReload(true);
      },
    );
  };
  const selectReference = async (snapshot: Snapshot, name: string, modelRef: string) => {
    const isCurrent = navigation.checkpoint();
    if (modelRef.startsWith('opencode:') || native.has(snapshot)) {
      await refreshNative(snapshot);
    }
    const resolved = resolveGroup({ modelRef }, context(snapshot));
    const model = validateChoice({ model: resolved.model }, await models());
    if (!isCurrent()) {
      return;
    }
    if (model === undefined) {
      throw new SettingsError('Select a concrete model for the group reference.');
    }
    const selected = (variant?: string) =>
      propose(snapshot, {
        kind: 'group',
        name,
        choice: { modelRef, ...(variant !== undefined && variant !== '' ? { variant } : {}) },
      });
    const variants = Object.keys(model.variants);
    if (variants.length === 0) {
      await selected();
      return;
    }
    menu(
      `${modelRef} → ${model.id}: variant`,
      [
        {
          title: modelRef.startsWith('preset:')
            ? `Inherit preset variant (${resolved.variant ?? 'model default'})`
            : 'Model default',
          value: '',
          run: () => selected(),
        },
        ...variants.map((variant) => ({ title: variant, value: variant, run: () => selected(variant) })),
      ],
      Object.hasOwn(snapshot.groups, name) && snapshot.groups[name].modelRef === modelRef
        ? (snapshot.groups[name].variant ?? '')
        : '',
    );
  };
  const selectGroup = (snapshot: Snapshot, name: string) =>
    selectModel(
      `Group: ${name} · model source`,
      snapshot.groups[name] ?? {},
      (choice) => propose(snapshot, { kind: 'group', name, choice }),
      true,
      [
        {
          title: 'OpenCode fallback',
          value: '+fallback',
          category: 'Model source',
          description: 'Leave model selection to OpenCode; this is not a main or small reference',
          run: () => propose(snapshot, { kind: 'group', name, choice: {} }),
        },
        {
          title: 'Main default',
          value: 'opencode:model',
          category: 'Model source',
          description: 'Follow the effective workspace model setting',
          run: () => selectReference(snapshot, name, 'opencode:model'),
        },
        {
          title: 'Small default',
          value: 'opencode:small_model',
          category: 'Model source',
          description: 'Follow the effective workspace small_model setting',
          run: () => selectReference(snapshot, name, 'opencode:small_model'),
        },
        ...Object.keys(snapshot.modelPresets)
          .sort()
          .map((preset) => ({
            title: preset,
            value: `preset:${preset}`,
            category: 'Model presets',
            description: label(snapshot.modelPresets[preset]),
            run: () => selectReference(snapshot, name, `preset:${preset}`),
          })),
      ],
    );
  const newGroup = (snapshot: Snapshot, agent?: StoredAgent) => {
    navigation.prompt({
      title: 'New agent group',
      placeholder: 'e.g. data-engineering',
      // eslint-disable-next-line @typescript-eslint/no-misused-promises -- run handles rejection; return its Promise so callers can await completion.
      onConfirm: (value) =>
        run(() => {
          const name = groupName(value.trim());
          if (groupNames(snapshot).includes(name)) {
            throw new SettingsError('That group already exists. Choose it from the group list.');
          }
          return propose(
            snapshot,
            agent !== undefined
              ? { kind: 'membership', agent: agent.name, groups: [...memberships(snapshot, agent), name] }
              : { kind: 'group', name, choice: {} },
          );
        }),
    });
  };
  const presetMenu = (snapshot: Snapshot, name: string) =>
    menu(`Model preset: ${name}`, [
      {
        title: 'Set model and variant',
        value: 'model',
        description: label(snapshot.modelPresets[name]),
        run: () =>
          selectModel(name, snapshot.modelPresets[name], (choice) =>
            propose(snapshot, { kind: 'preset', name, choice }),
          ),
      },
      {
        title: 'Delete unused preset…',
        value: 'delete',
        description: 'Reassign dependent groups before deleting',
        run: () => propose(snapshot, { kind: 'deletePreset', name }),
      },
    ]);
  const presetsMenu = (snapshot: Snapshot) =>
    menu('Model presets', [
      ...Object.keys(snapshot.modelPresets)
        .sort()
        .map((name) => ({
          title: name,
          value: name,
          description:
            `${label(snapshot.modelPresets[name])} · ` +
            `${Object.values(snapshot.groups).filter((choice) => choice.modelRef === `preset:${name}`).length} linked groups`,
          run: () => presetMenu(snapshot, name),
        })),
      {
        title: 'Create a model preset…',
        value: '+',
        run: () => {
          navigation.prompt({
            title: 'New model preset',
            placeholder: 'e.g. balanced',
            // eslint-disable-next-line @typescript-eslint/no-misused-promises -- run handles rejection; return its Promise so callers can await completion.
            onConfirm: (value) =>
              run(async () => {
                const name = presetName(value.trim());
                if (Object.hasOwn(snapshot.modelPresets, name)) {
                  throw new SettingsError('That model preset already exists.');
                }
                await selectModel(name, {}, (choice) => propose(snapshot, { kind: 'preset', name, choice }));
              }),
          });
        },
      },
    ]);
  const membershipMenu = (snapshot: Snapshot, agent: StoredAgent) => {
    const pending = [...memberships(snapshot, agent)];
    const options = () => {
      return [
        {
          title: 'Save groups…',
          value: '+save',
          description: 'Membership uses active profile layer order; save to preview the effective models.',
          run: () => propose(snapshot, { kind: 'membership', agent: agent.name, groups: [...pending] }),
        },
        ...pending.map((name, index) => ({
          title: `${index + 1}. ${name}`,
          value: name,
          description: 'Active profile layer order controls precedence',
          run: () =>
            menu(`Membership: ${name}`, [
              {
                title: 'Remove group',
                value: 'remove',
                run: () => {
                  pending.splice(index, 1);
                  navigation.back();
                },
              },
              ...(index > 0
                ? [
                    {
                      title: 'Move earlier',
                      value: 'earlier',
                      run: () => {
                        pending.splice(index, 1);
                        pending.splice(index - 1, 0, name);
                        navigation.back();
                      },
                    },
                  ]
                : []),
              ...(index < pending.length - 1
                ? [
                    {
                      title: 'Move later',
                      value: 'later',
                      run: () => {
                        pending.splice(index, 1);
                        pending.splice(index + 1, 0, name);
                        navigation.back();
                      },
                    },
                  ]
                : []),
            ]),
        })),
        {
          title: 'Add group',
          value: '+add',
          run: () =>
            menu(
              'Choose a group',
              groupNames(snapshot)
                .filter((name) => !pending.includes(name))
                .map((name) => ({
                  title: name,
                  value: name,
                  run: () => {
                    pending.push(name);
                    navigation.back();
                  },
                })),
            ),
        },
        {
          title: 'Clear all groups',
          value: '+clear',
          run: () => {
            pending.splice(0);
            navigation.refresh();
          },
        },
      ];
    };
    menu(`${agent.name}: groups`, options);
  };
  const agentMenu = (snapshot: Snapshot, agent: StoredAgent) => {
    const groups = memberships(snapshot, agent);
    menu(`${agent.name} · ${groups.length > 0 ? groups.join(' → ') : 'Ungrouped'}`, [
      {
        title: 'Manage groups',
        value: 'group',
        description: 'Keep any explicit model override',
        run: () => membershipMenu(snapshot, agent),
      },
      {
        title: 'Set model override',
        value: 'override',
        description: describeAgent(snapshot, agent),
        run: () =>
          selectModel(
            agent.name,
            snapshot.resolved.choices[agent.name] ?? agent.settings,
            (choice) => propose(snapshot, { kind: 'override', agent: agent.name, choice }),
            true,
            [],
            agent.component === true ? agent.settings : undefined,
          ),
      },
      {
        title: agent.component === true ? 'Use component source defaults' : 'Use group defaults',
        value: 'inherit',
        description:
          agent.component === true
            ? "Clear this component's JSONC model and variant overrides"
            : "Clear this agent's model and variant overrides",
        run: () => propose(snapshot, { kind: 'override', agent: agent.name, choice: {} }),
      },
    ]);
  };
  const members = (snapshot: Snapshot, group?: string) =>
    snapshot.agents.filter((agent) =>
      group === undefined ? memberships(snapshot, agent).length === 0 : memberships(snapshot, agent).includes(group),
    );
  const agentOptions = (snapshot: Snapshot, agents: StoredAgent[]): Action[] =>
    agents.map((agent) => ({
      title: agent.name,
      value: agent.name,
      description: describeAgent(snapshot, agent),
      run: () => agentMenu(snapshot, agent),
    }));
  const groupMenu = (snapshot: Snapshot, name: string) =>
    menu(`Group: ${name}`, [
      {
        title: 'Set default model or source',
        value: '+model',
        description: describeGroup(snapshot, snapshot.groups[name] ?? {}),
        run: () => selectGroup(snapshot, name),
      },
      {
        title: 'Use OpenCode fallback',
        value: '+inherit',
        description: "Clear this group's model, reference, and variant defaults",
        run: () => propose(snapshot, { kind: 'group', name, choice: {} }),
      },
      {
        title: 'Add an agent to group',
        value: '+move',
        run: () =>
          menu(
            'Choose an agent',
            snapshot.agents
              .filter((agent) => !memberships(snapshot, agent).includes(name))
              .map((agent) => ({
                title: agent.name,
                value: agent.name,
                description:
                  memberships(snapshot, agent).length > 0 ? memberships(snapshot, agent).join(' → ') : 'Ungrouped',
                run: () =>
                  propose(snapshot, {
                    kind: 'membership',
                    agent: agent.name,
                    groups: [...memberships(snapshot, agent), name],
                  }),
              })),
          ),
      },
      ...agentOptions(snapshot, members(snapshot, name)).map((option) => ({ ...option, category: 'Members' })),
    ]);
  const groupsMenu = async (root = true) => {
    const isCurrent = navigation.checkpoint();
    const snapshot = await load();
    if (!isCurrent()) {
      return;
    }
    menu(
      'Agent groups',
      [
        ...groupNames(snapshot).map((name) => ({
          title: name,
          value: name,
          description: `${members(snapshot, name).length} agents · ${describeGroup(snapshot, snapshot.groups[name] ?? {})}`,
          run: () => groupMenu(snapshot, name),
        })),
        {
          title: 'Ungrouped',
          value: '',
          run: () => menu('Ungrouped agents', agentOptions(snapshot, members(snapshot))),
        },
        { title: 'Create a new group…', value: '+', run: () => newGroup(snapshot) },
        { title: 'All agents', value: '+agents', run: () => menu('Agents', agentOptions(snapshot, snapshot.agents)) },
      ],
      undefined,
      root,
    );
  };
  const modelsMenu = async (root = true) => {
    const isCurrent = navigation.checkpoint();
    const snapshot = await load();
    if (!isCurrent()) {
      return;
    }
    menu(
      'Agent models: scope',
      [
        {
          title: 'Global defaults',
          value: '+global',
          run: () =>
            menu(
              'Global defaults',
              (['model', 'small_model'] as const).map((field) => {
                const saved = snapshot.config[field];
                const model = typeof saved === 'string' ? saved : undefined;
                return {
                  title: field === 'model' ? 'Main model' : 'Small model',
                  value: field,
                  description: model ?? 'OpenCode fallback',
                  run: () =>
                    selectModel(
                      field,
                      { model },
                      (choice) => {
                        if (choice.model === undefined || choice.model === '') {
                          throw new SettingsError('Select a concrete global model.');
                        }
                        return propose(snapshot, { kind: 'global', field, model: choice.model });
                      },
                      false,
                    ),
                };
              }),
            ),
        },
        {
          title: 'Model presets',
          value: '+presets',
          description: 'Create and edit reusable model choices',
          run: () => presetsMenu(snapshot),
        },
        {
          title: 'All defaults',
          value: '+all',
          description: 'Main, small, presets, and every group; keep references and agent pins',
          run: () => selectModel('All defaults', {}, (choice) => propose(snapshot, { kind: 'all', choice })),
        },
        ...groupNames(snapshot).map((name) => ({
          title: name,
          value: name,
          category: 'Groups',
          description: describeGroup(snapshot, snapshot.groups[name] ?? {}),
          run: () => selectGroup(snapshot, name),
        })),
        {
          title: 'Individual agent overrides',
          value: '+agents',
          run: () => menu('Agents', agentOptions(snapshot, snapshot.agents)),
        },
        { title: 'Reload saved settings…', value: '+reload', run: () => offerReload() },
      ],
      undefined,
      root,
    );
  };
  const proposeComposition = async (
    snapshot: Snapshot,
    plan: FilePlan,
    change?: DefinitionChange,
    review?: {
      title: string;
      details: string;
      validate?: (preview: Awaited<ReturnType<typeof previewFilePlan>>) => Promise<void>;
      savedMessage?: string;
    },
  ) => {
    const isCurrent = navigation.checkpoint();
    const preview = await previewFilePlan(plan);
    if (!isCurrent()) {
      return;
    }
    const projection = (value: typeof preview) =>
      JSON.stringify({
        model: value.resolved.model,
        small_model: value.resolved.small_model,
        choices: value.resolved.choices,
        agent: value.resolved.agent,
        permissions: value.resolved.permissions,
        skillPaths: value.resolved.skillPaths,
        commands: value.resolved.commands,
        profiles: value.sources.activeProfiles,
      });
    const changed = Object.entries(preview.resolved.choices).filter(
      ([name, choice]) => JSON.stringify(choice) !== JSON.stringify(snapshot.resolved.choices[name]),
    );
    const globals = (['model', 'small_model'] as const).flatMap((field) =>
      preview.resolved[field] === snapshot.resolved[field] || preview.resolved[field] === undefined
        ? []
        : [{ field, model: preview.resolved[field] }],
    );
    const commands = Object.entries(preview.resolved.commands).flatMap(([name, command]) =>
      command.model === undefined ||
      (Object.hasOwn(snapshot.resolved.commands, name) && command.model === snapshot.resolved.commands[name].model)
        ? []
        : [{ name, model: command.model }],
    );
    const affected = [
      ...new Set([...Object.keys(snapshot.resolved.agent), ...Object.keys(preview.resolved.agent)]),
    ].filter((name) => JSON.stringify(snapshot.resolved.agent[name]) !== JSON.stringify(preview.resolved.agent[name]));
    confirm(
      review?.title ?? (change === undefined ? 'Save profile selection?' : 'Save composition definition?'),
      `${plan.description}\n\n${plan.edits.map((edit) => edit.file.path).join('\n')}\n\n` +
        (review === undefined ? '' : `${review.details}\n\n`) +
        `${affected.length} agent configuration previews change (including removal or native fallback).\n` +
        `Changed global models: ${globals.length === 0 ? 'none' : globals.map(({ field, model }) => `${field}: ${model}`).join(', ')}.\n` +
        `Changed command models: ${commands.length === 0 ? 'none' : commands.map(({ name, model }) => `${name}: ${model}`).join(', ')}.\n` +
        `Commands: ${Object.keys(preview.resolved.commands).join(', ')}. Skill directories: ${preview.resolved.skillPaths.length}.\n` +
        `Active profiles: ${preview.sources.activeProfiles.join(' → ')}.\n` +
        (review?.savedMessage === undefined
          ? 'Save preserves conversations. Reload saved settings to apply changes.'
          : 'Save preserves conversations and records authoring changes only. Selected permission contributions cannot be applied by this draft.'),
      async () => {
        await refreshNative(snapshot);
        const latest = await previewFilePlan(plan);
        await review?.validate?.(latest);
        if (projection(latest) !== projection(preview)) {
          throw new SettingsError('Effective defaults changed. Reopen the editor and review the new preview.');
        }
        const choices = [...changed.map(([, choice]) => choice), ...globals, ...commands];
        if (
          change?.registry === 'configurationPresets' &&
          (change.operation === 'create' || change.operation === 'patch')
        ) {
          // Inactive presets have no affected agents, but their chosen model must still be available at save time.
          choices.push(editorSettings(latest.sources, snapshot.nativeModels).modelPresets[change.name]);
        }
        if (choices.some((choice) => choice.model !== undefined)) {
          const catalog = await models();
          choices.forEach((choice) => validateParameterChoice(choice, catalog));
        }
        if (api.lifecycle.signal.aborted) {
          return;
        }
        await saveFilePlan(
          plan,
          async () => {
            await refreshNative(snapshot);
            const current = await previewFilePlan(plan);
            await review?.validate?.(current);
            if (projection(current) !== projection(preview)) {
              throw new SettingsError('Effective defaults changed. Reopen the editor and review the new preview.');
            }
          },
          () => authorizePlan(plan),
        );
        if (review?.savedMessage !== undefined) {
          navigation.alert({ title: 'Configured permission rules saved', message: review.savedMessage });
        } else {
          offerReload(true);
        }
      },
    );
  };
  const proposeDefinition = (snapshot: Snapshot, change: DefinitionChange) =>
    proposeComposition(snapshot, planDefinition(snapshot, change), change);
  const composeMenu = () =>
    menu(
      'Compose',
      [
        { title: 'Component groups and memberships', value: 'groups', run: () => groupsMenu(false) },
        { title: 'Models and configuration presets', value: 'models', run: () => modelsMenu(false) },
        {
          title: 'Ordered permission rules and configured previews',
          value: 'permissions',
          description: 'Authoring only; native enforcement integration is pending',
          run: async () => {
            const isCurrent = navigation.checkpoint();
            const snapshot = await load();
            if (!isCurrent()) {
              return;
            }
            const ask = (title: string, value: string, confirmed: (value: string) => void | Promise<void>) =>
              navigation.prompt({
                title,
                value,
                // eslint-disable-next-line @typescript-eslint/no-misused-promises -- run owns asynchronous prompt failures.
                onConfirm: (value) => run(() => confirmed(value)),
              });
            openPermissions(snapshot, {
              menu,
              prompt: ask,
              back: navigation.back,
              refresh: navigation.refresh,
              create: (sourceId, name) =>
                proposeDefinition(snapshot, {
                  operation: 'create',
                  registry: 'configurationPresets',
                  name,
                  sourceId,
                  value: { permissions: [] },
                }),
              propose: (target, rules) =>
                proposeComposition(snapshot, planPermissions(snapshot, target, rules), undefined, {
                  title: 'Save configured permission rules?',
                  details: `${permissionStatus}\n\n${rules === undefined ? 'Remove local contributions.' : rules.map((rule, index) => `${index + 1}. ${rule.tool} ${rule.pattern ?? '*'} → ${rule.action}`).join('\n')}`,
                  savedMessage: `${permissionStatus}\n\nThe JSONC rules were saved for authoring. The running configuration and conversations are unchanged. Remove selected permission contributions or deactivate their profiles before using Reload in this draft.`,
                }),
              preview: async (target, rules) => {
                const current = navigation.checkpoint();
                const candidate = await previewFilePlan(planPermissions(snapshot, target, rules));
                if (!current()) {
                  return;
                }
                const local = rules.map((rule, index) => ({
                  agent: 'local',
                  rule,
                  origin: {
                    sourceId: target.sourceId,
                    pointer: `/${[...target.path, 'permissions', String(index), 'action'].map((part) => part.replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`,
                    layer: 'selected definition',
                    operation: 'set' as const,
                    references: [],
                    overwritten: [],
                  },
                }));
                const testMatch = (agent: string, contributions: typeof candidate.resolved.permissions) =>
                  ask('Permission tool to test', 'bash', (tool) =>
                    ask('Permission input to test', '', (input) => {
                      const result = previewPermission(contributions, agent, tool, input);
                      navigation.alert({
                        title: 'Configured permission match',
                        message: `${permissionStatus}\n\n${result.fallback === 'native' ? 'No Composer rule matches. Defer to native globals/defaults; no native action is inferred.' : `${result.action}: ${result.matched.permission} ${result.matched.pattern}\n${result.origin?.sourceId ?? ''}#${result.origin?.pointer ?? ''}\nEarlier matching contributions: ${result.origin?.overwritten.map((origin) => `${origin.sourceId ?? ''}#${origin.pointer}`).join(', ') ?? 'none'}`}`,
                      });
                    }),
                  );
                menu('Permission preview scope', [
                  {
                    title: 'This definition’s rules only',
                    value: '+local',
                    description: 'Excludes other layers and active selections',
                    run: () => testMatch('local', local),
                  },
                  ...candidate.resolved.selectedAgents.map((agent) => ({
                    title: agent,
                    value: `agent:${agent}`,
                    description: 'All configured active contributions in replay order',
                    run: () => testMatch(agent, candidate.resolved.permissions),
                  })),
                ]);
              },
            });
          },
        },
        {
          title: 'Model parameters and provider options',
          value: 'parameters',
          run: async () => {
            const isCurrent = navigation.checkpoint();
            const snapshot = await load();
            if (!isCurrent()) {
              return;
            }
            openParameters(snapshot, {
              menu,
              prompt: (title, value, confirmed) =>
                navigation.prompt({
                  title,
                  value,
                  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- run owns asynchronous prompt failures.
                  onConfirm: (value) => run(() => confirmed(value)),
                }),
              propose: async (target, field, text) => {
                const current = navigation.checkpoint();
                const plan = planParameter(snapshot, target, field, text);
                const preview = await previewFilePlan(plan);
                const details = parameterReview(snapshot, target, preview, await models());
                if (!current()) {
                  return;
                }
                await proposeComposition(snapshot, plan, undefined, {
                  title: 'Save model parameters?',
                  details,
                  validate: async (candidate) => {
                    parameterReview(snapshot, target, candidate, await models());
                  },
                });
              },
            });
          },
        },
        {
          title: 'Profile activation and scope files',
          value: 'activation',
          run: async () => {
            const isCurrent = navigation.checkpoint();
            const snapshot = await load();
            if (!isCurrent()) {
              return;
            }
            openActivation(snapshot, {
              menu,
              back: navigation.back,
              propose: (scope, change) => proposeComposition(snapshot, planScope(snapshot, scope, change)),
            });
          },
        },
        {
          title: 'Author groups, presets and profiles',
          value: 'registry',
          run: async () => {
            const isCurrent = navigation.checkpoint();
            const snapshot = await load();
            if (!isCurrent()) {
              return;
            }
            openAuthoring(snapshot, {
              menu,
              back: navigation.back,
              refresh: navigation.refresh,
              prompt: (title, value, confirmed) =>
                navigation.prompt({
                  title,
                  value,
                  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- run owns asynchronous prompt failures.
                  onConfirm: (value) => run(() => confirmed(value)),
                }),
              propose: proposeDefinition,
              groupModel: selectGroup,
              createPreset: (selected) =>
                selectModel('New configuration preset', {}, (choice) => {
                  if (choice.model === undefined || choice.model === '') {
                    throw new SettingsError('Choose a concrete model for the new preset.');
                  }
                  return selected({
                    model: choice.model,
                    ...(choice.variant === undefined ? {} : { variant: choice.variant }),
                  });
                }),
              presetModel: (snapshot, name) =>
                selectModel(name, snapshot.modelPresets[name], (choice) =>
                  propose(snapshot, { kind: 'preset', name, choice }),
                ),
            });
          },
        },
        {
          title: 'Effective configuration and sources',
          value: 'effective',
          description: 'Inspect saved profiles, layer order, field origins, and source files',
          run: async () => {
            const isCurrent = navigation.checkpoint();
            const snapshot = await load();
            if (isCurrent()) {
              openEffective(snapshot, navigation);
            }
          },
        },
        { title: 'Reload saved settings…', value: 'reload', run: () => offerReload() },
      ],
      undefined,
      true,
    );
  const unregister = api.keymap.registerLayer({
    commands: [
      {
        name: 'config-composer.compose',
        title: 'Compose configuration',
        category: 'Config',
        namespace: 'palette',
        slashName: 'compose',
        run: () => {
          navigation.reset();
          return run(composeMenu);
        },
      },
      {
        name: 'config-composer.models',
        title: 'Agent models',
        category: 'Config',
        namespace: 'palette',
        slashName: 'agent-models',
        run: () => {
          navigation.reset();
          return run(() => modelsMenu());
        },
      },
      {
        name: 'config-composer.membership',
        title: 'Agent groups',
        category: 'Config',
        namespace: 'palette',
        slashName: 'agent-groups',
        run: () => {
          navigation.reset();
          return run(() => groupsMenu());
        },
      },
      {
        name: 'config-composer.reload',
        title: 'Reload saved settings',
        category: 'Config',
        namespace: 'palette',
        slashName: 'reload-configs',
        run: () => {
          navigation.reset();
          return run(() => offerReload(true));
        },
      },
    ],
  });
  api.lifecycle.onDispose(unregister);
}

// eslint-disable-next-line @typescript-eslint/require-await -- OpenCode requires a Promise-returning TUI initializer.
const ConfigComposerTui: TuiPlugin = async (api) => {
  registerSettings(api);
};
export default { id: 'config-composer', tui: ConfigComposerTui } satisfies TuiPluginModule;
