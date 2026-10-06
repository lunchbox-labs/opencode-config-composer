export interface ModelChoice {
  model?: string;
  variant?: string;
}
export interface PromptOperations {
  prepend?: string[];
  append?: string[];
}
export interface AgentPrompt extends PromptOperations {
  inheritDefaults?: boolean;
  inheritGroups?: boolean;
}
export type GroupChoice = ModelChoice & { modelRef?: string; prompt?: PromptOperations };
export type Groups = Record<string, GroupChoice>;
export type ModelPresets = Record<string, ModelChoice>;
export interface NativeModels {
  model?: string;
  small_model?: string;
}
export interface ResolutionContext {
  modelPresets?: ModelPresets;
  native?: NativeModels;
}
export interface GroupOptions extends NativeModels {
  groups: Groups;
  modelPresets: ModelPresets;
  promptSources: Record<string, string>;
  promptDefaults: PromptOperations;
  agentPrompts: Record<string, AgentPrompt>;
}
export type AgentSettings = ModelChoice & {
  groups?: string[];
  disable?: boolean;
  options?: Record<string, unknown>;
  [key: string]: unknown;
};
export type EffectiveChoice = GroupChoice & {
  group?: string;
  groups?: string[];
  source: 'agent' | 'group' | 'native';
};

export class SettingsError extends Error {}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function settingName(value: unknown, kind: string): string {
  if (
    typeof value !== 'string' ||
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value) ||
    value.length > 64 ||
    ['constructor', 'prototype'].includes(value)
  ) {
    throw new SettingsError(`Use a ${kind} name of up to 64 lowercase letters, digits, and hyphens.`);
  }
  return value;
}

export function groupName(value: unknown): string {
  return settingName(value, 'group');
}

export function presetName(value: unknown): string {
  return settingName(value, 'preset');
}

function variantName(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !/^[\w.-]{1,64}$/.test(value)) {
    throw new SettingsError('Select a valid reasoning variant.');
  }
  return value;
}

export function modelChoice(value: unknown): ModelChoice {
  if (!record(value) || Object.keys(value).some((key) => !['model', 'variant'].includes(key))) {
    throw new SettingsError('Model choices support only model and variant.');
  }
  if (value.model !== undefined && (typeof value.model !== 'string' || !/^[^\s/]+\/\S+$/.test(value.model))) {
    throw new SettingsError('Select a model in provider/model format.');
  }
  const variant = variantName(value.variant);
  if (variant !== undefined && value.model === undefined) {
    throw new SettingsError('A variant requires a model or a group model reference.');
  }
  return {
    ...(value.model !== undefined ? { model: value.model } : {}),
    ...(variant !== undefined ? { variant } : {}),
  };
}

export function modelReference(value: unknown): string {
  if (value === 'opencode:model' || value === 'opencode:small_model') {
    return value;
  }
  if (typeof value === 'string' && value.startsWith('preset:')) {
    return `preset:${presetName(value.slice(7))}`;
  }
  throw new SettingsError('Select opencode:model, opencode:small_model, or preset:<name> as the model reference.');
}

export function promptOperations(value: unknown, perAgent = false): AgentPrompt {
  const keys = perAgent ? ['prepend', 'append', 'inheritDefaults', 'inheritGroups'] : ['prepend', 'append'];
  if (!record(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new SettingsError('Prompt settings support prepend and append arrays and per-agent inheritance options.');
  }
  const result: AgentPrompt = {};
  for (const key of ['prepend', 'append'] as const) {
    const items: unknown = value[key];
    if (items === undefined) {
      continue;
    }
    if (!Array.isArray(items) || items.length > 256 || !items.every((item) => typeof item === 'string')) {
      throw new SettingsError('Prompt prepend and append values must be arrays of up to 256 strings.');
    }
    result[key] = items.map((item: string) => item);
  }
  for (const key of ['inheritDefaults', 'inheritGroups'] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'boolean') {
        throw new SettingsError('Prompt inheritance options must be boolean values.');
      }
      result[key] = value[key];
    }
  }
  return result;
}

