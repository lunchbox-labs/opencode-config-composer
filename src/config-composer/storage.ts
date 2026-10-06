import { lstat, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  type Node as JsonNode,
  type ParseError,
  applyEdits,
  createScanner,
  findNodeAtLocation,
  modify,
  parse,
  parseTree,
} from 'jsonc-parser';
import { type Document, parseDocument } from 'yaml';
import {
  type AgentSettings,
  type GroupChoice,
  type GroupOptions,
  type Groups,
  type ModelChoice,
  type ModelPresets,
  type NativeModels,
  SettingsError,
  agentGroups,
  groupChoice,
  groupName,
  modelChoice,
  presetName,
  record,
} from './settings.ts';
import { configurationFile, configurationPath } from './configuration.ts';
import { type LoadedSources, type ProjectContext, loadCompositionSources } from './composition/sources.ts';
import { loadComponents } from './composition/components.ts';
import { type ResolvedProfileRuntime, nativeAgentNames, resolveProfileRuntime } from './composition/runtime.ts';
import { parseCompositionDocument } from './composition/document.ts';
import { editorSettings } from './composition/editor.ts';
import { resolveGroupAgentNames } from './composition/membership.ts';
import { packageName } from './package-name.ts';
import { type NativeAgentLayer, loadNativeProjectSources } from './composition/native-sources.ts';

export interface SourceFile {
  path: string;
  text: string;
  mode: number;
  writable?: boolean;
  canonicalPath?: string;
  aliases?: string[];
}
export interface AgentFile {
  file: SourceFile;
  document: Document;
  prefix: string;
  body: string;
  eol: string;
}
export interface StoredAgent {
  name: string;
  settings: AgentSettings;
  markdown?: AgentFile;
  component?: boolean;
  project?: boolean;
}
export interface Snapshot {
  root: string;
  configFile: SourceFile;
  config: Record<string, unknown>;
  settingsFile: SourceFile;
  settings: GroupOptions;
  pluginIndex: number;
  groups: Groups;
  modelPresets: ModelPresets;
  agents: StoredAgent[];
  files: SourceFile[];
  sources: LoadedSources;
  sourceContext: ProjectContext;
  resolved: ResolvedProfileRuntime;
  nativeAgents: Record<string, AgentSettings>;
  nativeModels: NativeModels;
  nativeLayers: NativeAgentLayer[];
  nativeDirectory: string;
  nativeWorktree: string;
}
export type Change =
  | { kind: 'group'; name: string; choice: GroupChoice }
  | { kind: 'preset'; name: string; choice: ModelChoice }
  | { kind: 'deletePreset'; name: string }
  | { kind: 'global'; field: 'model' | 'small_model'; model: string }
  | { kind: 'all'; choice: ModelChoice }
  | { kind: 'membership'; agent: string; groups: string[] }
  | { kind: 'override'; agent: string; choice: ModelChoice };
export interface FileEdit {
  file: SourceFile;
  text: string;
}
export interface EditPlan {
  snapshot: Snapshot;
  change: Change;
  edits: FileEdit[];
  description: string;
}

function checkObjectKeys(node: JsonNode | undefined): void {
  if (node === undefined) {
    return;
  }
  if (node.type === 'object') {
    const keys = node.children?.map((item): unknown => item.children?.[0].value) ?? [];
    if (new Set(keys).size !== keys.length) {
      throw new SettingsError('The configuration has duplicate JSON keys.');
    }
  }
  node.children?.forEach(checkObjectKeys);
}

export function parseConfig(text: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !record(value)) {
    throw new SettingsError('Fix the invalid JSONC configuration before editing models.');
  }
  checkObjectKeys(parseTree(text));
  return value;
}

function parseAgent(file: SourceFile): AgentFile {
  const match = /^(---\r?\n)([\s\S]*?)(^---\s*\n|^---\s*$)/m.exec(file.text);
  if (match?.index !== 0) {
    throw new SettingsError('An agent file has missing or invalid frontmatter.');
  }
  const document = parseDocument(match[2], { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new SettingsError('Fix invalid agent frontmatter before editing settings.');
  }
  const frontmatter: unknown = document.toJS({ maxAliasCount: 0 });
  if (!record(frontmatter)) {
    throw new SettingsError('Fix invalid agent frontmatter before editing settings.');
  }
  return {
    file,
    document,
    prefix: match[1],
    body: match[3] + file.text.slice(match[0].length),
    eol: match[1].includes('\r') ? '\r\n' : '\n',
  };
}

function mergeNative(base: AgentSettings, next: AgentSettings): AgentSettings {
  const result = { ...base };
  for (const [key, value] of Object.entries(next)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) {
      throw new SettingsError('Native agent configuration contains an unsafe key.');
    }
    result[key] = record(value) && record(result[key]) ? mergeNative(result[key], value) : value;
  }
  return result;
}

