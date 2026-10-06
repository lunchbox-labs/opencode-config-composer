import { findNodeAtLocation, parseTree } from 'jsonc-parser';
import { SettingsError, groupName, record } from '../settings.ts';
import {
  type FilePlan,
  type Snapshot,
  type SourceFile,
  editJson,
  parseAgent,
  parseConfig,
  previewFilePlan,
} from '../storage.ts';
import { parseCompositionDocument } from './document.ts';

export type DefinitionRegistry = 'componentGroups' | 'configurationPresets' | 'profiles';
interface Identity {
  registry: DefinitionRegistry;
  name: string;
}
export type DefinitionChange = Identity &
  (
    | { operation: 'create'; sourceId: string; value?: unknown }
    | { operation: 'patch'; path: (string | number)[]; value: unknown }
    | { operation: 'rename'; nextName: string }
    | { operation: 'delete' }
  );

interface Reference {
  file: SourceFile;
  path: (string | number)[];
  value: string;
  markdown: boolean;
}

export function definitionDestinations(snapshot: Snapshot): SourceFile[] {
  return snapshot.files.filter(
    (file) => file.writable !== false && snapshot.sources.documents.some((source) => source.id === file.path),
  );
}

function references(snapshot: Snapshot, registry: DefinitionRegistry, name: string): Reference[] {
  const result: Reference[] = [];
  const add = (file: SourceFile, path: (string | number)[], value: unknown, markdown = false) => {
    if (value === name || (registry === 'configurationPresets' && value === `preset:${name}`)) {
      result.push({ file, path, value, markdown });
    }
  };
  for (const source of snapshot.sources.documents) {
    const file = snapshot.files.find((file) => file.path === source.id);
    if (file === undefined) {
      throw new SettingsError('A composition source is unavailable. Reopen the editor.');
    }
    const value = source.value;
    const modelRef = (path: (string | number)[], choice: { modelRef?: string } | undefined) => {
      if (registry === 'configurationPresets' && choice?.modelRef === `preset:${name}`) {
        add(file, [...path, 'modelRef'], choice.modelRef);
      }
    };
    for (const [key, preset] of Object.entries(value.configurationPresets ?? {})) {
      modelRef(['configurationPresets', key], preset);
    }
    for (const [key, group] of Object.entries(value.componentGroups ?? {})) {
      modelRef(['componentGroups', key, 'configuration'], group.configuration);
    }
    for (const [key, agent] of Object.entries(value.components?.agents ?? {})) {
      modelRef(['components', 'agents', key, 'configuration'], agent.configuration);
    }
    modelRef(['defaults', 'agents'], value.defaults?.agents);
    for (const [key, agent] of Object.entries(value.overrides?.agents ?? {})) {
      modelRef(['overrides', 'agents', key], agent);
    }
    for (const [key, profile] of Object.entries(value.profiles ?? {})) {
      if (registry === 'profiles') {
        add(file, ['profiles', key, 'extends'], profile.extends);
      }
      for (const [agent, configuration] of Object.entries(profile.overrides?.agents ?? {})) {
        modelRef(['profiles', key, 'overrides', 'agents', agent], configuration);
      }
      for (const [index, layer] of (profile.layers ?? []).entries()) {
        const at = ['profiles', key, 'layers', index];
        if (registry === 'componentGroups') {
          add(file, [...at, 'componentGroup'], layer.componentGroup);
          for (const [target, group] of (layer.target?.componentGroups ?? []).entries()) {
            add(file, [...at, 'target', 'componentGroups', target], group);
          }
        } else if (registry === 'configurationPresets') {
          add(file, [...at, 'configurationPreset'], layer.configurationPreset);
        }
      }
    }
    if (registry === 'profiles') {
      for (const [index, profile] of (value.activeProfiles ?? []).entries()) {
        add(file, ['activeProfiles', index], profile);
      }
    }
  }
  if (registry === 'componentGroups') {
    const nativeFiles = new Map(
      snapshot.nativeLayers.map((layer) => [
        layer.file.path,
        { file: layer.file, markdown: layer.kind === 'markdown' },
      ]),
    );
    for (const agent of Object.values(snapshot.sources.registry.components?.agents ?? {})) {
      if (agent.file !== undefined) {
        const file = snapshot.files.find((file) => file.path === agent.file);
        if (file === undefined) {
          throw new SettingsError('A component source is unavailable. Reopen the editor.');
        }
        nativeFiles.set(file.path, { file, markdown: true });
      }
    }
    for (const { file, markdown } of nativeFiles.values()) {
      const value: unknown = markdown ? parseAgent(file).document.toJS({ maxAliasCount: 0 }) : parseConfig(file.text);
      const entries = markdown
        ? [[[] as (string | number)[], value] as const]
        : record(value) && record(value.agent)
          ? Object.entries(value.agent).map(([key, agent]) => [['agent', key], agent] as const)
          : [];
      for (const [path, agent] of entries) {
        if (!record(agent)) {
          continue;
        }
        for (const [at, groups] of [
          [['groups'], agent.groups],
          [['options', 'groups'], record(agent.options) ? agent.options.groups : undefined],
        ] as const) {
          if (Array.isArray(groups)) {
            for (const [index, group] of groups.entries()) {
              add(file, [...path, ...at, index], group, markdown);
            }
          }
        }
      }
    }
  }
  return result;
}

