import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';
import type { Plugin, PluginModule } from '@opencode-ai/plugin';
import { configurationDirectory } from './configuration-directory.ts';
import { bundledSkillDirectory, validateBundledSkills } from './bundled-skills.ts';
import { SettingsError, record } from './settings.ts';
import { nativeAgentSettings } from './membership.ts';
import { type LoadedSource, loadSource, pluginOptions } from './composition/sources.ts';
import { resolveComposition } from './composition/runtime.ts';
import { applyModelParameters } from './composition/model-parameters.ts';
import { type RuntimeMarker, configFields, metadata, publishRuntime } from './composition/runtime-baseline.ts';
import {
  type NativeObservation,
  compositionRevision,
  discoveryContext,
  nativeGlobalJsonPaths,
  observeNative,
} from './composition/revision.ts';
import {
  type SelectionEnvironment,
  type SelectionLocator,
  publishSelectionProof,
  readSelectionAt,
  selectionLifetime,
  selectionLocator,
  selectionStateDirectory,
  verifySelection,
} from './composition/selection-state.ts';
import type { NativeAuthority, NativeBaseline, ResolvedCandidate } from './composition/document-types.ts';
interface Previous {
  native: Record<string, unknown>;
  applied: Record<string, unknown>;
}
// Native global JSON is cached for the server process. Rebootstrap must never
// promote changed disk bytes to evidence that the native cache was refreshed.
interface Definition {
  id: string;
  selectionEnvironment: SelectionEnvironment;
  source?: LoadedSource;
  selectionLocator?: SelectionLocator;
  error?: string;
}
interface Startup {
  definitions: Map<string, Promise<Definition>>;
  globalBaselines: Map<string, string>;
}
function startup(): Startup {
  const key = Symbol.for('@lunchbox-labs/config-composer/startup-definitions');
  const existing: unknown = Reflect.get(globalThis, key);
  if (existing !== undefined) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- This process-private symbol is shared by duplicate module evaluations.
    return existing as Startup;
  }
  const value: Startup = { definitions: new Map(), globalBaselines: new Map() };
  Reflect.set(globalThis, key, value);
  return value;
}
async function definition(directory: string, worktree: string, rawOptions: unknown): Promise<Definition> {
  const registry = startup().definitions;
  const key = JSON.stringify([directory, worktree]);
  let captured = registry.get(key);
  if (captured === undefined) {
    captured = (async () => {
      const value: Definition = {
        id: randomUUID(),
        selectionEnvironment: { stateDirectory: selectionStateDirectory(), lifetime: selectionLifetime() },
      };
      try {
        const options = pluginOptions(rawOptions);
        const configDirectory = configurationDirectory();
        value.source = await loadSource(options, configDirectory);
        value.selectionLocator = await selectionLocator(value.selectionEnvironment, {
          root: worktree,
          baseFile: value.source.canonicalPath,
        });
      } catch (error) {
        value.error = error instanceof Error ? error.message : String(error);
      }
      return value;
    })();
    // Cache the first promise, including failures, before any concurrent initialization can enter.
    registry.set(key, captured);
  }
  return structuredClone(await captured);
}
const roots = new WeakMap<object, Previous>();
const nested = new WeakMap<object, Previous>();
function restore(
  value: Record<string, unknown>,
  previous: Previous | undefined,
  keys: readonly string[],
): Record<string, unknown> {
  const result = { ...value };
  if (previous !== undefined) {
    for (const key of keys) {
      if (isDeepStrictEqual(value[key], previous.applied[key])) {
        if (Object.hasOwn(previous.native, key)) {
          Object.defineProperty(result, key, {
            value: structuredClone(previous.native[key]),
            enumerable: true,
            writable: true,
            configurable: true,
          });
        } else {
          Reflect.deleteProperty(result, key);
        }
      }
    }
  }
  return result;
}
const ConfigComposerPlugin: Plugin = async (input, rawOptions = {}) => {
  const directory = resolve(typeof input.directory === 'string' ? input.directory : process.cwd());
  const worktree = resolve(
    typeof input.worktree === 'string' && input.worktree !== '' && input.worktree !== '/' ? input.worktree : directory,
  );
  const location = { root: worktree, directory };
  const loaded = await definition(directory, worktree, rawOptions);
  const { selectionEnvironment } = loaded;
  await publishSelectionProof(selectionEnvironment);
  await validateBundledSkills();
  let parameters: { candidate: ResolvedCandidate; authority: NativeAuthority } | undefined;
  return {
    'chat.params': (request, output) => {
      applyModelParameters(parameters?.candidate, parameters?.authority ?? {}, request, output);
      return Promise.resolve();
    },
    config: async (config) => {
      parameters = undefined;
      const target = config as Record<string, unknown>;
      // Package help remains available when a composition needs repair.
      const skills = record(target.skills) ? target.skills : {};
      target.skills = {
        ...skills,
        paths: [
          ...new Set([
            ...(Array.isArray(skills.paths)
              ? skills.paths.filter((path: unknown): path is string => typeof path === 'string')
              : []),
            bundledSkillDirectory,
          ]),
        ],
      };
      let native: NativeBaseline | undefined;
      let observation: NativeObservation | undefined;
      let globalJsonBaseline: string | undefined;
      const identities: Pick<RuntimeMarker, 'definitionId' | 'source' | 'selectionLocator' | 'selection'> = {
        definitionId: loaded.id,
        source: loaded.source,
        selectionLocator: loaded.selectionLocator,
      };
      try {
        const previous = roots.get(config);
        const restored = restore(
          Object.fromEntries(
            ['model', 'small_model', 'default_agent', 'permission', 'agent', 'command']
              .filter((key) => Object.hasOwn(target, key))
              .map((key) => [key, target[key]]),
          ),
          previous,
          ['model', 'small_model', 'agent', 'command'],
        );
        for (const kind of ['agent', 'command'] as const) {
          if (restored[kind] !== undefined && !record(restored[kind])) {
            throw new SettingsError(`Invalid native ${kind} configuration.`);
          }
          if (record(restored[kind])) {
            restored[kind] = Object.fromEntries(
              Object.entries(restored[kind]).map(([name, value]) => {
                if (!record(value)) {
                  throw new SettingsError(`Invalid native ${kind} ${name}.`);
                }
                return [
                  name,
                  restore(
                    value,
                    nested.get(value),
                    kind === 'agent'
                      ? ['groups', 'model', 'variant', 'temperature', 'top_p', 'options', 'mode', 'permission']
                      : ['agent', 'model', 'subtask'],
                  ),
                ];
              }),
            );
          }
        }
        native = restored;
        observation = await observeNative(
          discoveryContext(directory, typeof input.worktree === 'string' ? input.worktree : worktree),
        );
        const globalKey = nativeGlobalJsonPaths(observation.context)[0];
        const globalBaselines = startup().globalBaselines;
        globalJsonBaseline = globalBaselines.get(globalKey) ?? observation.globalJson;
        globalBaselines.set(globalKey, globalJsonBaseline);
        if (loaded.error !== undefined || loaded.source === undefined || loaded.selectionLocator === undefined) {
          throw new SettingsError(
            `${loaded.error ?? 'Incomplete startup definition.'} Restart the OpenCode server process after correcting the configuration.`,
          );
        }
        const source = loaded.source;
        const selection = await readSelectionAt(selectionEnvironment, loaded.selectionLocator);
        identities.selection = {
          path: selection.path,
          choice: selection.choice,
          revision: selection.revision,
          identity: selection.identity,
        };
        const candidate = resolveComposition(source.document, selection.choice, native, observation.authority);
        const revision = compositionRevision(source, selection, candidate);
        await verifySelection(selection);
        const after = await observeNative(observation.context);
        if (!isDeepStrictEqual(after, observation)) {
          throw new SettingsError('Native inputs changed. Restart the OpenCode server process, then review again.');
        }
        // The complete candidate and all observed inputs are valid before any managed mutation.
        for (const field of ['model', 'small_model'] as const) {
          if (Object.hasOwn(candidate, field)) {
            target[field] = candidate[field];
          } else {
            Reflect.deleteProperty(target, field);
          }
        }
        for (const kind of ['agent', 'command'] as const) {
          const applied = structuredClone(candidate[kind]);
          target[kind] = applied;
          for (const [name, value] of Object.entries(applied)) {
            nested.set(value, { native: structuredClone(native[kind]?.[name] ?? {}), applied: structuredClone(value) });
          }
        }
        roots.set(config, {
          native: structuredClone(native),
          applied: configFields(target),
        });
        publishRuntime(target, rawOptions, {
          location,
          selectionEnvironment,
          ...identities,
          status: 'applied',
          native: metadata(native),
          observation,
          globalJsonBaseline,
          revision,
          candidate: { ...candidate, ...metadata(candidate) },
        });
        parameters = { candidate, authority: observation.authority };
      } catch (error) {
        // Native may continue after a failed config hook. Strip membership on
        // fresh copies, and retain its original authority for repeated hooks.
        const failedNative = native ?? configFields(target);
        if (record(target.agent)) {
          target.agent = Object.fromEntries(
            Object.entries(target.agent).map(([name, agent]) => {
              if (!record(agent)) {
                return [name, agent];
              }
              const applied = structuredClone(nativeAgentSettings(agent));
              nested.set(applied, {
                native: structuredClone(failedNative.agent?.[name] ?? agent),
                applied: structuredClone(applied),
              });
              return [name, applied];
            }),
          );
        }
        roots.set(config, { native: structuredClone(failedNative), applied: configFields(target) });
        publishRuntime(target, rawOptions, {
          location,
          selectionEnvironment,
          ...identities,
          status: 'error',
          diagnostic: `Composer not applied. ${error instanceof Error ? error.message : String(error)}`,
          ...(native === undefined ? {} : { native: metadata(native) }),
          ...(observation === undefined ? {} : { observation }),
          ...(globalJsonBaseline === undefined ? {} : { globalJsonBaseline }),
        });
        throw error;
      }
    },
  };
};
export default { id: 'config-composer', server: ConfigComposerPlugin } satisfies PluginModule;