function nativeAgentsFromLayers(
  layers: NativeAgentLayer[],
  overlays: ReadonlyMap<string, string> = new Map(),
): Map<string, StoredAgent> {
  const agents = new Map<string, StoredAgent>();
  let batch: string | undefined;
  const pending = new Map<string, { settings: AgentSettings; layer: NativeAgentLayer; markdown?: AgentFile }>();
  const contribute = (name: string, settings: AgentSettings, layer: NativeAgentLayer, markdown?: AgentFile) => {
    if (name === '' || ['__proto__', 'constructor', 'prototype'].includes(name)) {
      throw new SettingsError('Native agent identity is invalid.');
    }
    const previous = agents.get(name);
    agents.set(name, {
      name,
      settings: mergeNative(previous?.settings ?? {}, settings),
      markdown: markdown ?? previous?.markdown,
      project: previous?.project === true || layer.project,
    });
  };
  const flush = () => {
    for (const [name, item] of pending) {
      contribute(name, item.settings, item.layer, item.markdown);
    }
    pending.clear();
  };
  for (const layer of layers) {
    if (batch !== layer.batch) {
      flush();
      batch = layer.batch;
    }
    const file = { ...layer.file, text: overlays.get(layer.file.path) ?? layer.file.text };
    if (layer.kind === 'config') {
      const config = parseConfig(file.text);
      for (const [name, value] of Object.entries(record(config.agent) ? config.agent : {})) {
        if (!record(value)) {
          throw new SettingsError('An agent configuration must be an object.');
        }
        contribute(name, value, layer);
      }
    } else {
      const markdown = parseAgent(file);
      const value: unknown = markdown.document.toJS({ maxAliasCount: 0 });
      if (!record(value) || layer.name === undefined) {
        throw new SettingsError('Fix invalid native agent frontmatter before editing settings.');
      }
      const name = typeof value.name === 'string' ? value.name : layer.name;
      if (!layer.project && name !== layer.name) {
        throw new SettingsError('The editor requires agent names to match their relative Markdown filenames.');
      }
      const settings: AgentSettings = {
        ...value,
        ...(layer.primary === true ? { mode: 'primary' } : {}),
        prompt: markdown.body.replace(/^---[^\n]*\n?/, '').trim(),
      };
      if (batch === undefined) {
        contribute(name, settings, layer, markdown);
      } else {
        pending.set(name, { settings, layer, markdown });
      }
    }
  }
  flush();
  return agents;
}

async function sourceFile(root: string, path: string): Promise<SourceFile> {
  const info = await lstat(path);
  const rel = relative(root, await realpath(path));
  if (!info.isFile() || info.isSymbolicLink() || rel.startsWith('..') || isAbsolute(rel) || info.size > 2_000_000) {
    throw new SettingsError('Settings must be regular files inside this configuration directory, under 2 MB each.');
  }
  return { path, text: await readFile(path, 'utf8'), mode: info.mode & 0o777, writable: (info.mode & 0o222) !== 0 };
}

async function observedComposition(sources: LoadedSources): Promise<void> {
  for (const [path, expected] of sources.paths) {
    const actual = await realpath(path).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    });
    if (actual !== expected) {
      throw new SettingsError('Settings source identity changed. Reopen the editor.');
    }
  }
}

async function observedFile(root: string, original: SourceFile): Promise<SourceFile> {
  for (const alias of original.aliases ?? []) {
    if ((await realpath(alias)) !== (original.canonicalPath ?? original.path)) {
      throw new SettingsError('Settings source identity changed. Reopen the editor.');
    }
  }
  if (original.writable !== false) {
    return sourceFile(root, original.path);
  }
  const canonical = await realpath(original.path);
  if (canonical !== (original.canonicalPath ?? original.path)) {
    throw new SettingsError('Settings source identity changed. Reopen the editor.');
  }
  return configurationFile(canonical);
}

function serverEntry(spec: unknown, root: string): boolean {
  if (typeof spec !== 'string') {
    return false;
  }
  if (spec === packageName) {
    return true;
  }
  if (spec.startsWith(`${packageName}@`)) {
    const version = spec.slice(packageName.length + 1);
    return version !== '' && /^[a-z0-9.*+~^<>=| -]+$/i.test(version);
  }
  try {
    const path = resolve(spec.startsWith('file:') ? fileURLToPath(spec) : resolve(root, spec));
    return [
      fileURLToPath(new URL('../server.ts', import.meta.url)),
      fileURLToPath(new URL('../server.js', import.meta.url)),
      resolve(fileURLToPath(new URL('../../', import.meta.url))),
    ].includes(path);
  } catch {
    return false;
  }
}

function pluginOptions(config: Record<string, unknown>, index: number): unknown {
  if (!Array.isArray(config.plugin)) {
    throw new SettingsError('Configure the Config Composer server plugin first.');
  }
  const plugins: unknown[] = config.plugin;
  const plugin = plugins[index];
  if (!Array.isArray(plugin)) {
    return undefined;
  }
  const entry: unknown[] = plugin;
  return entry[1];
}

