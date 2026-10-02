import type { AgentSettings, GroupOptions } from '../settings.ts';

export interface SourceDocument {
  id: string;
  path: string;
  text: string;
  fingerprint: string;
  writable: boolean;
  value: Record<string, unknown>;
}

export interface FieldOrigin {
  sourceId?: string;
  pointer: string;
  layer: string;
  operation: 'set' | 'merge' | 'unset' | 'native';
  references: string[];
  overwritten: FieldOrigin[];
}

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
