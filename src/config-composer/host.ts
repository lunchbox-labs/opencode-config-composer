import type { AgentConfig, PermissionActionConfig, PermissionConfig } from '@opencode-ai/sdk/v2';

// Host tables taken from OpenCode v1.19.0. The @opencode-ai/sdk types of the same
// version check them at compile time, so an SDK update that changes them fails typechecking.

/** Keys a type declares, excluding its index signature. */
type Declared<T> = keyof { [K in keyof T as string extends K ? never : K]: unknown };
type PermissionRules = Exclude<PermissionConfig, PermissionActionConfig>;
type PermissionName = Declared<PermissionRules>;
type ActionOnlyPermission = {
  [K in PermissionName]-?: [Exclude<PermissionRules[K], undefined>] extends [PermissionActionConfig] ? K : never;
}[PermissionName];
/** Agent keys the host declares. Native moves any other agent key into options. */
export type AgentConfigKey = Declared<AgentConfig>;

/** Permission keys the host declares, in declaration order. Native lists them before other keys. */
export const permissionNames: readonly string[] = Object.keys({
  read: true,
  edit: true,
  glob: true,
  grep: true,
  list: true,
  bash: true,
  task: true,
  external_directory: true,
  todowrite: true,
  question: true,
  webfetch: true,
  websearch: true,
  lsp: true,
  doom_loop: true,
  skill: true,
} satisfies Record<PermissionName, true>);

/** Permissions the host accepts only as a single action, never as a pattern block. */
export const actionOnlyPermissions: ReadonlySet<string> = new Set(
  Object.keys({
    todowrite: true,
    question: true,
    webfetch: true,
    websearch: true,
    doom_loop: true,
  } satisfies Record<ActionOnlyPermission, true>),
);
