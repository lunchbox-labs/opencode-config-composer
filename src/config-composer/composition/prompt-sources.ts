import { realpath, stat } from 'node:fs/promises';
import { findNodeAtLocation, parseTree } from 'jsonc-parser';
import { configurationFile } from '../configuration.ts';
import { expandIncludes } from '../prompts.ts';
import { SettingsError, record } from '../settings.ts';
import {
  type FilePlan,
  type Snapshot,
  type SourceFile,
  collectFileReads,
  editJson,
  parseAgent,
  parseConfig,
  previewFilePlan,
} from '../storage.ts';
import { definitionDestinations } from './authoring.ts';
import { parseCompositionDocument, readCompositionDocument } from './document.ts';
import type { LoadedSources } from './sources.ts';
import type { PromptConfiguration } from './types.ts';

export type PromptRegistry = 'prompts' | 'sourceDirectories';
export type PromptAssetChange = { registry: PromptRegistry; name: string } & (
  | { operation: 'create'; sourceId: string; value: unknown }
  | { operation: 'set'; value: unknown }
  | { operation: 'rename'; nextName: string }
  | { operation: 'delete' }
);
export interface PromptAssetPlan extends FilePlan {
  consumers: string[];
  alias?: string;
}
interface TextEntry {
  file: SourceFile;
  path: (string | number)[];
  text: string;
  editable: boolean;
  shorthand?: boolean;
}
const part = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1');
const pointer = (path: (string | number)[]) => `/${path.map((key) => part(String(key))).join('/')}`;
const assetPath = (registry: PromptRegistry, name: string) =>
  registry === 'prompts' ? ['components', 'prompts', name] : [registry, name];
const definitions = (sources: LoadedSources, registry: PromptRegistry) =>
  registry === 'prompts' ? (sources.registry.components?.prompts ?? {}) : (sources.registry.sourceDirectories ?? {});