export function planDefinition(snapshot: Snapshot, change: DefinitionChange): FilePlan {
  groupName(change.name);
  const definitions = snapshot.sources.registry[change.registry] ?? {};
  const pending = new Map<string, { file: SourceFile; text: string }>();
  const editable = (file: SourceFile) => {
    if (file.writable === false) {
      throw new SettingsError(
        `Read-only reference or definition source ${file.path}. Edit its declaring source before renaming.`,
      );
    }
    const previous = pending.get(file.path);
    if (previous !== undefined) {
      return previous;
    }
    const entry = { file, text: file.text };
    pending.set(file.path, entry);
    return entry;
  };
  if (change.operation === 'create') {
    if (Object.hasOwn(definitions, change.name)) {
      throw new SettingsError('That definition already exists.');
    }
    const file = definitionDestinations(snapshot).find((file) => file.path === change.sourceId);
    if (file === undefined) {
      throw new SettingsError('Select an existing writable composition source.');
    }
    const entry = editable(file);
    entry.text = editJson(
      entry.text,
      [change.registry, change.name],
      change.value ?? (change.registry === 'profiles' ? { layers: [] } : {}),
    );
  } else {
    if (!Object.hasOwn(definitions, change.name)) {
      throw new SettingsError('That definition is unavailable. Reopen the editor.');
    }
    const sourceId = snapshot.sources.provenance[`/${change.registry}/${change.name}`].sourceId;
    const file = snapshot.files.find((file) => file.path === sourceId);
    if (file === undefined) {
      throw new SettingsError('The declaring source is unavailable. Reopen the editor.');
    }
    const entry = editable(file);
    if (change.operation === 'patch') {
      if (
        change.path.length === 0 ||
        change.path.some((key) => ['__proto__', 'constructor', 'prototype'].includes(String(key)))
      ) {
        throw new SettingsError('Select a valid definition field.');
      }
      entry.text = editJson(entry.text, [change.registry, change.name, ...change.path], change.value);
    } else {
      const refs = references(snapshot, change.registry, change.name);
      if (change.operation === 'delete') {
        if (refs.length > 0) {
          throw new SettingsError(
            `Definition ${change.name} is referenced by ${refs[0].file.path} at /${refs[0].path.join('/')}. Reassign its references first.`,
          );
        }
        entry.text = editJson(entry.text, [change.registry, change.name], undefined);
      } else {
        groupName(change.nextName);
        if (Object.hasOwn(definitions, change.nextName)) {
          throw new SettingsError('That definition already exists.');
        }
        const tree = parseTree(entry.text);
        const key =
          tree === undefined
            ? undefined
            : findNodeAtLocation(tree, [change.registry, change.name])?.parent?.children?.[0];
        if (key === undefined) {
          throw new SettingsError('The definition key is unavailable. Reopen the editor.');
        }
        entry.text =
          entry.text.slice(0, key.offset) + JSON.stringify(change.nextName) + entry.text.slice(key.offset + key.length);
        for (const reference of refs) {
          const target = editable(reference.file);
          const value = reference.value === `preset:${change.name}` ? `preset:${change.nextName}` : change.nextName;
          // References inside the renamed definition now live under its new key.
          const path = [...reference.path];
          if (
            !reference.markdown &&
            reference.file.path === file.path &&
            path[0] === change.registry &&
            path[1] === change.name
          ) {
            path[1] = change.nextName;
          }
          if (reference.markdown) {
            const agent = parseAgent({ ...target.file, text: target.text });
            agent.document.setIn(path, value);
            target.text =
              agent.prefix + agent.document.toString({ lineWidth: 0 }).replaceAll('\n', agent.eol) + agent.body;
          } else {
            target.text = editJson(target.text, path, value);
          }
        }
      }
    }
  }
  const edits = [...pending.values()].filter((edit) => edit.text !== edit.file.text);
  for (const edit of edits) {
    if (snapshot.sources.documents.some((source) => source.id === edit.file.path)) {
      parseCompositionDocument(edit.text, edit.file.path);
    }
  }
  const detail =
    change.operation === 'patch'
      ? ` /${change.path.join('/')}`
      : change.operation === 'rename'
        ? ` → ${change.nextName}`
        : '';
  return { snapshot, edits, description: `${change.operation} ${change.registry}/${change.name}${detail}` };
}

export const previewDefinition = previewFilePlan;
