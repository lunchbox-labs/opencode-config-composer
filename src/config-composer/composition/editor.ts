import { type GroupOptions, type ModelChoice, type NativeModels, SettingsError } from '../settings.ts';
import type { LoadedSources } from './sources.ts';
import type { ConfigurationPreset } from './types.ts';

/** Presentation projection only. Persistence and effective previews use canonical documents. */
export function editorSettings(sources: LoadedSources, native: NativeModels): GroupOptions {
  const presets = sources.registry.configurationPresets ?? {};
  const globals = { ...native };
  for (const scope of sources.scopes) {
    Object.assign(globals, { ...scope.value.defaults, agents: undefined });
  }
  for (const occurrence of sources.orderedProfiles) {
    Object.assign(globals, { ...occurrence.profile.overrides, agents: undefined });
  }
  for (const scope of sources.scopes) {
    Object.assign(globals, { ...scope.value.overrides, agents: undefined });
  }
  function resolve(value: ConfigurationPreset, chain: string[] = []): ModelChoice {
    let inherited: ModelChoice = {};
    if (value.modelRef?.startsWith('preset:') === true) {
      const name = value.modelRef.slice(7);
      if (!Object.hasOwn(presets, name) || chain.includes(name) || chain.length >= 32) {
        throw new SettingsError(`Invalid or cyclic configuration preset ${name}.`);
      }
      inherited = resolve(presets[name], [...chain, name]);
    } else if (value.modelRef !== undefined) {
      inherited.model = globals[value.modelRef === 'opencode:model' ? 'model' : 'small_model'];
    }
    const model = value.model ?? inherited.model;
    const variant = value.variant ?? inherited.variant;
    return { ...(model === undefined ? {} : { model }), ...(variant === undefined ? {} : { variant }) };
  }
  return {
    groups: Object.fromEntries(
      Object.entries(sources.registry.componentGroups ?? {}).map(([name, group]) => {
        const value = group.configuration ?? {};
        return [
          name,
          {
            ...(value.model !== undefined ? { model: value.model } : {}),
            ...(value.modelRef !== undefined ? { modelRef: value.modelRef } : {}),
            ...(value.variant !== undefined ? { variant: value.variant } : {}),
            ...(value.prompt !== undefined ? { prompt: value.prompt } : {}),
          },
        ];
      }),
    ),
    modelPresets: Object.fromEntries(Object.entries(presets).map(([name, value]) => [name, resolve(value)])),
    promptSources: sources.registry.sourceDirectories ?? {},
    promptDefaults: {},
    agentPrompts: {},
  };
}