export function promptAssetSource(snapshot: Snapshot, registry: PromptRegistry, name: string): string {
  const key = pointer(assetPath(registry, name));
  const id = Object.hasOwn(snapshot.sources.provenance, key) ? snapshot.sources.provenance[key].sourceId : undefined;
  if (id === undefined) {
    throw new SettingsError('The declaring prompt source is unavailable. Reopen the editor.');
  }
  return id;
}
function sourceFile(snapshot: Snapshot, id: string): SourceFile {
  const file = snapshot.files.find((file) => file.path === id);
  if (file === undefined) {
    throw new SettingsError(`The declaring source ${id} is unavailable. Reopen the editor.`);
  }
  return file;
}
function validateName(registry: PromptRegistry, name: string): void {
  readCompositionDocument(
    registry === 'prompts'
      ? { components: { prompts: { [name]: { text: '' } } } }
      : { sourceDirectories: { [name]: './prompts' } },
  );
}
function rewriteAlias(
  text: string,
  previous: string,
  next: string,
  shorthand = false,
): { text: string; matched: boolean } {
  let matched = false;
  if (shorthand && text.startsWith(`@${previous}/`)) {
    matched = true;
    text = `@${next}/${text.slice(previous.length + 2)}`;
  }
  text = text.replace(/\\?\{\{include:([^{}]*)\}\}/g, (marker: string, reference: string) => {
    if (marker.startsWith('\\') || !reference.startsWith(`@${previous}/`)) {
      return marker;
    }
    matched = true;
    return `{{include:@${next}/${reference.slice(previous.length + 2)}}}`;
  });
  return { text, matched };
}
function jsonTexts(snapshot: Snapshot, sources: LoadedSources): TextEntry[] {
  const entries: TextEntry[] = [];
  for (const source of sources.documents) {
    const file = sourceFile(snapshot, source.id);
    const add = (path: (string | number)[], text: string | undefined, shorthand = false) => {
      if (text !== undefined) {
        entries.push({ file, path, text, shorthand, editable: true });
      }
    };
    const prompt = (path: string[], value: PromptConfiguration | undefined) => {
      for (const field of ['prepend', 'append'] as const) {
        for (const [index, text] of (value?.[field] ?? []).entries()) {
          add([...path, 'prompt', field, index], text, true);
        }
      }
    };
    const value = source.value;
    prompt(['defaults', 'agents'], value.defaults?.agents?.prompt);
    for (const [name, group] of Object.entries(value.componentGroups ?? {})) {
      prompt(['componentGroups', name, 'configuration'], group.configuration?.prompt);
    }
    for (const [name, agent] of Object.entries(value.overrides?.agents ?? {})) {
      prompt(['overrides', 'agents', name], agent.prompt);
    }
    for (const [profile, item] of Object.entries(value.profiles ?? {})) {
      for (const [name, agent] of Object.entries(item.overrides?.agents ?? {})) {
        prompt(['profiles', profile, 'overrides', 'agents', name], agent.prompt);
      }
    }
    for (const [name, agent] of Object.entries(value.components?.agents ?? {})) {
      add(['components', 'agents', name, 'prompt'], agent.prompt, true);
      prompt(['components', 'agents', name, 'configuration'], agent.configuration?.prompt);
    }
    for (const [name, prompt] of Object.entries(value.components?.prompts ?? {})) {
      add(['components', 'prompts', name, 'text'], prompt.text);
    }
    for (const [name, command] of Object.entries(value.components?.commands ?? {})) {
      add(['components', 'commands', name, 'template'], command.template);
    }
  }
  return entries;
}
async function promptTexts(
  plan: FilePlan,
  sources: LoadedSources,
  read: (file: SourceFile) => void,
): Promise<TextEntry[]> {
  const entries = jsonTexts(plan.snapshot, sources);
  const nativeOrigins = new Map<string, SourceFile>();
  for (const layer of plan.snapshot.nativeLayers) {
    if (layer.kind === 'markdown' && layer.name !== undefined) {
      nativeOrigins.set(layer.name, layer.file);
    } else if (layer.kind === 'config') {
      const config = parseConfig(plan.snapshot.nativeVariables.documents.get(layer.file.path) ?? layer.file.text);
      for (const [name, agent] of Object.entries(record(config.agent) ? config.agent : {})) {
        if (record(agent) && typeof agent.prompt === 'string') {
          nativeOrigins.set(name, layer.file);
        }
      }
    }
  }
  for (const [name, agent] of Object.entries(plan.snapshot.nativeAgents)) {
    if (typeof agent.prompt !== 'string') {
      continue;
    }
    const file = nativeOrigins.get(name) ?? plan.snapshot.configFile;
    entries.push({ file, path: ['agent', name, 'prompt'], text: agent.prompt, editable: false, shorthand: true });
  }
  for (const kind of ['agents', 'skills', 'commands', 'prompts'] as const) {
    for (const [name, value] of Object.entries<{ file?: string }>(sources.registry.components?.[kind] ?? {})) {
      if (value.file === undefined) {
        continue;
      }
      const canonicalPath = await realpath(value.file);
      const file = { ...(await configurationFile(canonicalPath)), path: value.file, canonicalPath, writable: false };
      read(file);
      const edit = plan.edits.find(
        (edit) => edit.file.path === value.file || edit.file.canonicalPath === canonicalPath,
      );
      const text = edit?.text ?? file.text;
      entries.push({
        file,
        path: ['components', kind, name],
        text:
          kind === 'prompts'
            ? text
            : parseAgent({ ...file, text })
                .body.replace(/^---\s*(?:\n|$)/, '')
                .trim(),
        editable: false,
        shorthand: kind === 'agents',
      });
    }
  }
  return entries;
}
async function references(
  plan: PromptAssetPlan,
  registry: PromptRegistry,
  name: string,
  sources = plan.snapshot.sources,
): Promise<TextEntry[]> {
  const result = new Map<string, TextEntry>();
  const add = (entry: TextEntry) => result.set(`${entry.file.path}#${pointer(entry.path)}`, entry);
  if (registry === 'prompts') {
    for (const source of plan.snapshot.sources.documents) {
      const file = sourceFile(plan.snapshot, source.id);
      for (const [agent, value] of Object.entries(source.value.components?.agents ?? {})) {
        for (const [index, ref] of (value.promptRefs ?? []).entries()) {
          if (ref === name) {
            add({ file, path: ['components', 'agents', agent, 'promptRefs', index], text: ref, editable: true });
          }
        }
      }
      for (const [group, value] of Object.entries(source.value.componentGroups ?? {})) {
        for (const [index, ref] of (value.prompts ?? []).entries()) {
          if (ref === name) {
            add({ file, path: ['componentGroups', group, 'prompts', index], text: ref, editable: true });
          }
        }
      }
    }
  } else {
    const reads = collectFileReads(plan.reads);
    plan.reads = reads.files;
    const entries = await promptTexts(plan, sources, reads.read);
    for (const entry of entries) {
      if (rewriteAlias(entry.text, name, name, entry.shorthand).matched) {
        add(entry);
      }
      await expandIncludes(
        entry.shorthand === true && /^@[a-z][a-z0-9-]*\//.test(entry.text) ? `{{include:${entry.text}}}` : entry.text,
        sources.registry.sourceDirectories ?? {},
        (file) => {
          reads.read(file);
          if (rewriteAlias(file.text, name, name).matched) {
            add({ file, path: [], text: file.text, editable: false });
          }
        },
      );
    }
  }
  return [...result.values()];
}

