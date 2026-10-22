import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { RestartRequiredError, SettingsError, record } from '../settings.ts';
import { serverEntry } from '../registration.ts';
import { configurationDirectory } from '../configuration.ts';
import type { NativeBaseline, ResolvedCandidate } from './document-types.ts';
import type { CompositionRevision, NativeObservation } from './revision.ts';
import { builtins } from './runtime.ts';
import type { SelectionEnvironment } from './selection-state.ts';
export interface RuntimeLocation {
  root: string;
  directory: string;
}
export interface RuntimeMarker {
  version: 2;
  id: string;
  location: RuntimeLocation;
  configurationDirectory: string;
  options: { configFile?: string };
  status: 'applied' | 'error';
  builtins: typeof builtins;
  source?: { path: string; canonicalPath: string; fingerprint: string };
  selection?: { path: string; choice?: string | null; revision: number; identity?: string };
  diagnostic?: string;
  native?: NativeBaseline;
  observation?: NativeObservation;
  globalJsonBaseline?: string;
  selectionEnvironment: SelectionEnvironment;
  revision?: CompositionRevision;
  candidate?: ResolvedCandidate;
  applied: NativeBaseline;
}
export interface AttestedRuntime extends RuntimeMarker {
  native: NativeBaseline;
  observation: NativeObservation;
}
const key = '__configComposerRuntime';
/** Body ownership remains native. Attest metadata only, including unmanaged native fields. */
export function metadata(config: NativeBaseline): NativeBaseline {
  const result = structuredClone(config);
  for (const kind of ['agent', 'command'] as const) {
    if (result[kind] !== undefined) {
      result[kind] = Object.fromEntries(
        Object.entries(result[kind]).map(([name, item]) => [
          name,
          Object.fromEntries(
            Object.entries(item).filter(([field]) => field !== (kind === 'agent' ? 'prompt' : 'template')),
          ),
        ]),
      );
    }
  }
  return result;
}
export function configFields(config: Record<string, unknown>): NativeBaseline {
  return Object.fromEntries(
    ['model', 'small_model', 'default_agent', 'permission', 'agent', 'command']
      .filter((key) => Object.hasOwn(config, key))
      .map((key) => [key, structuredClone(config[key])]),
  );
}
export function publishRuntime(
  config: Record<string, unknown>,
  options: Record<string, unknown>,
  value: Omit<RuntimeMarker, 'version' | 'id' | 'applied' | 'builtins'>,
): RuntimeMarker {
  const valueWithMetadata: RuntimeMarker = {
    ...value,
    version: 2,
    id: randomUUID(),
    builtins,
    applied: metadata(configFields(config)),
  };
  // Native validates plugin options as JSON before serializing /config. Omit optional
  // undefined metadata at this boundary, including nested selection/observation fields.
  const json: unknown = JSON.parse(JSON.stringify(valueWithMetadata));
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON serialization preserves the required typed fields and removes only absent optional metadata.
  const marker = json as RuntimeMarker;
  const plugins: unknown[] = Array.isArray(config.plugin) ? config.plugin : [];
  const index = plugins.findIndex(
    (entry: unknown) =>
      (Array.isArray(entry) && entry[1] === options) ||
      serverEntry(Array.isArray(entry) ? entry[0] : entry, configurationDirectory()),
  );
  if (index >= 0) {
    const entry = plugins[index];
    const next = [...plugins];
    next[index] = [
      Array.isArray(entry) ? entry[0] : entry,
      { ...(Array.isArray(entry) && record(entry[1]) ? entry[1] : {}), [key]: marker },
    ];
    config.plugin = next;
  }
  return marker;
}
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
      .filter((key) => Object.hasOwn(value, key))
      .map((key) => [key, record(value[key]) ? Object.entries(value[key]) : value[key]]),
    ...Object.entries(value)
      .filter(([key]) => !permissionNames.includes(key))
      .map(([key, policy]) => [key, record(policy) ? Object.entries(policy) : policy]),
  ];
}
function transport(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(transport);
  }
  if (!record(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, key === 'permission' ? permissionTransport(value) : transport(value)]),
  );
}
export function readRuntimeContext(config: unknown, location: RuntimeLocation): AttestedRuntime {
  const fail = (text: string): never => {
    throw new SettingsError(
      `${text} Exact native authority is unavailable. Restart OpenCode and reopen Config Composer.`,
    );
  };
  if (!record(config) || !Array.isArray(config.plugin)) {
    return fail('No runtime marker.');
  }
  const marker: unknown = config.plugin.flatMap((entry: unknown) =>
    Array.isArray(entry) && record(entry[1]) && Object.hasOwn(entry[1], key) ? [entry[1][key]] : [],
  )[0];
  if (marker === undefined) {
    return fail('No runtime marker.');
  }
  if (!record(marker) || marker.version !== 2 || typeof marker.id !== 'string' || !record(marker.location)) {
    return fail('Unreadable runtime marker.');
  }
  if (marker.location.root !== resolve(location.root) || marker.location.directory !== resolve(location.directory)) {
    return fail('Runtime belongs to another location.');
  }
  if (!record(marker.native) || !record(marker.observation) || !record(marker.selectionEnvironment)) {
    return fail(typeof marker.diagnostic === 'string' ? marker.diagnostic : 'Incomplete server attestation.');
  }
  if (!isDeepStrictEqual(transport(marker.applied), transport(metadata(configFields(config))))) {
    return fail('Configuration changed after Composer.');
  }
  const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (
    typeof marker.configurationDirectory !== 'string' ||
    !record(marker.options) ||
    (Object.hasOwn(marker.options, 'configFile') && typeof marker.options.configFile !== 'string') ||
    !['applied', 'error'].includes(String(marker.status)) ||
    typeof marker.selectionEnvironment.stateDirectory !== 'string' ||
    typeof marker.selectionEnvironment.lifetime !== 'string' ||
    !hash(marker.observation.metadata) ||
    !hash(marker.observation.json) ||
    !hash(marker.observation.globalJson) ||
    !hash(marker.observation.commands) ||
    !record(marker.observation.authority) ||
    !record(marker.observation.context) ||
    typeof marker.observation.context.directory !== 'string' ||
    typeof marker.observation.context.worktree !== 'string'
  ) {
    return fail('Invalid server attestation.');
  }
  for (const kind of ['agent', 'command']) {
    if (
      Object.hasOwn(marker.native, kind) &&
      (!record(marker.native[kind]) || !Object.values(marker.native[kind]).every(record))
    ) {
      return fail('Invalid native targets.');
    }
  }
  for (const entry of Object.values(marker.observation.authority)) {
    if (!record(entry) || !record(entry.fields) || !Array.isArray(entry.sources)) {
      return fail('Invalid authored authority.');
    }
    for (const pin of Object.values(entry.fields)) {
      if (
        !record(pin) ||
        !Object.hasOwn(pin, 'value') ||
        !record(pin.authored) ||
        !record(pin.source) ||
        typeof pin.source.path !== 'string' ||
        typeof pin.source.canonicalPath !== 'string' ||
        !hash(pin.source.fingerprint)
      ) {
        return fail('Invalid authored field.');
      }
    }
  }
  if (
    marker.status === 'applied' &&
    (!record(marker.revision) || !hash(marker.revision.sources) || !hash(marker.revision.effective))
  ) {
    return fail('Missing successful revision.');
  }
  if (marker.status === 'error' && Object.hasOwn(marker, 'revision')) {
    return fail('Error marker claims an applied revision.');
  }
  if (marker.globalJsonBaseline === undefined) {
    throw new RestartRequiredError(
      'Native global cache baseline is unavailable. Restart the OpenCode server process, then review again.',
    );
  }
  if (!hash(marker.globalJsonBaseline)) {
    return fail('Invalid server attestation.');
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Runtime, target, field and authority shape checks above establish this internal transport boundary.
  return structuredClone(marker) as unknown as AttestedRuntime;
}