export async function loadSnapshot(
  directory: string,
  projectRoot = directory,
  native?: NativeModels,
  nativeDirectory = projectRoot,
  nativeWorktree = projectRoot,
): Promise<Snapshot> {
  const root = await realpath(directory);
  const entries = await readdir(root);
  const configs = entries.filter((name) => ['opencode.json', 'opencode.jsonc'].includes(name));
  if (entries.includes('config.json')) {
    throw new SettingsError('Merge legacy config.json settings into opencode.jsonc before using the editor.');
  }
  if (configs.length !== 1) {
    throw new SettingsError('The editor needs one opencode.json or opencode.jsonc in its installation directory.');
  }
  const configFile = await sourceFile(root, join(root, configs[0]));
  const config = parseConfig(configFile.text);
  if (!Array.isArray(config.plugin)) {
    throw new SettingsError('Configure the Config Composer server plugin first.');
  }
  const plugins: unknown[] = config.plugin;
  const matches = plugins.flatMap((entry, index) =>
    serverEntry(Array.isArray(entry) ? entry[0] : entry, root) ? [index] : [],
  );
  if (matches.length !== 1) {
    throw new SettingsError('Configure exactly one Config Composer server plugin entry.');
  }
  const pluginIndex = matches[0];
  const options = pluginOptions(config, pluginIndex) ?? {};
  if (
    !record(options) ||
    Object.keys(options).some((key) => !['configFile', 'reloadToken'].includes(key)) ||
    (options.configFile !== undefined && typeof options.configFile !== 'string') ||
    (options.reloadToken !== undefined && typeof options.reloadToken !== 'string')
  ) {
    throw new SettingsError('Config Composer plugin options support only configFile and an optional reloadToken.');
  }
  const sourceContext = {
    root: projectRoot,
    baseFile: configurationPath(
      typeof options.configFile === 'string' ? options.configFile : 'config-composer.jsonc',
      root,
    ),
    baseExplicit: typeof options.configFile === 'string',
  };
  const sources = await loadCompositionSources(sourceContext);
  const compositionFiles: SourceFile[] = [];
  for (const source of sources.documents) {
    const file = await configurationFile(source.id);
    if (file.text !== source.text) {
      throw new SettingsError('Composition sources changed while loading. Reopen the editor.');
    }
    const rel = relative(root, source.id);
    compositionFiles.push({
      ...file,
      canonicalPath: source.id,
      aliases: [...sources.paths].flatMap(([path, canonical]) =>
        canonical === source.id && path !== source.id ? [path] : [],
      ),
      writable: source.writable && !rel.startsWith('..') && !isAbsolute(rel),
      mode: file.mode & 0o777,
    });
  }
  const preferred = sources.scopes.find((source) => source.id === sourceContext.baseFile) ?? sources.scopes[0];
  const settingsFile = compositionFiles.find((file) => file.path === preferred.id);
  if (settingsFile === undefined) {
    throw new SettingsError('No composition source is available for the editor.');
  }
  const nativeModels = native ?? config;
  const settings = editorSettings(sources, nativeModels);
  const { groups, modelPresets } = settings;
  const projectSources =
    resolve(projectRoot) === root
      ? { configurations: [], directories: [] }
      : await loadNativeProjectSources(nativeWorktree, nativeDirectory);
  const custom = process.env.OPENCODE_CONFIG_DIR !== undefined && resolve(process.env.OPENCODE_CONFIG_DIR) === root;
  const nativeLayers: NativeAgentLayer[] = custom
    ? [...projectSources.configurations, ...projectSources.directories]
    : [{ file: configFile, kind: 'config', project: false }, ...projectSources.configurations];
  if (custom) {
    nativeLayers.push({ file: configFile, kind: 'config', project: false });
  }
  const files = [
    configFile,
    ...compositionFiles,
    ...[...projectSources.configurations, ...projectSources.directories].map((layer) => layer.file),
  ];

  const markdownNames = new Set<string>();
  async function scan(directory: string, base: string): Promise<void> {
    if ((await lstat(directory)).isSymbolicLink()) {
      throw new SettingsError('The settings editor does not follow agent symlinks.');
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new SettingsError('The settings editor does not follow agent symlinks.');
      }
      if (entry.isDirectory()) {
        await scan(path, base);
        continue;
      }
      if (!entry.name.endsWith('.md')) {
        continue;
      }
      const name = relative(base, path).replaceAll('\\', '/').slice(0, -3);
      if (markdownNames.has(name)) {
        throw new SettingsError('Duplicate agent files must be resolved before editing settings.');
      }
      markdownNames.add(name);
      const file = await sourceFile(root, path);
      nativeLayers.push({ file, kind: 'markdown', name, project: false });
      files.push(file);
    }
  }
  for (const dir of ['agents', 'agent']) {
    if (entries.includes(dir)) {
      await scan(join(root, dir), join(root, dir));
    }
  }
  if (!custom) {
    nativeLayers.push(...projectSources.directories);
  }
  const agents = nativeAgentsFromLayers(nativeLayers);
  const nativeAgents = Object.fromEntries([...agents].map(([name, agent]) => [name, agent.settings]));
  const available = { ...Object.fromEntries(nativeAgentNames.map((name) => [name, {}])), ...nativeAgents };
  for (const definitions of [
    sources.registry.components?.agents,
    sources.registry.components?.skills,
    sources.registry.components?.commands,
    sources.registry.components?.prompts,
  ]) {
    for (const value of Object.values(definitions ?? {})) {
      if (!record(value) || typeof value.file !== 'string' || files.some((file) => file.path === value.file)) {
        continue;
      }
      const file = await configurationFile(await realpath(value.file));
      const rel = relative(root, value.file);
      files.push({
        ...file,
        path: value.file,
        mode: file.mode & 0o777,
        canonicalPath: file.path,
        writable: (file.mode & 0o222) !== 0 && file.path === value.file && !rel.startsWith('..') && !isAbsolute(rel),
      });
    }
  }
  const overlays = new Map(files.map((file) => [file.path, file.text]));
  const components = await loadComponents(sources, available, overlays);
  for (const name of nativeAgentNames) {
    if (!agents.has(name)) {
      agents.set(name, { name, settings: {} });
    }
  }
  for (const [name, value] of Object.entries(components.agents)) {
    const path = sources.registry.components?.agents?.[name].file;
    const file = files.find((file) => file.path === path);
    if (path !== undefined && file === undefined) {
      throw new SettingsError(`Component source ${path} is unavailable. Reopen the editor.`);
    }
    const markdown = file === undefined ? undefined : parseAgent(file);
    agents.set(name, { name, settings: value, component: true, markdown });
  }
  const enabled = [...agents.values()]
    .filter((agent) => agent.settings.disable !== true)
    .sort((a, b) => a.name.localeCompare(b.name));
  enabled.forEach((agent) => agentGroups(agent.settings));
  const resolved = await resolveProfileRuntime(sources, { ...nativeModels, agent: nativeAgents }, overlays);
  await observedComposition(sources);
  for (const file of files) {
    if ((await observedFile(root, file)).text !== file.text) {
      throw new SettingsError('Settings changed while loading. Reopen the editor.');
    }
  }
  return {
    root,
    configFile,
    config,
    settingsFile,
    settings,
    pluginIndex,
    groups,
    modelPresets,
    agents: enabled,
    files,
    sources,
    sourceContext,
    resolved,
    nativeAgents,
    nativeModels,
    nativeLayers,
    nativeDirectory,
    nativeWorktree,
  };
}