export async function validatePromptAssets(plan: PromptAssetPlan) {
  let preview = await previewFilePlan(plan);
  const reads = collectFileReads(plan.reads);
  plan.reads = reads.files;
  if (plan.alias !== undefined) {
    const path = preview.sources.registry.sourceDirectories?.[plan.alias];
    if (path === undefined) {
      throw new SettingsError('The selected prompt source alias is unavailable.');
    }
    const canonicalPath = await realpath(path).catch(() => undefined);
    if (canonicalPath === undefined || !(await stat(canonicalPath)).isDirectory()) {
      throw new SettingsError(`Prompt source ${plan.alias} must name an existing directory.`);
    }
    const previous = plan.directories?.find((directory) => directory.path === path);
    if (previous !== undefined && previous.canonicalPath !== canonicalPath) {
      throw new SettingsError('The selected prompt source directory changed. Reopen the editor.');
    }
    if (previous === undefined) {
      (plan.directories ??= []).push({ path, canonicalPath });
    }
  }
  for (const entry of await promptTexts(plan, preview.sources, reads.read)) {
    await expandIncludes(
      entry.shorthand === true && /^@[a-z][a-z0-9-]*\//.test(entry.text) ? `{{include:${entry.text}}}` : entry.text,
      preview.sources.registry.sourceDirectories ?? {},
      reads.read,
    );
  }
  preview = await previewFilePlan(plan);
  return preview;
}

