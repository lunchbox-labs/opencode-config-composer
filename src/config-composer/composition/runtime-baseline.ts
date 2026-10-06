import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Config } from '@opencode-ai/plugin';
import type { Config as NativeConfig } from '@opencode-ai/sdk/v2';
import { configurationDirectory } from '../configuration.ts';
import { type AgentSettings, type NativeModels, SettingsError, record } from '../settings.ts';
import { serverEntry } from '../registration.ts';
import type { CompositionRevision } from './revision.ts';

const key = '__configComposerRuntime';

// OpenCode 1.18.34's /config response serializes known names in schema order.
// Unknown-name order and pattern-map order survive transport and remain semantic.
// Known-vs-wildcard ordering cannot be attested by /config alone; native evaluator
// fixtures verify that boundary, rather than rejecting healthy response serialization.
const permissionNames = [
  'read',
  'edit',
  'glob',
  'grep',
  'list',
  'bash',
  'task',
  'external_directory',
  'todowrite',
  'question',
  'webfetch',
  'websearch',
  'lsp',
  'doom_loop',
  'skill',
];
function permissionTransport(value: unknown): unknown {
  if (!record(value)) {
    return value;
  }
  return [
    ...permissionNames
      .filter((name) => Object.hasOwn(value, name))
      .map((name) => [name, record(value[name]) ? Object.entries(value[name]) : value[name]]),
    ...Object.entries(value)
      .filter(([name]) => !permissionNames.includes(name))
      .map(([name, policy]) => [name, record(policy) ? Object.entries(policy) : policy]),
  ];
}
function samePermission(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(permissionTransport(left), permissionTransport(right));
}
export interface RuntimeLocation {
  root: string;
  directory: string;
}
export interface EditorNativeBaseline extends NativeModels {
  agent?: Record<string, AgentSettings>;
}

/** Native inputs inside the marker are opaque metadata, so their full order survives transport. */
export function sameNativePermissionOrder(left: EditorNativeBaseline, right: EditorNativeBaseline): boolean {
  return (
    JSON.stringify(left.permission) === JSON.stringify(right.permission) &&
    [...new Set([...Object.keys(left.agent ?? {}), ...Object.keys(right.agent ?? {})])].every(
      (name) => JSON.stringify(left.agent?.[name].permission) === JSON.stringify(right.agent?.[name].permission),
    )
  );
}
const globals = (value: NativeModels) => ({
  model: typeof value.model === 'string' ? value.model : null,
  small_model: typeof value.small_model === 'string' ? value.small_model : null,
  permission: structuredClone(value.permission ?? null),
});

/** Publish only into a copied effective-config registration, never the authored options or source array. */
export function publishRuntimeBaseline(
  config: Config & Pick<NativeConfig, 'skills'>,
  options: Record<string, unknown>,
  location: RuntimeLocation,
  native: NativeModels,
  agent: Record<string, AgentSettings> = {},
  state?: { revision?: CompositionRevision; observedNativeFiles: string },
): void {
  const plugins = config.plugin ?? [];
  const matches = plugins.flatMap((entry, index) =>
    (Array.isArray(entry) && entry[1] === options) ||
    serverEntry(Array.isArray(entry) ? entry[0] : entry, configurationDirectory())
      ? [index]
      : [],
  );
  // A manually invoked hook need not have a registration. Exact editor previews require the published marker.
  if (matches.length !== 1) {
    return;
  }
  const index = matches[0];
  const entry = plugins[index];
  const spec = Array.isArray(entry) ? entry[0] : entry;
  const original = Array.isArray(entry) ? entry[1] : {};
  const next = [...plugins];
  next[index] = [
    spec,
    {
      ...original,
      [key]: {
        version: 1,
        id: randomUUID(),
        root: resolve(location.root),
        directory: resolve(location.directory),
        native: globals(native),
        applied: globals(config),
        agent: structuredClone(agent),
        appliedAgents: structuredClone(config.agent ?? {}),
        ...(state === undefined
          ? {}
          : {
              ...state,
              appliedCommands: structuredClone(config.command ?? {}),
              appliedSkillPaths: [...(config.skills?.paths ?? [])],
            }),
      },
    },
  ];
  config.plugin = next;
}