export function memberships(snapshot: Snapshot, agent: StoredAgent): string[] {
  return [
    ...new Set([
      ...agentGroups(agent.settings),
      ...Object.entries(snapshot.sources.registry.componentGroups ?? {})
        .filter(([, group]) => group.agents?.includes(agent.name) === true)
        .map(([name]) => name),
    ]),
  ];
}

export function groupNames(snapshot: Snapshot): string[] {
  return [
    ...new Set([...Object.keys(snapshot.groups), ...snapshot.agents.flatMap((agent) => agentGroups(agent.settings))]),
  ].sort();
}

export function affectedGroups(snapshot: Snapshot, change: Change): string[] {
  if (change.kind === 'all') {
    return groupNames(snapshot);
  }
  if (change.kind === 'group') {
    return [change.name];
  }
  const modelRef =
    change.kind === 'global'
      ? `opencode:${change.field}`
      : change.kind === 'preset' || change.kind === 'deletePreset'
        ? `preset:${change.name}`
        : undefined;
  return modelRef !== undefined && modelRef !== ''
    ? Object.keys(snapshot.groups).filter((name) => snapshot.groups[name].modelRef === modelRef)
    : [];
}

function editJson(text: string, path: (string | number)[], value: unknown): string {
  const tree = parseTree(text);
  if (value === undefined && (tree === undefined || findNodeAtLocation(tree, path) === undefined)) {
    return text;
  }
  if (value === undefined && tree !== undefined) {
    const property = findNodeAtLocation(tree, path)?.parent;
    const object = property?.parent;
    if (property?.type === 'property' && object?.type === 'object') {
      const properties = object.children ?? [];
      const index = properties.indexOf(property);
      const next = properties.at(index + 1);
      const previous = index > 0 ? properties.at(index - 1) : undefined;
      const start = property.offset;
      const end = start + property.length;
      const scanner = createScanner(text);
      scanner.setPosition(next === undefined && previous !== undefined ? previous.offset + previous.length : end);
      const boundary = next?.offset ?? (previous === undefined ? object.offset + object.length - 1 : start);
      while (scanner.getPosition() < boundary) {
        scanner.scan();
        if (text.slice(scanner.getTokenOffset(), scanner.getTokenOffset() + scanner.getTokenLength()) === ',') {
          const comma = scanner.getTokenOffset();
          // Delete the property and its separator, preserving neighboring JSONC comments.
          return comma < start
            ? text.slice(0, comma) + text.slice(comma + 1, start) + text.slice(end)
            : text.slice(0, start) + text.slice(end, comma) + text.slice(comma + 1);
        }
      }
      return text.slice(0, start) + text.slice(end);
    }
  }
  return applyEdits(
    text,
    modify(text, path, value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes('\r\n') ? '\r\n' : '\n' },
    }),
  );
}