export function groupChoice(value: unknown): GroupChoice {
  if (!record(value) || Object.keys(value).some((key) => !['model', 'modelRef', 'variant', 'prompt'].includes(key))) {
    throw new SettingsError('Group defaults support only model, modelRef, variant, and prompt.');
  }
  const prompt = value.prompt === undefined ? {} : { prompt: promptOperations(value.prompt) };
  if (value.modelRef === undefined) {
    return { ...modelChoice({ model: value.model, variant: value.variant }), ...prompt };
  }
  if (value.model !== undefined) {
    throw new SettingsError('Choose either a model or a model reference, not both.');
  }
  const modelRef = modelReference(value.modelRef);
  const variant = variantName(value.variant);
  return { modelRef, ...(variant !== undefined ? { variant } : {}), ...prompt };
}

function configuredName(value: string): string {
  if (
    value.length === 0 ||
    value.length > 256 ||
    /[\s\\]/.test(value) ||
    value.split('/').some((part) => ['.', '..', '__proto__', 'constructor', 'prototype', ''].includes(part))
  ) {
    throw new SettingsError('Use a valid configured agent name.');
  }
  return value;
}

function normalizedSettings(options: Record<string, unknown>, rawGroups: unknown): GroupOptions {
  if (
    (rawGroups !== undefined && !record(rawGroups)) ||
    ['modelPresets', 'promptSources', 'agentPrompts'].some((key) => options[key] !== undefined && !record(options[key]))
  ) {
    throw new SettingsError(
      'Config Composer settings must contain valid group, model preset, source directory, and prompt override objects.',
    );
  }
  const rawPresets = record(options.modelPresets) ? options.modelPresets : {};
  const modelPresets = Object.fromEntries(
    Object.entries(rawPresets).map(([name, value]) => {
      const choice = modelChoice(value);
      if (choice.model === undefined || choice.model === '') {
        throw new SettingsError('Each model preset requires a concrete model.');
      }
      return [presetName(name), choice];
    }),
  );
  const groups = Object.fromEntries(
    Object.entries(record(rawGroups) ? rawGroups : {}).map(([name, choice]) => [groupName(name), groupChoice(choice)]),
  );
  for (const choice of Object.values(groups)) {
    if (choice.modelRef?.startsWith('preset:') === true && !Object.hasOwn(modelPresets, choice.modelRef.slice(7))) {
      throw new SettingsError(
        `Model preset ${choice.modelRef.slice(7)} does not exist. Create it or change the reference.`,
      );
    }
  }
  const promptSources = Object.fromEntries(
    Object.entries(record(options.promptSources) ? options.promptSources : {}).map(([name, value]) => {
      if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
        throw new SettingsError('Each sourceDirectories entry requires a directory path.');
      }
      return [settingName(name, 'sourceDirectories alias'), value];
    }),
  );
  const agentPrompts = Object.fromEntries(
    Object.entries(record(options.agentPrompts) ? options.agentPrompts : {}).map(([name, value]) => [
      configuredName(name),
      promptOperations(value, true),
    ]),
  );
  return {
    groups,
    modelPresets,
    promptSources,
    promptDefaults: promptOperations(options.promptDefaults === undefined ? {} : options.promptDefaults),
    agentPrompts,
  };
}