export async function planPromptAsset(snapshot: Snapshot, change: PromptAssetChange): Promise<PromptAssetPlan> {
  validateName(change.registry, change.name);
  const all = definitions(snapshot.sources, change.registry);
  const exists = Object.hasOwn(all, change.name);
  if (change.operation === 'create' ? exists : !exists) {
    throw new SettingsError(
      exists ? 'That prompt definition already exists.' : 'That prompt definition is unavailable.',
    );
  }
  const sourceId =
    change.operation === 'create' ? change.sourceId : promptAssetSource(snapshot, change.registry, change.name);
  const file = definitionDestinations(snapshot).find((file) => file.path === sourceId);
  if (file === undefined) {
    throw new SettingsError(`Choose a writable declaring JSONC source; ${sourceId} is read-only or unavailable.`);
  }
  const plan: PromptAssetPlan = {
    snapshot,
    edits: [],
    description: `${change.operation} ${pointer(assetPath(change.registry, change.name))} in ${file.path}`,
    consumers: [],
  };
  const pending = new Map<string, { file: SourceFile; text: string }>();
  const editable = (file: SourceFile) => {
    if (file.writable === false) {
      throw new SettingsError(`Read-only reference in ${file.path}. Edit its declaring source first.`);
    }
    let edit = pending.get(file.path);
    if (edit === undefined) {
      edit = { file, text: file.text };
      pending.set(file.path, edit);
    }
    return edit;
  };
  const entry = editable(file);
  const path = assetPath(change.registry, change.name);
  const refs =
    change.operation === 'create' || (change.registry === 'sourceDirectories' && change.operation === 'set')
      ? []
      : await references(plan, change.registry, change.name);
  plan.consumers = refs.map((ref) => `${ref.file.path}#${pointer(ref.path)}`);
  if (change.operation === 'rename') {
    validateName(change.registry, change.nextName);
    if (Object.hasOwn(all, change.nextName)) {
      throw new SettingsError('That prompt definition already exists.');
    }
    const tree = parseTree(entry.text);
    const key = tree === undefined ? undefined : findNodeAtLocation(tree, path)?.parent?.children?.[0];
    if (key === undefined) {
      throw new SettingsError('The definition key changed. Reopen the editor.');
    }
    entry.text =
      entry.text.slice(0, key.offset) + JSON.stringify(change.nextName) + entry.text.slice(key.offset + key.length);
    for (const ref of refs) {
      if (!ref.editable) {
        throw new SettingsError(
          `Reference in ${ref.file.path}#${pointer(ref.path)} requires editing its declaring Markdown or native source before renaming. File bodies are retained.`,
        );
      }
      const target = editable(ref.file);
      const refPath = [...ref.path];
      if (ref.file.path === file.path && path.every((key, index) => refPath[index] === key)) {
        refPath[path.length - 1] = change.nextName;
      }
      target.text = editJson(
        target.text,
        refPath,
        change.registry === 'prompts'
          ? change.nextName
          : rewriteAlias(ref.text, change.name, change.nextName, ref.shorthand).text,
      );
    }
    if (change.registry === 'sourceDirectories') {
      plan.alias = change.nextName;
    }
    plan.description += ` → ${change.nextName}`;
  } else if (change.operation === 'delete') {
    if (refs.length > 0) {
      throw new SettingsError(
        `Definition ${change.name} is referenced by ${plan.consumers.join(', ')}. Reassign those references first.`,
      );
    }
    entry.text = editJson(entry.text, path, undefined);
  } else {
    readCompositionDocument(
      change.registry === 'prompts'
        ? { components: { prompts: { [change.name]: change.value } } }
        : { sourceDirectories: { [change.name]: change.value } },
    );
    if (change.registry === 'prompts' && change.operation === 'set') {
      const prompt = readCompositionDocument({ components: { prompts: { [change.name]: change.value } } }).components
        ?.prompts?.[change.name];
      if (prompt === undefined) {
        throw new SettingsError('Choose a valid prompt component.');
      }
      const field = prompt.file === undefined ? 'text' : 'file';
      entry.text = editJson(entry.text, [...path, field === 'text' ? 'file' : 'text'], undefined);
      entry.text = editJson(entry.text, [...path, field], prompt[field]);
    } else {
      entry.text = editJson(entry.text, path, change.value);
    }
    if (change.registry === 'sourceDirectories') {
      plan.alias = change.name;
    }
  }
  plan.edits = [...pending.values()].filter((edit) => edit.file.text !== edit.text);
  for (const edit of plan.edits) {
    parseCompositionDocument(edit.text, edit.file.path);
  }
  if (change.registry === 'sourceDirectories' && change.operation === 'set') {
    const preview = await previewFilePlan(plan);
    plan.consumers = (await references(plan, change.registry, change.name, preview.sources)).map(
      (ref) => `${ref.file.path}#${pointer(ref.path)}`,
    );
  }
  await validatePromptAssets(plan);
  return plan;
}

export async function planPromptReferences(
  snapshot: Snapshot,
  agent: string,
  references: string[] | undefined,
): Promise<PromptAssetPlan> {
  if (!Object.hasOwn(snapshot.sources.registry.components?.agents ?? {}, agent)) {
    throw new SettingsError('Choose a Composer agent component for reusable prompt references.');
  }
  const id = snapshot.sources.provenance[`/components/agents/${part(agent)}`].sourceId;
  const file = definitionDestinations(snapshot).find((file) => file.path === id);
  if (file === undefined) {
    throw new SettingsError('The declaring agent component source is read-only.');
  }
  const text = editJson(file.text, ['components', 'agents', agent, 'promptRefs'], references);
  parseCompositionDocument(text, file.path);
  const plan: PromptAssetPlan = {
    snapshot,
    edits: text === file.text ? [] : [{ file, text }],
    consumers: [`${file.path}#/components/agents/${part(agent)}/promptRefs`],
    description: `${agent}: ${references === undefined ? 'remove local' : 'set ordered'} prompt references in ${file.path}`,
  };
  await validatePromptAssets(plan);
  return plan;
}