function membershipGroups(change: Extract<Change, { kind: 'membership' }>): string[] {
  const groups = change.groups.map(groupName);
  if (groups.length > 64) {
    throw new SettingsError('Agent groups must contain no more than 64 memberships.');
  }
  if (new Set(groups).size !== groups.length) {
    throw new SettingsError('An agent cannot list the same group twice.');
  }
  return groups;
}

export function planChange(snapshot: Snapshot, change: Change): EditPlan {
  let configText = snapshot.configFile.text;
  const edits: FileEdit[] = [];
  const patch = (path: (string | number)[], value: unknown) => {
    configText = editJson(configText, path, value);
  };
  const pending = new Map<string, FileEdit>();
  const patchFile = (file: SourceFile, path: (string | number)[], value: unknown) => {
    if (file.writable === false) {
      throw new SettingsError(`Read-only composition source ${file.path}. Edit its declaring document directly.`);
    }
    const text = editJson(pending.get(file.path)?.text ?? file.text, path, value);
    pending.set(file.path, { file, text });
  };
  const definition = (kind: 'componentGroups' | 'configurationPresets' | 'components/agents', name: string) => {
    const pointer = `/${kind}/${name.replaceAll('~', '~0').replaceAll('/', '~1')}`;
    const origin = Object.hasOwn(snapshot.sources.provenance, pointer)
      ? snapshot.sources.provenance[pointer]
      : undefined;
    const file =
      origin === undefined ? snapshot.settingsFile : snapshot.files.find((file) => file.path === origin.sourceId);
    if (file === undefined) {
      throw new SettingsError('The declaring composition source is unavailable. Reopen the editor.');
    }
    return { file, path: [...kind.split('/'), name] };
  };
  const patchDefinition = (
    kind: 'componentGroups' | 'configurationPresets' | 'components/agents',
    name: string,
    suffix: string[],
    value: unknown,
  ) => {
    const { file, path } = definition(kind, name);
    patchFile(file, [...path, ...suffix], value);
  };
  const patchModel = (
    kind: 'componentGroups' | 'configurationPresets' | 'components/agents',
    name: string,
    choice: GroupChoice,
  ) => {
    const suffix = kind === 'configurationPresets' ? [] : ['configuration'];
    // Update only the model fields: mixed bundles and presets retain their other settings.
    for (const field of ['model', 'modelRef', 'variant'] as const) {
      patchDefinition(kind, name, [...suffix, field], choice[field]);
    }
  };
  const patchGroup = (name: string, value: GroupChoice) => {
    const choice = groupChoice(value);
    if (!Object.hasOwn(snapshot.groups, name)) {
      patchDefinition('componentGroups', name, [], {});
    }
    patchModel('componentGroups', name, choice);
    if (choice.prompt !== undefined) {
      patchDefinition('componentGroups', name, ['configuration', 'prompt'], choice.prompt);
    }
  };
  if (change.kind === 'group') {
    patchGroup(groupName(change.name), change.choice);
  } else if (change.kind === 'preset') {
    const choice = modelChoice(change.choice);
    if (choice.model === undefined || choice.model === '') {
      throw new SettingsError('A model preset requires a concrete model.');
    }
    patchModel('configurationPresets', presetName(change.name), choice);
  } else if (change.kind === 'deletePreset') {
    const name = presetName(change.name);
    if (!Object.hasOwn(snapshot.modelPresets, name)) {
      throw new SettingsError('That model preset no longer exists.');
    }
    const referenced = (value: unknown): boolean =>
      record(value)
        ? Object.entries(value).some(
            ([key, child]) =>
              (key === 'modelRef' && child === `preset:${name}`) ||
              (key === 'configurationPreset' && child === name) ||
              referenced(child),
          )
        : Array.isArray(value) && value.some(referenced);
    if (snapshot.sources.documents.some((source) => referenced(source.value))) {
      throw new SettingsError(
        'This preset is referenced by composition settings. Reassign those references before deleting it.',
      );
    }
    patchDefinition('configurationPresets', name, [], undefined);
  } else if (change.kind === 'global') {
    modelChoice({ model: change.model });
    patch([change.field], change.model);
  } else if (change.kind === 'all') {
    const choice = modelChoice(change.choice);
    if (choice.model === undefined || choice.model === '') {
      throw new SettingsError('Select a model for all defaults.');
    }
    patch(['model'], choice.model);
    patch(['small_model'], choice.model);
    for (const name of Object.keys(snapshot.modelPresets)) {
      patchModel('configurationPresets', name, choice);
    }
    for (const name of groupNames(snapshot)) {
      const group = Object.hasOwn(snapshot.groups, name) ? snapshot.groups[name] : undefined;
      const modelRef = group?.modelRef;
      patchGroup(
        name,
        modelRef !== undefined && modelRef !== ''
          ? {
              modelRef,
              ...(choice.variant !== undefined && choice.variant !== '' ? { variant: choice.variant } : {}),
            }
          : choice,
      );
    }
  } else {
    const agent = snapshot.agents.find((item) => item.name === change.agent);
    if (agent === undefined) {
      throw new SettingsError('That agent is no longer available. Reopen the editor.');
    }
    if (agent.project === true && change.kind === 'override') {
      throw new SettingsError(
        'Edit the native project source directly to change its model pin, or use an explicit canonical profile override.',
      );
    }
    if (
      agent.project === true &&
      change.kind === 'membership' &&
      agentGroups(agent.settings).some((name) => !change.groups.includes(name))
    ) {
      throw new SettingsError(
        'This membership is declared in native frontmatter or native JSON. Edit that native source to remove it.',
      );
    }
    if (change.kind === 'membership') {
      const desired = membershipGroups(change);
      for (const name of membershipGroups(change)) {
        if (!Object.hasOwn(snapshot.groups, name)) {
          patchDefinition('componentGroups', name, [], {});
        }
      }

      for (const [name, group] of Object.entries(snapshot.sources.registry.componentGroups ?? {})) {
        if (group.agents?.includes(agent.name) === true && !desired.includes(name)) {
          patchDefinition(
            'componentGroups',
            name,
            ['agents'],
            group.agents.filter((member) => member !== agent.name),
          );
        }
      }
      // Inline components have no frontmatter. JSONC membership is authoritative for them.
      if (agent.project === true || (agent.component === true && agent.markdown === undefined)) {
        for (const name of desired) {
          const previous = snapshot.sources.registry.componentGroups?.[name]?.agents ?? [];
          if (previous.includes(agent.name) || agentGroups(agent.settings).includes(name)) {
            continue;
          }
          patchDefinition('componentGroups', name, ['agents'], [...new Set([...previous, agent.name])]);
        }
      }
    }
    if (agent.component === true && change.kind === 'override') {
      patchModel('components/agents', agent.name, modelChoice(change.choice));
    }
    const values: Record<string, unknown> =
      change.kind === 'membership'
        ? { groups: membershipGroups(change) }
        : { model: modelChoice(change.choice).model, variant: change.choice.variant };
    if (change.kind === 'override' && (change.choice.model === undefined || change.choice.model === '')) {
      values.variant = undefined;
    }
    const componentOverride = agent.component === true && change.kind === 'override';
    const document = componentOverride || agent.project === true ? undefined : agent.markdown?.document.clone();
    const options: unknown = agent.settings.options;
    if (change.kind === 'membership' && agent.project !== true) {
      // A new ordered membership replaces lower-layer membership.
      if (document?.has('options') === true) {
        document.deleteIn(['options', 'groups']);
      }
      patch(['agent', agent.name, 'options', 'groups'], undefined);
      if (document !== undefined) {
        patch(['agent', agent.name, 'groups'], undefined);
      }
    }
    for (const [key, value] of Object.entries(values)) {
      if (componentOverride) {
        continue;
      }
      if (
        (agent.project === true || agent.component === true) &&
        change.kind === 'membership' &&
        document === undefined
      ) {
        continue;
      }
      if (document !== undefined) {
        if (value === undefined) {
          document.delete(key);
        } else {
          document.set(key, value);
        }
      }
      // Remove lower-layer pins when an agent returns to inheritance.
      if (document === undefined || value === undefined) {
        patch(['agent', agent.name, key], value);
      }
      if (key === 'groups' && record(options) && Object.hasOwn(options, key)) {
        if (document !== undefined) {
          document.deleteIn(['options', key]);
        }
        patch(['agent', agent.name, 'options', key], undefined);
      }
    }
    if (document !== undefined && agent.markdown !== undefined) {
      const { file, prefix, body, eol } = agent.markdown;
      const text = prefix + document.toString({ lineWidth: 0 }).replaceAll('\n', eol) + body;
      parseAgent({ ...file, text });
      if (text !== file.text) {
        if (
          agent.component === true &&
          snapshot.agents.some((other) => other.name !== agent.name && other.markdown?.file.path === file.path)
        ) {
          throw new SettingsError(
            `Component source ${file.path} is shared by multiple agents. Edit its source directly to change inherited settings.`,
          );
        }
        const tracked = snapshot.files.find((source) => source.path === file.path);
        if (tracked?.writable === false) {
          throw new SettingsError(`Read-only component source ${file.path}. Edit its declaring document directly.`);
        }
        edits.push({ file: tracked ?? file, text });
      }
    }
  }
  parseConfig(configText);
  for (const edit of pending.values()) {
    parseCompositionDocument(edit.text, edit.file.path);
    if (edit.text !== edit.file.text) {
      edits.push(edit);
    }
  }
  if (configText !== snapshot.configFile.text) {
    edits.push({ file: snapshot.configFile, text: configText });
  }
  const description =
    change.kind === 'group'
      ? `Update defaults for ${change.name}`
      : change.kind === 'preset'
        ? `Update model preset ${change.name} and its linked groups`
        : change.kind === 'deletePreset'
          ? `Delete unused model preset ${change.name}`
          : change.kind === 'global'
            ? `Update ${change.field} and its linked groups`
            : change.kind === 'all'
              ? 'Update global defaults, presets, and groups; retain references and agent overrides'
              : change.kind === 'membership'
                ? `Set ${change.agent} groups to ${membershipGroups(change).length > 0 ? membershipGroups(change).join(' → ') : 'Ungrouped'}; retain model overrides`
                : `${change.choice.model !== undefined && change.choice.model !== '' ? 'Set an override for' : 'Use inherited defaults for'} ${change.agent}`;
  return { snapshot, change, edits, description };
}

