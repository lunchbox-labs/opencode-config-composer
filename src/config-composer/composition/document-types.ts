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

export type ModelIdentity =
  { model: string; modelRef?: never } | { modelRef: string; model?: never } | { model?: never; modelRef?: never };

export type ConfigurationPreset = ModelIdentity & {
  variant?: string;
  parameters?: ConfigurationParameters;
  permissions?: PermissionRule[];
};

export type AgentConfiguration = ConfigurationPreset;

export type AgentComponent = ({ file: string; prompt?: never } | { prompt: string; file?: never }) & {
  description?: string;
  mode?: 'primary' | 'subagent' | 'all';
  disable?: boolean;
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

export interface Components {
  agents?: Record<string, AgentComponent>;
  skills?: Record<string, SkillComponent>;
  commands?: Record<string, CommandComponent>;
}

/** Any subset of component kinds is valid. Agent names resolve against native and custom agents. */
export interface ComponentGroup {
  agents?: string[];
  skills?: string[];
  commands?: string[];
  configuration?: AgentConfiguration;
}

export type PresetTarget =
  { agents: string[]; componentGroups?: string[] } | { agents?: string[]; componentGroups: string[] };

export type ProfileLayer =
  | { componentGroup: string; configurationPreset?: never; target?: never }
  | { configurationPreset: string; target: PresetTarget; componentGroup?: never };

export interface CompositionDefaults {
  permissions?: PermissionRule[];
  model?: string;
  small_model?: string;
  agents?: AgentConfiguration;
}

export interface CompositionOverrides {
  permissions?: PermissionRule[];
  model?: string;
  small_model?: string;
  agents?: Record<string, AgentConfiguration>;
}

export interface CompositionProfile {
  extends?: string;
  /** Later profile occurrences replace earlier decisions; absence inherits earlier/native availability. */
  agentAvailability?: Record<string, boolean>;
  /** Replay parent layers before child layers; do not merge these arrays. */
  layers?: ProfileLayer[];
  overrides?: CompositionOverrides;
}

export interface ProfileShortcut {
  activeProfiles: string[];
  description?: string;
}

export interface SelectionPolicy {
  defaultProfiles?: string[];
  retainOnRestart?: boolean;
}

export interface CompositionDocument {
  selection?: SelectionPolicy;
  $schema?: string;
  imports?: string[];
  components?: Components;
  componentGroups?: Record<string, ComponentGroup>;
  configurationPresets?: Record<string, ConfigurationPreset>;
  profiles?: Record<string, CompositionProfile>;
  profileShortcuts?: Record<string, ProfileShortcut>;
  defaults?: CompositionDefaults;
  overrides?: CompositionOverrides;
  /** Absence inherits the shared selection; [] explicitly selects none. */
  activeProfiles?: string[];
}
