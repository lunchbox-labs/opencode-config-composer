import { parse } from 'jsonc-parser';
import { parseCompositionDocument } from './document.ts';
import { SettingsError, agentGroups, record } from '../settings.ts';
import { type FileEdit, type SourceSnapshot, editJson } from '../storage.ts';
import type { CompositionDocument, ConfigurationPreset } from './types.ts';

type Path = (string | number)[];
interface Globals {
  model?: string;
  small_model?: string;
}
export function modelEditKey(file: string, path: Path): string {
  return JSON.stringify([file, ...path]);
}

function configurations(value: CompositionDocument): { path: Path; value: ConfigurationPreset; profile?: string }[] {
  return [
    ...Object.entries(value.configurationPresets ?? {}).map(([name, value]) => ({
      path: ['configurationPresets', name],
      value,
    })),
    ...Object.entries(value.componentGroups ?? {}).flatMap(([name, group]) =>
      group.configuration === undefined
        ? []
        : [{ path: ['componentGroups', name, 'configuration'], value: group.configuration }],
    ),
    ...Object.entries(value.components?.agents ?? {}).flatMap(([name, agent]) =>
      agent.configuration === undefined
        ? []
        : [{ path: ['components', 'agents', name, 'configuration'], value: agent.configuration }],
    ),
    ...(value.defaults?.agents === undefined ? [] : [{ path: ['defaults', 'agents'], value: value.defaults.agents }]),
    ...Object.entries(value.overrides?.agents ?? {}).map(([name, value]) => ({
      path: ['overrides', 'agents', name],
      value,
    })),
    ...Object.entries(value.profiles ?? {}).flatMap(([profile, definition]) =>
      Object.entries(definition.overrides?.agents ?? {}).map(([name, value]) => ({
        path: ['profiles', profile, 'overrides', 'agents', name],
        value,
        profile,
      })),
    ),
  ];
}