export async function plannedChoices(
  plan: EditPlan,
  native: NativeModels = plan.snapshot.nativeModels,
): Promise<ModelChoice[]> {
  const { snapshot, change } = plan;
  const overlays = new Map(plan.edits.map((edit) => [edit.file.path, edit.text]));
  const sources = await loadCompositionSources(snapshot.sourceContext, overlays);
  const agents = Object.fromEntries(
    [...nativeAgentsFromLayers(snapshot.nativeLayers, overlays)].map(([name, agent]) => [name, agent.settings]),
  );
  const defaults =
    change.kind === 'global'
      ? { ...native, [change.field]: change.model }
      : change.kind === 'all'
        ? { model: change.choice.model, small_model: change.choice.model }
        : native;
  const resolved = await resolveProfileRuntime(sources, { ...defaults, agent: agents }, overlays);
  const choices: ModelChoice[] = Object.entries(resolved.choices)
    .filter(([name, choice]) => {
      const previous = Object.hasOwn(snapshot.resolved.choices, name) ? snapshot.resolved.choices[name] : undefined;
      const authored = snapshot.agents.find((agent) => agent.name === name)?.settings.model;
      return (
        typeof authored !== 'string' ||
        authored === '' ||
        choice.model !== previous?.model ||
        choice.variant !== previous?.variant
      );
    })
    .map(([, { model, variant }]) => ({ model, variant }));
  // Validate edited definitions even when no active profile currently consumes them.
  const settings = editorSettings(sources, defaults);
  if (change.kind === 'group') {
    const available = {
      ...Object.fromEntries(nativeAgentNames.map((name) => [name, {}])),
      ...agents,
      ...(await loadComponents(sources, agents, overlays)).agents,
    };
    resolveGroupAgentNames(change.name, sources.registry.componentGroups ?? {}, available);
  }
  if (change.kind === 'global') {
    choices.push({ model: change.model });
  }
  if (change.kind === 'preset' || change.kind === 'all' || change.kind === 'override') {
    choices.push(change.choice);
  }
  for (const name of affectedGroups(snapshot, change)) {
    const group = settings.groups[name] ?? {};
    const preset =
      group.modelRef?.startsWith('preset:') === true ? settings.modelPresets[group.modelRef.slice(7)] : undefined;
    choices.push({
      model:
        group.model ??
        preset?.model ??
        (group.modelRef === 'opencode:model'
          ? resolved.model
          : group.modelRef === 'opencode:small_model'
            ? resolved.small_model
            : undefined),
      variant: group.variant ?? preset?.variant,
    });
  }
  return choices;
}

