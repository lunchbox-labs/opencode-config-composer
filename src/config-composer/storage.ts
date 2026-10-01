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
  readSettings,
  record,
  resolveChoice,
  resolveGroup,
} from './settings.ts';
import { loadConfiguration } from './configuration.ts';
import { packageName } from './package-name.ts';

export interface SourceFile {
  path: string;
  text: string;
  mode: number;
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

async function sourceFile(root: string, path: string): Promise<SourceFile> {
  const info = await lstat(path);
  const rel = relative(root, await realpath(path));
  if (!info.isFile() || info.isSymbolicLink() || rel.startsWith('..') || isAbsolute(rel) || info.size > 2_000_000) {
    throw new SettingsError('Settings must be regular files inside this configuration directory, under 2 MB each.');
  }
  return { path, text: await readFile(path, 'utf8'), mode: info.mode & 0o777 };
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

export async function loadSnapshot(directory: string): Promise<Snapshot> {
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
  const loaded = await loadConfiguration(pluginOptions(config, pluginIndex), root);
  const settingsFile = await sourceFile(root, loaded.file.path);
  if (settingsFile.text !== loaded.file.text) {
    throw new SettingsError('Config Composer settings changed while loading. Reopen the editor.');
  }
  const { groups, modelPresets } = loaded.settings;
  const jsonAgents = record(config.agent) ? config.agent : {};
  const agents = new Map<string, StoredAgent>(
    Object.entries(jsonAgents).map(([name, value]) => {
      if (!record(value)) {
        throw new SettingsError('An agent configuration must be an object.');
      }
      return [name, { name, settings: value }];
    }),
  );
  const files = [configFile, settingsFile];
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
      const markdown = parseAgent(file);
      const value: unknown = markdown.document.toJS({ maxAliasCount: 0 });
      if (!record(value)) {
        throw new SettingsError('Fix invalid agent frontmatter before editing settings.');
      }
      const frontmatter: AgentSettings = value;
      // OpenCode allows name overrides, but file-based edits must have an unambiguous identity.
      if (frontmatter.name !== undefined && frontmatter.name !== name) {
        throw new SettingsError('The editor requires agent names to match their relative Markdown filenames.');
      }
      const previous = agents.get(name)?.settings ?? {};
      agents.set(name, {
        name,
        markdown,
        settings: { ...previous, ...frontmatter, options: { ...previous.options, ...frontmatter.options } },
      });
      files.push(file);
    }
  }
  for (const dir of ['agents', 'agent']) {
    if (entries.includes(dir)) {
      await scan(join(root, dir), join(root, dir));
    }
  }
  const enabled = [...agents.values()]
    .filter((agent) => agent.settings.disable !== true)
    .sort((a, b) => a.name.localeCompare(b.name));
  enabled.forEach((agent) => agentGroups(agent.settings));
  return {
    root,
    configFile,
    config,
    settingsFile,
    settings: loaded.settings,
    pluginIndex,
    groups,
    modelPresets,
    agents: enabled,
    files,
  };
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
  let settingsText = snapshot.settingsFile.text;
  const edits: FileEdit[] = [];
  const patch = (path: (string | number)[], value: unknown) => {
    configText = editJson(configText, path, value);
  };
  const patchSettings = (path: (string | number)[], value: unknown) => {
    settingsText = editJson(settingsText, path, value);
  };
  const groupPath = ['agent', 'groups'];
  const presetPath = ['agent', 'modelPresets'];
  const patchGroup = (name: string, value: GroupChoice) => {
    const choice = groupChoice(value);
    if (!Object.hasOwn(snapshot.groups, name)) {
      patchSettings([...groupPath, name], choice);
      return;
    }
    for (const field of ['model', 'modelRef', 'variant'] as const) {
      patchSettings([...groupPath, name, field], choice[field]);
    }
    if (choice.prompt !== undefined) {
      patchSettings([...groupPath, name, 'prompt'], choice.prompt);
    }
  };
  if (change.kind === 'group') {
    patchGroup(groupName(change.name), change.choice);
  } else if (change.kind === 'preset') {
    const choice = modelChoice(change.choice);
    if (choice.model === undefined || choice.model === '') {
      throw new SettingsError('A model preset requires a concrete model.');
    }
    patchSettings([...presetPath, presetName(change.name)], choice);
  } else if (change.kind === 'deletePreset') {
    const name = presetName(change.name);
    if (!Object.hasOwn(snapshot.modelPresets, name)) {
      throw new SettingsError('That model preset no longer exists.');
    }
    if (affectedGroups(snapshot, change).length > 0) {
      throw new SettingsError('This preset is referenced by groups. Reassign those groups before deleting it.');
    }
    patchSettings([...presetPath, name], undefined);
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
      patchSettings([...presetPath, name], choice);
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
    const values: Record<string, unknown> =
      change.kind === 'membership'
        ? { groups: membershipGroups(change) }
        : { model: modelChoice(change.choice).model, variant: change.choice.variant };
    if (change.kind === 'override' && (change.choice.model === undefined || change.choice.model === '')) {
      values.variant = undefined;
    }
    const document = agent.markdown?.document.clone();
    const options: unknown = agent.settings.options;
    if (change.kind === 'membership') {
      for (const name of membershipGroups(change)) {
        if (!Object.hasOwn(snapshot.groups, name)) {
          patchSettings([...groupPath, name], {});
        }
      }
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
        edits.push({ file, text });
      }
    }
  }
  parseConfig(configText);
  readSettings(parseConfig(settingsText));
  if (settingsText !== snapshot.settingsFile.text) {
    edits.push({ file: snapshot.settingsFile, text: settingsText });
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

export function plannedChoices(plan: EditPlan, native: NativeModels = plan.snapshot.config): ModelChoice[] {
  const { snapshot, change } = plan;
  const text = plan.edits.find((edit) => edit.file.path === snapshot.configFile.path)?.text ?? snapshot.configFile.text;
  parseConfig(text);
  const settingsText =
    plan.edits.find((edit) => edit.file.path === snapshot.settingsFile.path)?.text ?? snapshot.settingsFile.text;
  const { groups, modelPresets } = readSettings(parseConfig(settingsText));
  // Validate a changed global value for all consumers, even when this workspace has an override.
  const defaults =
    change.kind === 'global'
      ? { ...native, [change.field]: change.model }
      : change.kind === 'all'
        ? { model: change.choice.model, small_model: change.choice.model }
        : native;
  const context = { native: defaults, modelPresets };
  if (change.kind === 'deletePreset') {
    return [];
  }
  if (change.kind === 'membership' || change.kind === 'override') {
    const agent = snapshot.agents.find((item) => item.name === change.agent);
    if (agent === undefined) {
      throw new SettingsError('That agent is no longer available. Reopen the editor.');
    }
    if (change.kind === 'membership' && typeof agent.settings.model === 'string' && agent.settings.model !== '') {
      return [];
    }
    const settings =
      change.kind === 'override'
        ? { ...agent.settings, model: change.choice.model, variant: change.choice.variant }
        : {
            ...agent.settings,
            groups: membershipGroups(change),
            options: { ...agent.settings.options, groups: undefined },
          };
    return [resolveChoice(settings, groups, context)];
  }
  const affected = affectedGroups(snapshot, change);
  const choices: ModelChoice[] = affected.map((name) => resolveGroup(groups[name] ?? {}, context));
  for (const agent of snapshot.agents) {
    if (
      (typeof agent.settings.model !== 'string' || agent.settings.model === '') &&
      agentGroups(agent.settings).some((group) => affected.includes(group))
    ) {
      choices.push(resolveChoice(agent.settings, groups, context));
    }
  }
  if (change.kind === 'global') {
    choices.push({ model: change.model });
  }
  if (change.kind === 'preset' || change.kind === 'all') {
    choices.push(change.choice);
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
    for (const original of plan.snapshot.files) {
      const current = await sourceFile(plan.snapshot.root, original.path);
      if (current.text !== original.text) {
        throw new SettingsError('Settings changed while the dialog was open. Reopen it and try again.');
      }
    }
    // Detect newly added agents before approving a group-wide preview.
    const current = await loadSnapshot(plan.snapshot.root);
    if (
      current.files.length !== plan.snapshot.files.length ||
      current.files.some((file) => !plan.snapshot.files.some((old) => old.path === file.path))
    ) {
      throw new SettingsError('The agent list changed. Reopen the editor and review the affected agents.');
    }
    for (const edit of plan.edits) {
      assertAuthorized?.();
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
    for (const file of snapshot.files) {
      if ((await sourceFile(snapshot.root, file.path)).text !== file.text) {
        throw new SettingsError('Settings changed. Reopen the editor before reloading.');
      }
    }
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
    for (const file of snapshot.files) {
      if (file.path !== original.path && (await sourceFile(snapshot.root, file.path)).text !== file.text) {
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
