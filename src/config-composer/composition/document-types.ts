/** Public JSONC input contracts. Source loading and native compilation are separate phases. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Ordered contributions: a later matching rule wins, even when less restrictive. */
export interface PermissionRule {
  tool: string;
  pattern?: string;
  action: 'allow' | 'ask' | 'deny';
}

/** Structurally aligned with model-parameter dispatch; capability checks happen after catalog resolution. */
export interface ConfigurationParameters {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  options?: Record<string, JsonValue>;
}

export interface PromptConfiguration {
  prepend?: string[];
  append?: string[];
  inheritDefaults?: boolean;
  inheritGroups?: boolean;
}

export type ModelIdentity =
  { model: string; modelRef?: never } | { modelRef: string; model?: never } | { model?: never; modelRef?: never };

export type ConfigurationPreset = ModelIdentity & {
  variant?: string;
  parameters?: ConfigurationParameters;
  permissions?: PermissionRule[];
};

export type AgentConfiguration = ConfigurationPreset & { prompt?: PromptConfiguration };

export type AgentComponent = ({ file: string; prompt?: never } | { prompt: string; file?: never }) & {
  description?: string;
  mode?: 'primary' | 'subagent' | 'all';
  disable?: boolean;
  promptRefs?: string[];
  /** Intended on-demand relationships; neither inject skill bodies nor restrict access. */
  skills?: string[];
  configuration?: AgentConfiguration;
};

export interface SkillComponent {
  file: string;
}

export type CommandComponent = ({ file: string; template?: never } | { template: string; file?: never }) & {
  agent?: string;
  description?: string;
  subtask?: boolean;
};

export type PromptComponent = { file: string; text?: never } | { text: string; file?: never };

export interface Components {
  agents?: Record<string, AgentComponent>;
  skills?: Record<string, SkillComponent>;
  commands?: Record<string, CommandComponent>;
  prompts?: Record<string, PromptComponent>;
}

/** Any subset of component kinds is valid. Configuration applies to member agents. */
export interface ComponentGroup {
  agents?: string[];
  skills?: string[];
  commands?: string[];
  prompts?: string[];
  configuration?: AgentConfiguration;
}

export type PresetTarget =
  { agents: string[]; componentGroups?: string[] } | { agents?: string[]; componentGroups: string[] };

export type ProfileLayer =
  | { componentGroup: string; configurationPreset?: never; target?: never }
  | { configurationPreset: string; target: PresetTarget; componentGroup?: never };

export interface CompositionDefaults {
  model?: string;
  small_model?: string;
  agents?: AgentConfiguration;
}

export interface CompositionOverrides {
  model?: string;
  small_model?: string;
  agents?: Record<string, AgentConfiguration>;
}

export interface CompositionProfile {
  extends?: string;
  /** Replay parent layers before child layers; do not merge these arrays. */
  layers?: ProfileLayer[];
  overrides?: CompositionOverrides;
}

export interface CompositionDocument {
  $schema?: string;
  imports?: string[];
  sourceDirectories?: Record<string, string>;
  components?: Components;
  componentGroups?: Record<string, ComponentGroup>;
  configurationPresets?: Record<string, ConfigurationPreset>;
  profiles?: Record<string, CompositionProfile>;
  defaults?: CompositionDefaults;
  overrides?: CompositionOverrides;
  /** Absence inherits the shared selection; [] explicitly selects none. */
  activeProfiles?: string[];
}
