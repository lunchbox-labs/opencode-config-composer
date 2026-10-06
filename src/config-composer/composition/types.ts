import type { AgentSettings, GroupOptions } from '../settings.ts';
import type { CompositionDocument, PermissionRule } from './document-types.ts';

export type {
  AgentComponent,
  AgentConfiguration,
  CommandComponent,
  ComponentGroup,
  Components,
  CompositionDefaults,
  CompositionDocument,
  CompositionOverrides,
  CompositionProfile,
  ConfigurationParameters,
  ConfigurationPreset,
  JsonValue,
  ModelIdentity,
  PermissionRule,
  PresetTarget,
  ProfileLayer,
  PromptComponent,
  PromptConfiguration,
  SkillComponent,
} from './document-types.ts';

export interface SourceDocument {
  id: string;
  path: string;
  text: string;
  fingerprint: string;
  writable: boolean;
  value: Record<string, unknown>;
}

/** A structurally validated document; cross-document references remain unresolved. */
export interface CompositionSourceDocument extends Omit<SourceDocument, 'value'> {
  value: CompositionDocument;
}

export interface FieldOrigin {
  sourceId?: string;
  pointer: string;
  layer: string;
  operation: 'set' | 'merge' | 'unset' | 'native';
  references: string[];
  overwritten: FieldOrigin[];
}

/** Configured Composer matches only; a nonmatch defers without inventing an action or origin. */
export type ConfiguredPermissionPreview =
  | {
      action: PermissionRule['action'];
      matched: { permission: string; pattern: string };
      origin?: FieldOrigin;
      fallback?: never;
    }
  | { fallback: 'native'; action?: never; matched?: never; origin?: never };

export interface NativeInput {
  model?: string;
  small_model?: string;
  default_agent?: string;
  permission?: unknown;
  agent?: Record<string, AgentSettings>;
}

export interface ResolvedComposition {
  settings: GroupOptions;
  model?: string;
  small_model?: string;
  default_agent?: string;
  sources: SourceDocument[];
  provenance: Record<string, FieldOrigin>;
  revision: string;
}

export interface CompositionDiagnostic {
  code: string;
  message: string;
  sourceId?: string;
  pointer?: string;
}
