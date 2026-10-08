import { type AgentSettings, SettingsError, record } from '../settings.ts';
import {
  type PermissionRule as CompiledRule,
  PermissionCompilationError,
  type PermissionPolicy,
  compilePermissions,
  nativePermission,
  parsePermission,
} from './permissions.ts';
import type { FieldOrigin, PermissionRule } from './types.ts';
import type { PermissionContribution } from './runtime.ts';

export interface GlobalPermissionContribution {
  rule: PermissionRule;
  origin: FieldOrigin;
}
export interface PermissionWarning {
  scope: string;
  message: string;
}
interface Layer {
  policy: PermissionPolicy;
  origin: (rule?: CompiledRule, block?: boolean) => FieldOrigin;
}
const part = (value: string) => value.replaceAll('~', '~0').replaceAll('/', '~1');
function nativeOrigin(pointer: string): FieldOrigin {
  return { pointer, layer: 'native', operation: 'native', references: [], overwritten: [] };
}
function nativeLayer(value: unknown, pointer: string): Layer {
  let policy: PermissionPolicy;
  try {
    policy = nativePermission(value);
  } catch (error) {
    if (!(error instanceof SettingsError)) {
      throw error;
    }
    throw new PermissionCompilationError(`Unsupported native permission compilation: ${error.message}`);
  }
  return {
    policy,
    origin: (rule, block) =>
      nativeOrigin(
        rule === undefined || typeof value === 'string'
          ? pointer
          : `${pointer}/${part(rule.permission)}${block === true || rule.scalar ? '' : `/${part(rule.pattern)}`}`,
      ),
  };
}
function contributionLayer(item: GlobalPermissionContribution): Layer {
  const { tool, pattern, action } = item.rule;
  try {
    const policy = parsePermission(
      Object.fromEntries([[tool, pattern === undefined ? action : Object.fromEntries([[pattern, action]])]]),
    );
    return { policy, origin: () => item.origin };
  } catch (error) {
    if (!(error instanceof SettingsError)) {
      throw error;
    }
    throw new PermissionCompilationError(`Unsupported permission compilation: ${error.message}`);
  }
}

/** Compute origins before publishing replacements, so failed scopes retain native origins. */
function compile(layers: Layer[]): { policy: PermissionPolicy; origins: Record<string, FieldOrigin> } {
  const compiled = compilePermissions(layers.map((layer) => layer.policy));
  const origins: Record<string, FieldOrigin> = {};
  const at = (rule: CompiledRule, block = false) => layers[rule.layer].origin(rule, block);
  for (const layer of layers) {
    const previous = Object.hasOwn(origins, '') ? origins[''] : undefined;
    origins[''] = { ...layer.origin(), overwritten: previous === undefined ? [] : [previous] };
  }
  for (const block of compiled.blocks) {
    const pointer = `/${part(block.permission)}`;
    let previous: FieldOrigin | undefined;
    for (const rule of block.rules) {
      previous = { ...at(rule, true), overwritten: previous === undefined ? [] : [previous] };
    }
    if (previous !== undefined) {
      origins[pointer] = previous;
    }
    if (block.scalar) {
      continue;
    }
    for (const effective of block.effective) {
      let winner: FieldOrigin | undefined;
      for (const rule of compiled.rules.slice(0, compiled.rules.indexOf(effective) + 1)) {
        if (
          rule.pattern === effective.pattern &&
          (block.rules.includes(rule) || rule.permission === effective.permission)
        ) {
          winner = { ...at(rule), overwritten: winner === undefined ? [] : [winner] };
        }
      }
      if (winner !== undefined) {
        origins[`${pointer}/${part(effective.pattern)}`] = winner;
      }
    }
  }
  return { policy: compiled.policy, origins };
}
function retainNative(provenance: Record<string, FieldOrigin>, value: unknown, pointer: string): void {
  if (value === undefined) {
    return;
  }
  provenance[pointer] = nativeOrigin(pointer);
  if (record(value)) {
    for (const [key, child] of Object.entries(value)) {
      retainNative(provenance, child, `${pointer}/${part(key)}`);
    }
  }
}

export function resolvePermissions(
  nativeGlobal: unknown,
  agents: Record<string, AgentSettings>,
  global: readonly GlobalPermissionContribution[],
  contributions: readonly PermissionContribution[],
  provenance: Record<string, FieldOrigin>,
): { permission: unknown; permissionWarnings: PermissionWarning[] } {
  const warnings: PermissionWarning[] = [];
  retainNative(provenance, nativeGlobal, '/permission');
  let permission = nativeGlobal;
  function attempt(scope: string, locations: string[], operation: () => ReturnType<typeof compile>) {
    try {
      return operation();
    } catch (error) {
      if (!(error instanceof PermissionCompilationError)) {
        throw error;
      }
      const fallback =
        scope === 'global'
          ? 'The Composer global permission contribution was not applied; native global permissions remain. Independent agent policies still apply.'
          : 'All Composer permission contributions for this agent were not applied; native agent permissions and the successfully applied global policy remain.';
      warnings.push({
        scope,
        message: `${scope === 'global' ? 'Global scope' : `Agent ${scope.slice(6)}`}: ${error.message} Sources: ${locations.join(', ')}. ${fallback} Fallback may be more permissive, including missing intended deny rules. Other settings continue to apply.`,
      });
      return undefined;
    }
  }
  const locations = (items: readonly GlobalPermissionContribution[]) => [
    ...new Set(items.map((item) => `${item.origin.sourceId ?? 'native'}#${item.origin.pointer}`)),
  ];
  const publish = (pointer: string, origins: Record<string, FieldOrigin>) => {
    for (const key of Object.keys(provenance)) {
      if (key === pointer || key.startsWith(`${pointer}/`)) {
        Reflect.deleteProperty(provenance, key);
      }
    }
    for (const [suffix, origin] of Object.entries(origins)) {
      provenance[`${pointer}${suffix}`] = origin;
    }
  };
  if (global.length > 0) {
    const result = attempt('global', ['native /permission', ...locations(global)], () =>
      compile([nativeLayer(nativeGlobal, '/permission'), ...global.map(contributionLayer)]),
    );
    if (result !== undefined) {
      permission = result.policy;
      publish('/permission', result.origins);
    }
  }
  for (const [name, agent] of Object.entries(agents)) {
    const pointer = `/agent/${part(name)}/permission`;
    retainNative(provenance, agent.permission, pointer);
    const selected = contributions.filter((item) => item.agent === name);
    if (agent.disable === true || selected.length === 0) {
      continue;
    }
    const result = attempt(
      `agent:${name}`,
      ['effective global /permission', `native ${pointer}`, ...locations(selected)],
      () => {
        const globalLayer = nativeLayer(permission, '/permission');
        return compile([
          {
            ...globalLayer,
            origin: (rule, block) => {
              const at = globalLayer.origin(rule, block);
              return provenance[at.pointer] ?? at;
            },
          },
          nativeLayer(agent.permission, pointer),
          ...selected.map(contributionLayer),
        ]);
      },
    );
    if (result !== undefined) {
      agent.permission = result.policy;
      publish(pointer, result.origins);
    }
  }
  return { permission, permissionWarnings: warnings };
}