/** Reset only model-bound authored fields; destination values remain references. */
export function resetModelBindingEdits(
  snapshot: SourceSnapshot,
  edits: FileEdit[],
  explicit: ReadonlySet<string> = new Set(),
): FileEdit[] {
  const pending = new Map(edits.map((edit) => [edit.file.path, edit]));
  const before = new Map(snapshot.sources.documents.map((source) => [source.id, source.value]));
  const after = new Map(
    [...before].map(([id, value]) => {
      const edit = pending.get(id);
      return [id, edit === undefined ? value : parseCompositionDocument(edit.text, id)];
    }),
  );
  const readGlobals = (text: string): Globals => {
    const value: unknown = parse(text);
    return record(value)
      ? {
          model: typeof value.model === 'string' ? value.model : undefined,
          small_model: typeof value.small_model === 'string' ? value.small_model : undefined,
        }
      : {};
  };
  const nativeBefore = readGlobals(snapshot.configFile.text);
  const nativeAfter = readGlobals(pending.get(snapshot.configFile.path)?.text ?? snapshot.configFile.text);
  const registry = (documents: typeof before) => ({
    presets: Object.fromEntries(
      [...documents.values()].flatMap((value) => Object.entries(value.configurationPresets ?? {})),
    ),
    groups: Object.fromEntries([...documents.values()].flatMap((value) => Object.entries(value.componentGroups ?? {}))),
    profiles: Object.fromEntries([...documents.values()].flatMap((value) => Object.entries(value.profiles ?? {}))),
  });
  const previousRegistry = registry(before);
  const nextRegistry = registry(after);
  const active = snapshot.sources.orderedProfiles.map((profile) => profile.name);
  const globals = (
    documents: typeof before,
    definitions: ReturnType<typeof registry>,
    names: string[],
    native: Globals,
  ): Globals => {
    const result: Globals = { model: snapshot.nativeModels.model, small_model: snapshot.nativeModels.small_model };
    for (const key of ['model', 'small_model'] as const) {
      const projectMask = snapshot.nativeLayers.some(
        (layer) =>
          layer.project &&
          layer.file.path !== snapshot.configFile.path &&
          layer.kind === 'config' &&
          readGlobals(layer.file.text)[key] !== undefined,
      );
      if (!projectMask && native[key] !== nativeBefore[key]) {
        result[key] = native[key];
      }
    }
    const apply = (value: Globals | undefined) => {
      for (const key of ['model', 'small_model'] as const) {
        if (value?.[key] !== undefined) {
          result[key] = value[key];
        }
      }
    };
    for (const source of snapshot.sources.scopes) {
      apply(documents.get(source.id)?.defaults);
    }
    const visit = (name: string, seen = new Set<string>()) => {
      if (seen.has(name) || seen.size >= 64) {
        return;
      }
      const profile = Object.hasOwn(definitions.profiles, name) ? definitions.profiles[name] : undefined;
      if (profile === undefined) {
        return;
      }
      seen.add(name);
      if (profile.extends !== undefined) {
        visit(profile.extends, seen);
      }
      apply(profile.overrides);
    };
    for (const name of names) {
      visit(name);
    }
    for (const source of snapshot.sources.scopes) {
      apply(documents.get(source.id)?.overrides);
    }
    return result;
  };
  const signature = (
    value: ConfigurationPreset,
    presets: Record<string, ConfigurationPreset>,
    context: Globals,
    seen: string[] = [],
  ): unknown => {
    if (value.model !== undefined) {
      return ['model', value.model];
    }
    const reference = value.modelRef;
    if (reference === undefined) {
      return ['default', context.model];
    }
    if (seen.includes(reference) || seen.length >= 64) {
      return ['invalid', reference];
    }
    if (reference.startsWith('preset:')) {
      return [reference, signature(presets[reference.slice(7)] ?? {}, presets, context, [...seen, reference])];
    }
    return [reference, context[reference === 'opencode:model' ? 'model' : 'small_model']];
  };
  const consumers = (documents: typeof before, definitions: ReturnType<typeof registry>) => {
    const entries = [...documents].flatMap(([id, document]) =>
      configurations(document).map((entry) => ({ ...entry, key: modelEditKey(id, entry.path) })),
    );
    const result = new Map<string, string[][]>();
    const preset = new Map(
      entries.filter((entry) => entry.path[0] === 'configurationPresets').map((entry) => [entry.path[1], entry]),
    );
    const group = new Map(
      entries.filter((entry) => entry.path[0] === 'componentGroups').map((entry) => [entry.path[1], entry]),
    );
    const component = new Map(
      entries.filter((entry) => entry.path[0] === 'components').map((entry) => [entry.path[2], entry]),
    );
    for (const names of [active, ...Object.keys(definitions.profiles).map((name) => [name])]) {
      const touched = new Set<string>();
      const touch = (entry: (typeof entries)[number] | undefined) => {
        if (entry === undefined || touched.has(entry.key)) {
          return;
        }
        touched.add(entry.key);
        if (entry.value.modelRef?.startsWith('preset:') === true) {
          touch(preset.get(entry.value.modelRef.slice(7)));
        }
      };
      const touchGroup = (name: string) => {
        touch(group.get(name));
        const available = {
          ...snapshot.nativeAgents,
          ...Object.fromEntries(snapshot.agents.map((agent) => [agent.name, agent.settings])),
        };
        // Discovery includes dormant declarations without validating unrelated memberships.
        const members = new Set(Object.hasOwn(definitions.groups, name) ? definitions.groups[name].agents : []);
        for (const [agent, settings] of Object.entries(available)) {
          if (agentGroups(settings).includes(name)) {
            members.add(agent);
          }
        }
        for (const agent of members) {
          touch(component.get(agent));
        }
      };
      for (const entry of entries) {
        if (entry.path[0] === 'defaults' || entry.path[0] === 'overrides') {
          touch(entry);
        }
      }
      const visit = (name: string, seen = new Set<string>()) => {
        if (seen.has(name) || seen.size >= 64) {
          return;
        }
        seen.add(name);
        const profile = Object.hasOwn(definitions.profiles, name) ? definitions.profiles[name] : undefined;
        if (profile === undefined) {
          return;
        }
        if (profile.extends !== undefined) {
          visit(profile.extends, seen);
        }
        for (const [name, enabled] of Object.entries(profile.agentAvailability ?? {})) {
          if (enabled) {
            touch(component.get(name));
          }
        }
        for (const entry of entries) {
          if (entry.profile === name) {
            touch(entry);
          }
        }
        for (const layer of profile.layers ?? []) {
          if (layer.componentGroup !== undefined) {
            touchGroup(layer.componentGroup);
          }
          if (layer.configurationPreset !== undefined) {
            touch(preset.get(layer.configurationPreset));
          }
          for (const name of layer.target?.componentGroups ?? []) {
            touchGroup(name);
          }
          for (const name of layer.target?.agents ?? []) {
            touch(component.get(name));
          }
        }
      };
      for (const name of names) {
        visit(name);
      }
      for (const key of touched) {
        result.set(key, [...(result.get(key) ?? []), names]);
      }
    }
    return result;
  };
  const oldConsumers = consumers(before, previousRegistry);
  const newConsumers = consumers(after, nextRegistry);
  const contexts = (id: string, path: Path) => {
    const key = modelEditKey(id, path);
    const used = [...(oldConsumers.get(key) ?? []), ...(newConsumers.get(key) ?? [])];
    // Unused definitions still bind to the ordinary effective workspace defaults.
    return used.length === 0 ? [active] : used;
  };
  for (const [id, value] of before) {
    const next = new Map(configurations(after.get(id) ?? value).map((entry) => [JSON.stringify(entry.path), entry]));
    for (const previous of configurations(value)) {
      const current = next.get(JSON.stringify(previous.path));
      if (current === undefined) {
        continue;
      }
      const old = previous.value;
      const candidate = current.value;
      const authoredChanged = old.model !== candidate.model || old.modelRef !== candidate.modelRef;
      const dependentChanged =
        (old.model !== undefined || old.modelRef !== undefined) &&
        contexts(id, previous.path).some(
          (names) =>
            JSON.stringify(
              signature(old, previousRegistry.presets, globals(before, previousRegistry, names, nativeBefore)),
            ) !==
            JSON.stringify(
              signature(candidate, nextRegistry.presets, globals(after, nextRegistry, names, nativeAfter)),
            ),
        );
      if (!authoredChanged && !dependentChanged) {
        continue;
      }
      for (const field of ['variant', 'parameters'] as const) {
        if (candidate[field] === undefined || explicit.has(modelEditKey(id, [...previous.path, field]))) {
          continue;
        }
        // A changed field in this same proposal is an explicit destination value.
        if (pending.has(id) && JSON.stringify(candidate[field]) !== JSON.stringify(old[field])) {
          continue;
        }
        const file = snapshot.files.find((file) => file.path === id);
        if (file === undefined) {
          throw new SettingsError(`Affected model binding source ${id} is unavailable. Reopen the editor.`);
        }
        if (file.writable === false) {
          throw new SettingsError(
            `Read-only affected model binding in ${id} at /${previous.path.join('/')}. Edit its declaring source before changing this binding.`,
          );
        }
        const text = editJson(pending.get(id)?.text ?? file.text, [...previous.path, field], undefined);
        pending.set(id, { file, text });
      }
    }
  }
  return [...pending.values()].filter((edit) => edit.text !== edit.file.text);
}

/** Field patches switch bindings rather than creating an invalid model+modelRef pair. */
export function modelBindingPatch(path: Path): { target: Path; opposite: string } | undefined {
  const last = path.at(-1);
  if (last !== 'model' && last !== 'modelRef') {
    return undefined;
  }
  const target = path.slice(0, -1);
  const recognized =
    (target[0] === 'configurationPresets' && target.length === 2) ||
    (target[0] === 'componentGroups' && target.length === 3 && target[2] === 'configuration') ||
    (target[0] === 'profiles' && target.length === 5 && target[2] === 'overrides' && target[3] === 'agents');
  return recognized ? { target, opposite: last === 'model' ? 'modelRef' : 'model' } : undefined;
}

export function explicitModelFields(file: string, path: Path, value: unknown): string[] {
  if (!record(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) => [
    ...(['variant', 'parameters'].includes(key) ? [modelEditKey(file, [...path, key])] : []),
    ...explicitModelFields(file, [...path, key], child),
  ]);
}
