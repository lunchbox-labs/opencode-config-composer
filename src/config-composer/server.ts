import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';
import type { Plugin, PluginModule } from '@opencode-ai/plugin';
import { configurationDirectory } from './configuration.ts';
import { bundledSkillDirectory, validateBundledSkills } from './bundled-skills.ts';
import { SettingsError, record } from './settings.ts';
import { loadSource, pluginOptions } from './composition/sources.ts';
import { resolveComposition } from './composition/runtime.ts';
import { type RuntimeMarker, configFields, metadata, publishRuntime } from './composition/runtime-baseline.ts';
import {
  type NativeObservation,
  compositionRevision,
  digest,
  discoveryContext,
  observeNative,
} from './composition/revision.ts';
import {
  publishSelectionProof,
  readSelection,
  selectionLifetime,
  selectionStateDirectory,
  verifySelection,
} from './composition/selection-state.ts';
import type { NativeBaseline } from './composition/document-types.ts';
interface Previous {
  native: Record<string, unknown>;
  applied: Record<string, unknown>;
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
  const options = pluginOptions(rawOptions);
  const directory = resolve(typeof input.directory === 'string' ? input.directory : process.cwd());
  const worktree = resolve(
    typeof input.worktree === 'string' && input.worktree !== '' && input.worktree !== '/' ? input.worktree : directory,
  );
  const location = { root: worktree, directory };
  const configDirectory = configurationDirectory();
  const selectionEnvironment = { stateDirectory: selectionStateDirectory(), lifetime: selectionLifetime() };
  await publishSelectionProof(selectionEnvironment);
  await validateBundledSkills();
  return {
    config: async (config) => {
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
      const identities: Pick<RuntimeMarker, 'source' | 'selection'> = {};
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
                      ? ['model', 'variant', 'temperature', 'top_p', 'options', 'mode', 'permission']
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
        const source = await loadSource(options, configDirectory);
        identities.source = {
          path: source.path,
          canonicalPath: source.canonicalPath,
          fingerprint: digest(source.text ?? null),
        };
        const selection = await readSelection(selectionEnvironment, { root: worktree, baseFile: source.canonicalPath });
        identities.selection = {
          path: selection.path,
          choice: selection.choice,
          revision: selection.revision,
          identity: selection.identity,
        };
        const candidate = resolveComposition(source.document, selection.choice, native, observation.authority);
        const revision = compositionRevision(source, selection, candidate);
        const checked = await loadSource(options, configDirectory);
        if (
          checked.identity !== source.identity ||
          checked.text !== source.text ||
          checked.canonicalPath !== source.canonicalPath
        ) {
          throw new SettingsError('Composition source changed while loading.');
        }
        await verifySelection(selection);
        const after = await observeNative(observation.context);
        if (!isDeepStrictEqual(after, observation)) {
          throw new SettingsError('Native agent metadata changed. Restart OpenCode, then review again.');
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
          configurationDirectory: configDirectory,
          options,
          selectionEnvironment,
          ...identities,
          status: 'applied',
          native: metadata(native),
          observation,
          revision,
          candidate: { ...candidate, ...metadata(candidate) },
        });
      } catch (error) {
        publishRuntime(target, rawOptions, {
          location,
          configurationDirectory: configDirectory,
          options,
          selectionEnvironment,
          ...identities,
          status: 'error',
          diagnostic: `Composer not applied. ${error instanceof Error ? error.message : String(error)}`,
          ...(native === undefined ? {} : { native: metadata(native) }),
          ...(observation === undefined ? {} : { observation }),
        });
        throw error;
      }
    },
  };
};
export default { id: 'config-composer', server: ConfigComposerPlugin } satisfies PluginModule;