export function readRuntimeBaseline(
  config: unknown,
  location: RuntimeLocation,
  registrationRoot = configurationDirectory(),
): EditorNativeBaseline {
  const fail = (detail: string): never => {
    throw new SettingsError(
      `${detail} Exact native baseline is unavailable. Reload the matching Config Composer server plugin and reopen the editor.`,
    );
  };
  if (!record(config) || !Array.isArray(config.plugin)) {
    return fail('The server did not publish its composition baseline.');
  }
  const markers: unknown[] = config.plugin.flatMap((entry: unknown) =>
    Array.isArray(entry) && serverEntry(entry[0], registrationRoot) && record(entry[1]) && Object.hasOwn(entry[1], key)
      ? [entry[1][key]]
      : [],
  );
  const marker = markers[0];
  if (markers.length !== 1 || !record(marker) || marker.version !== 1 || typeof marker.id !== 'string') {
    return fail('The runtime baseline version is missing or ambiguous.');
  }
  if (marker.root !== resolve(location.root) || marker.directory !== resolve(location.directory)) {
    return fail('The runtime baseline belongs to another workspace or directory.');
  }
  const validGlobals = (
    value: unknown,
  ): value is { model: string | null; small_model: string | null; permission?: unknown } =>
    record(value) && [value.model, value.small_model].every((value) => value === null || typeof value === 'string');
  if (
    !validGlobals(marker.native) ||
    !validGlobals(marker.applied) ||
    !record(marker.agent) ||
    !Object.values(marker.agent).every(record)
  ) {
    return fail('The server returned invalid baseline metadata.');
  }
  const applied = {
    model: typeof config.model === 'string' ? config.model : null,
    small_model: typeof config.small_model === 'string' ? config.small_model : null,
  };
  if (marker.applied.model !== applied.model || marker.applied.small_model !== applied.small_model) {
    return fail('Global models changed after Composer applied its configuration.');
  }
  if (!samePermission(marker.applied.permission ?? null, config.permission ?? null)) {
    return fail('Global permissions changed after Composer applied its configuration.');
  }
  if (!isDeepStrictEqual(marker.appliedAgents, config.agent ?? {})) {
    return fail('Agent settings changed after Composer applied its configuration.');
  }
  if (record(config.agent) && record(marker.appliedAgents)) {
    for (const [name, agent] of Object.entries(config.agent)) {
      const appliedAgent = marker.appliedAgents[name];
      if (record(agent) && record(appliedAgent) && !samePermission(agent.permission, appliedAgent.permission)) {
        return fail('Agent permission order changed after Composer applied its configuration.');
      }
    }
  }
  return {
    ...(marker.native.permission === null || marker.native.permission === undefined
      ? {}
      : { permission: structuredClone(marker.native.permission) }),
    ...(marker.native.model === null ? {} : { model: marker.native.model }),
    ...(marker.native.small_model === null ? {} : { small_model: marker.native.small_model }),
    agent: Object.fromEntries(
      Object.entries(marker.agent).map(([name, settings]) => {
        if (!record(settings)) {
          return fail('The server returned invalid native agent metadata.');
        }
        return [name, structuredClone(settings)];
      }),
    ),
  };
}

export function readRuntimeRevision(
  config: unknown,
  location: RuntimeLocation,
  registrationRoot = configurationDirectory(),
): { id: string; revision?: CompositionRevision; observedNativeFiles: string } {
  readRuntimeBaseline(config, location, registrationRoot);
  if (!record(config) || !Array.isArray(config.plugin)) {
    throw new SettingsError('The server did not publish an applied revision. Restart the matching plugin.');
  }
  const marker: unknown = config.plugin.flatMap((entry: unknown) =>
    Array.isArray(entry) && serverEntry(entry[0], registrationRoot) && record(entry[1]) && record(entry[1][key])
      ? [entry[1][key]]
      : [],
  )[0];
  const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (!record(marker) || typeof marker.id !== 'string' || !hash(marker.observedNativeFiles)) {
    throw new SettingsError('The running plugin cannot attest applied revisions. Restart the matching plugin.');
  }
  if (!isDeepStrictEqual(marker.appliedCommands, config.command ?? {})) {
    throw new SettingsError(
      'Commands changed after composition. Reopen the apply view after resolving other plugin changes.',
    );
  }
  const skills = record(config.skills) ? config.skills : {};
  if (!isDeepStrictEqual(marker.appliedSkillPaths, skills.paths ?? [])) {
    throw new SettingsError(
      'Skill paths changed after composition. Reopen the apply view after resolving other plugin changes.',
    );
  }
  let revision: CompositionRevision | undefined;
  if (marker.revision !== undefined) {
    if (!record(marker.revision) || !hash(marker.revision.sources) || !hash(marker.revision.effective)) {
      throw new SettingsError('The server returned an invalid applied revision. Restart the matching plugin.');
    }
    revision = { sources: marker.revision.sources, effective: marker.revision.effective };
  }
  return {
    id: marker.id,
    observedNativeFiles: marker.observedNativeFiles,
    ...(revision === undefined ? {} : { revision }),
  };
}