async function atomicWrite(path: string, text: string, mode: number): Promise<void> {
  const temporary = join(dirname(path), `.config-composer-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', mode);
    try {
      await file.writeFile(text, 'utf8');
      // Creation applies the process umask; restore the original permissions before replacement.
      await file.chmod(mode);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function observedSourceList(snapshot: Snapshot): Promise<void> {
  const current = await loadSnapshot(
    snapshot.root,
    snapshot.sourceContext.root,
    snapshot.nativeModels,
    snapshot.nativeDirectory,
    snapshot.nativeWorktree,
  );
  if (
    current.files.length !== snapshot.files.length ||
    current.files.some((file) => !snapshot.files.some((old) => old.path === file.path))
  ) {
    throw new SettingsError(
      'The agent list changed: source list changed. Reopen the editor and review affected agents.',
    );
  }
}

export async function savePlan(plan: EditPlan, authorize?: () => Promise<() => void>): Promise<void> {
  if (plan.edits.length === 0) {
    return;
  }
  const lockPath = join(plan.snapshot.root, '.config-composer.lock');
  const lock = await open(lockPath, 'wx').catch(() => {
    throw new SettingsError('Another settings edit is active, or a stale .config-composer.lock needs attention.');
  });
  const applied: FileEdit[] = [];
  try {
    const assertAuthorized = await authorize?.();
    await observedComposition(plan.snapshot.sources);
    for (const original of plan.snapshot.files) {
      const current = await observedFile(plan.snapshot.root, original);
      if (current.text !== original.text) {
        throw new SettingsError('Settings changed while the dialog was open. Reopen it and try again.');
      }
    }
    // Detect newly added agents before approving a group-wide preview.
    await observedSourceList(plan.snapshot);
    await plannedChoices(plan);
    for (const edit of plan.edits) {
      if (edit.file.writable === false) {
        throw new SettingsError(`Read-only composition source ${edit.file.path}.`);
      }
      assertAuthorized?.();
      const before = await sourceFile(plan.snapshot.root, edit.file.path);
      if (before.text !== edit.file.text || before.writable === false) {
        throw new SettingsError('Settings changed or became read-only before saving. Reopen the editor.');
      }
      await atomicWrite(edit.file.path, edit.text, edit.file.mode);
      applied.push(edit);
    }
  } catch (error) {
    let incomplete = false;
    for (const edit of applied.reverse()) {
      try {
        if ((await readFile(edit.file.path, 'utf8')) !== edit.text) {
          incomplete = true;
          continue;
        }
        await atomicWrite(edit.file.path, edit.file.text, edit.file.mode);
      } catch {
        incomplete = true;
      }
    }
    if (incomplete) {
      throw new SettingsError(
        'Saving failed and rollback was incomplete. Review the affected settings files before continuing.',
      );
    }
    throw error;
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

export async function reloadConfiguration(
  snapshot: Snapshot,
  update: (plugins: unknown[]) => Promise<void>,
): Promise<void> {
  const lockPath = join(snapshot.root, '.config-composer.lock');
  const lock = await open(lockPath, 'wx').catch(() => {
    throw new SettingsError('Another settings edit is active. Reload after it finishes.');
  });
  try {
    await observedComposition(snapshot.sources);
    for (const file of snapshot.files) {
      if ((await observedFile(snapshot.root, file)).text !== file.text) {
        throw new SettingsError('Settings changed. Reopen the editor before reloading.');
      }
    }
    await observedSourceList(snapshot);
    const original = await sourceFile(snapshot.root, snapshot.configFile.path);
    if (original.text !== snapshot.configFile.text) {
      throw new SettingsError('Settings changed. Reopen the editor before reloading.');
    }
    if (!Array.isArray(snapshot.config.plugin)) {
      throw new SettingsError('Configure the Config Composer server plugin first.');
    }
    const entries: unknown[] = snapshot.config.plugin;
    const entry = entries[snapshot.pluginIndex];
    const token = randomUUID();
    const text =
      typeof entry === 'string'
        ? editJson(original.text, ['plugin', snapshot.pluginIndex], [entry, { reloadToken: token }])
        : editJson(original.text, ['plugin', snapshot.pluginIndex, 1, 'reloadToken'], token);
    const config = parseConfig(text);
    const apiText = original.path.endsWith('.jsonc')
      ? applyEdits(
          original.text,
          modify(original.text, ['plugin'], config.plugin, { formattingOptions: { insertSpaces: true, tabSize: 2 } }),
        )
      : JSON.stringify(config, null, 2);
    // The public API invalidates the global cache only after an actual configuration change.
    if (!Array.isArray(config.plugin)) {
      throw new SettingsError('Configure the Config Composer server plugin first.');
    }
    const plugins: unknown[] = config.plugin;
    await update(plugins);
    await observedComposition(snapshot.sources);
    for (const file of snapshot.files) {
      if (file.path !== original.path && (await observedFile(snapshot.root, file)).text !== file.text) {
        throw new SettingsError('Settings changed during reload. Reopen the editor and check the saved configuration.');
      }
    }
    const current = await sourceFile(snapshot.root, original.path);
    if (current.text !== apiText) {
      throw new SettingsError('Settings changed during reload. Reopen the editor and check the saved configuration.');
    }
    // The API replaces the plugin array. Restore its original comments and layout with
    // the same new token, after checking that no concurrent edit would be lost.
    await atomicWrite(original.path, text, original.mode);
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
