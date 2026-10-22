import type { NativeAgentFrontmatter } from '../frontmatter.ts';
export type Selection = string | null | undefined;
export type Action = 'allow' | 'ask' | 'deny';
export type Permission = Action | Record<string, Action | Record<string, Action>>;
export interface AgentPatch extends Record<string, unknown> {
  model?: string;
  variant?: string;
  temperature?: number;
  top_p?: number;
  options?: Record<string, unknown>;
  mode?: 'primary' | 'subagent' | 'all';
  permission?: Permission;
}
export interface CommandPatch extends Record<string, unknown> {
  agent?: string;
  model?: string;
  subtask?: boolean;
}
export interface GroupPatch {
  name: string;
  agent?: AgentPatch;
}
export interface Group extends GroupPatch {
  description?: string;
}
export interface Profile {
  description?: string;
  model?: string;
  small_model?: string;
  groups?: GroupPatch[];
  agent?: Record<string, AgentPatch>;
  command?: Record<string, CommandPatch>;
}
export interface CompositionDocument {
  $schema?: string;
  defaultProfile?: string;
  model?: string;
  small_model?: string;
  groups: Group[];
  agent?: Record<string, AgentPatch>;
  command?: Record<string, CommandPatch>;
  profiles: Record<string, Profile>;
}
export interface NativeBaseline extends Record<string, unknown> {
  model?: string;
  small_model?: string;
  default_agent?: string;
  permission?: unknown;
  agent?: Record<string, Record<string, unknown>>;
  command?: Record<string, Record<string, unknown>>;
}
export type NativeAuthority = Record<string, NativeAgentFrontmatter>;
export interface Origin {
  kind: 'group' | 'native' | 'root' | 'profile-group' | 'profile' | 'frontmatter';
  pointer?: string;
  source?: string;
}
export interface FieldDecision {
  value: unknown;
  origin: Origin;
  blockedComposer?: { value: unknown; origin: Origin };
}
export interface GroupMembership {
  groups: string[];
  origin: Origin;
}
export interface ResolvedCandidate extends NativeBaseline {
  memberships: Partial<Record<string, GroupMembership>>;
  profile: string | null;
  agent: Record<string, Record<string, unknown>>;
  command: Record<string, Record<string, unknown>>;
  decisions: Record<string, FieldDecision>;
}