export function readSettings(value: unknown): GroupOptions {
  if (
    !record(value) ||
    Object.keys(value).some(
      (key) => !['$schema', 'model', 'small_model', 'sourceDirectories', 'agent', 'command', 'skill'].includes(key),
    ) ||
    (value.$schema !== undefined && typeof value.$schema !== 'string')
  ) {
    throw new SettingsError('Use a valid Config Composer configuration object.');
  }
  if (value.sourceDirectories !== undefined && !record(value.sourceDirectories)) {
    throw new SettingsError('Config Composer sourceDirectories must map source aliases to directory paths.');
  }
  const agent = value.agent === undefined ? {} : value.agent;
  if (!record(agent) || Object.keys(agent).some((key) => !['groups', 'modelPresets', 'prompts'].includes(key))) {
    throw new SettingsError('Config Composer agent settings support only groups, modelPresets, and prompts.');
  }
  const prompts = agent.prompts === undefined ? {} : agent.prompts;
  if (!record(prompts) || Object.keys(prompts).some((key) => !['defaults', 'overrides'].includes(key))) {
    throw new SettingsError('Config Composer agent prompts support only defaults and overrides.');
  }
  for (const namespace of ['command', 'skill']) {
    const entries: unknown = value[namespace];
    if (entries !== undefined && (!record(entries) || Object.keys(entries).length !== 0)) {
      throw new SettingsError(
        `Config Composer ${namespace} settings are reserved and are not supported yet. Leave this namespace empty.`,
      );
    }
  }
  const defaults: NativeModels = {};
  for (const field of ['model', 'small_model'] as const) {
    const choice = modelChoice({ model: value[field] });
    if (choice.model !== undefined) {
      defaults[field] = choice.model;
    }
  }
  return {
    ...defaults,
    ...normalizedSettings(
      {
        modelPresets: agent.modelPresets,
        promptSources: value.sourceDirectories,
        promptDefaults: prompts.defaults,
        agentPrompts: prompts.overrides,
      },
      agent.groups,
    ),
  };
}

export function agentGroups(agent: AgentSettings, available?: Groups): string[] {
  if (Object.hasOwn(agent, 'agent_group') || (record(agent.options) && Object.hasOwn(agent.options, 'agent_group'))) {
    throw new SettingsError('agent_group is not supported. Use an ordered groups array.');
  }
  const memberships: unknown = agent.groups ?? agent.options?.groups;
  if (memberships !== undefined) {
    if (
      !Array.isArray(memberships) ||
      memberships.length > 64 ||
      !memberships.every((name) => typeof name === 'string')
    ) {
      throw new SettingsError('Agent groups must be an ordered array of up to 64 group names.');
    }
    const groups = memberships.map(groupName);
    if (new Set(groups).size !== groups.length) {
      throw new SettingsError('Agent groups must not contain duplicate memberships.');
    }
    if (available !== undefined && groups.some((name) => !Object.hasOwn(available, name))) {
      throw new SettingsError(
        'An agent names an unknown Config Composer group. Create the group or correct its ordered memberships.',
      );
    }
    return groups;
  }
  return [];
}

export function resolveGroup(choice: GroupChoice, context: ResolutionContext = {}): GroupChoice {
  const selected = groupChoice(choice);
  if (selected.modelRef === undefined || selected.modelRef === '') {
    return selected;
  }
  let defaults: ModelChoice;
  if (selected.modelRef.startsWith('preset:')) {
    const name = selected.modelRef.slice(7);
    if (!record(context.modelPresets) || !Object.hasOwn(context.modelPresets, name)) {
      throw new SettingsError(`Model preset ${name} does not exist. Create it or change the reference.`);
    }
    defaults = modelChoice(context.modelPresets[name]);
  } else {
    const field = selected.modelRef === 'opencode:model' ? 'model' : 'small_model';
    defaults = modelChoice({ model: context.native?.[field] });
  }
  if (defaults.model === undefined || defaults.model === '') {
    throw new SettingsError(`${selected.modelRef} has no configured model. Set its model or choose OpenCode fallback.`);
  }
  return { modelRef: selected.modelRef, model: defaults.model, variant: selected.variant ?? defaults.variant };
}

export function resolveChoice(agent: AgentSettings, groups: Groups, context: ResolutionContext = {}): EffectiveChoice {
  const memberships = agentGroups(agent, groups);
  const group =
    memberships.findLast(
      (name) =>
        Object.hasOwn(groups, name) && (groups[name].model !== undefined || groups[name].modelRef !== undefined),
    ) ?? memberships.at(-1);
  const metadata = agent.groups !== undefined || agent.options?.groups !== undefined ? { groups: memberships } : {};
  if (typeof agent.model === 'string' && agent.model !== '') {
    return { group, ...metadata, model: agent.model, variant: agent.variant, source: 'agent' };
  }
  const defaults: GroupChoice = {};
  for (const name of memberships) {
    if (!Object.hasOwn(groups, name)) {
      continue;
    }
    const next = resolveGroup(groups[name], context);
    if (next.model !== undefined) {
      defaults.model = next.model;
      defaults.modelRef = next.modelRef;
    }
    if (next.variant !== undefined) {
      defaults.variant = next.variant;
    }
  }
  if (defaults.model !== undefined && defaults.model !== '') {
    return {
      group,
      ...metadata,
      model: defaults.model,
      variant: agent.variant ?? defaults.variant,
      source: 'group',
      ...(defaults.modelRef !== undefined && defaults.modelRef !== '' ? { modelRef: defaults.modelRef } : {}),
    };
  }
  return { group, ...metadata, variant: agent.variant, source: 'native' };
}

export function applyDefaults(
  agents: Record<string, AgentSettings>,
  groups: Groups,
  context: ResolutionContext = {},
): void {
  // Validate every membership and reference before changing the loaded configuration.
  const choices = Object.entries(agents)
    .filter(([, agent]) => agent.disable !== true)
    .map(([name, agent]) => ({ name, choice: resolveChoice(agent, groups, context) }));
  for (const { name, choice } of choices) {
    if (choice.source !== 'group') {
      continue;
    }
    agents[name].model = choice.model;
    if (choice.variant !== undefined) {
      agents[name].variant = choice.variant;
    }
  }
}

export interface CatalogModel {
  id: string;
  name: string;
  provider: string;
  variants: Record<string, Record<string, unknown>>;
  parameterMetadata?: Record<string, unknown>;
}

export function catalogModels(providers: unknown): CatalogModel[] {
  if (!Array.isArray(providers)) {
    throw new SettingsError('The provider model list is unavailable. Try again.');
  }
  return providers
    .flatMap((provider) => {
      if (!record(provider) || typeof provider.id !== 'string' || !record(provider.models)) {
        return [];
      }
      const providerID = provider.id;
      const providerName = typeof provider.name === 'string' ? provider.name : providerID;
      return Object.entries(provider.models).flatMap(([id, model]) => {
        if (!record(model) || model.status === 'deprecated') {
          return [];
        }
        const variants = record(model.variants)
          ? Object.fromEntries(
              Object.entries(model.variants).filter(
                (entry): entry is [string, Record<string, unknown>] => record(entry[1]) && entry[1].disabled !== true,
              ),
            )
          : {};
        return [
          {
            id: `${providerID}/${id}`,
            name: typeof model.name === 'string' ? model.name : id,
            provider: providerName,
            variants,
            parameterMetadata: {
              ...(record(model.api) && typeof model.api.npm === 'string' ? { api: { npm: model.api.npm } } : {}),
              ...(record(model.capabilities) && typeof model.capabilities.temperature === 'boolean'
                ? { capabilities: { temperature: model.capabilities.temperature } }
                : {}),
              ...(record(model.limit) && typeof model.limit.output === 'number'
                ? { limit: { output: model.limit.output } }
                : {}),
            },
          },
        ];
      });
    })
    .sort((a, b) => {
      const providerOrder = a.provider.localeCompare(b.provider);
      return providerOrder !== 0 ? providerOrder : a.name.localeCompare(b.name);
    });
}

export function validateChoice(choice: ModelChoice, models: CatalogModel[]): CatalogModel | undefined {
  if (typeof choice.model !== 'string' || choice.model === '') {
    return undefined;
  }
  const model = models.find((item) => item.id === choice.model);
  if (model === undefined) {
    throw new SettingsError('That model is no longer available from the configured providers. Refresh the list.');
  }
  if (typeof choice.variant === 'string' && choice.variant !== '' && !Object.hasOwn(model.variants, choice.variant)) {
    throw new SettingsError('That variant is not available for the selected model.');
  }
  return model;
}
