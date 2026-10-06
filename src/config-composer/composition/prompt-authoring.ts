import { type FilePlan, type Snapshot, collectFileReads, editJson, previewFilePlan } from '../storage.ts';
import { SettingsError, record } from '../settings.ts';
import { expandIncludes } from '../prompts.ts';
import { definitionDestinations } from './authoring.ts';
import { type ConfigurationTarget, configurationTargets, valueAt } from './parameter-authoring.ts';
import { parseCompositionDocument, readCompositionDocument } from './document.ts';
import type { PromptConfiguration } from './types.ts';

export type PromptChange =
  | { field: 'prepend' | 'append'; value?: string[] }
  | { field: 'inheritDefaults' | 'inheritGroups'; value?: boolean }
  | { field: 'reset' };

export const promptTargets = (snapshot: Snapshot, sourceId: string) =>
  configurationTargets(snapshot, sourceId).filter((target) => target.path[0] !== 'configurationPresets');

export function promptValue(snapshot: Snapshot, target: ConfigurationTarget): PromptConfiguration {
  const source = snapshot.sources.documents.find((source) => source.id === target.sourceId);
  const value = valueAt(source?.value, [...target.path, 'prompt']);
  return readCompositionDocument({ defaults: { agents: { prompt: value ?? {} } } }).defaults?.agents?.prompt ?? {};
}

export async function planPrompt(
  snapshot: Snapshot,
  target: ConfigurationTarget,
  change: PromptChange,
): Promise<FilePlan> {
  const selected = promptTargets(snapshot, target.sourceId).find(
    (item) => JSON.stringify(item.path) === JSON.stringify(target.path),
  );
  const file = definitionDestinations(snapshot).find((file) => file.path === target.sourceId);
  if (selected === undefined || file === undefined) {
    throw new SettingsError('Choose an available writable prompt destination and target.');
  }
  if (
    (change.field === 'inheritDefaults' || change.field === 'inheritGroups') &&
    ['defaults', 'componentGroups'].includes(target.path[0])
  ) {
    throw new SettingsError('Set inheritance controls on an agent component or an explicit agent override.');
  }
  const path = [...target.path, 'prompt', ...(change.field === 'reset' ? [] : [change.field])];
  const text = editJson(file.text, path, change.field === 'reset' ? undefined : change.value);
  const document = parseCompositionDocument(text, file.path);
  const plan: FilePlan = {
    snapshot,
    edits: text === file.text ? [] : [{ file, text }],
    description: `${selected.label}: ${change.field === 'reset' ? 'remove local prompt settings' : `${change.value === undefined ? 'remove local' : 'set'} ${change.field}`} in ${file.path}`,
  };
  const preview = await previewFilePlan(plan);
  const reads = collectFileReads(preview.reads);
  const configuration = valueAt(document, [...target.path, 'prompt']);
  if (record(configuration)) {
    const operations = readCompositionDocument({ defaults: { agents: { prompt: configuration } } }).defaults?.agents
      ?.prompt;
    // Validate authored fragments even when the target is inactive or its native prompt body is unavailable.
    await expandIncludes(
      [...(operations?.prepend ?? []), ...(operations?.append ?? [])]
        .map((text) => (/^@[a-z][a-z0-9-]*\//.test(text) ? `{{include:${text}}}` : text))
        .join('\n\n'),
      preview.sources.registry.sourceDirectories ?? {},
      reads.read,
      new Map(plan.edits.map((edit) => [edit.file.path, edit.text])),
    );
  }
  return { ...plan, reads: reads.files };
}

export function promptReview(snapshot: Snapshot, preview: Awaited<ReturnType<typeof previewFilePlan>>): string {
  const changed = Object.entries(preview.resolved.agent).filter(
    ([name, value]) =>
      value.prompt !==
      (Object.hasOwn(snapshot.resolved.agent, name) ? snapshot.resolved.agent[name].prompt : undefined),
  );
  const result =
    changed.length === 0
      ? 'No effective authored agent prompts change. This target may be inactive or masked by inheritance controls. Native prompts without an authored body remain unchanged.'
      : changed
          .map(([name, value]) => {
            const text = typeof value.prompt === 'string' ? value.prompt : '(native prompt fallback)';
            return `${name}:\n${text.slice(0, 1600)}${text.length > 1600 ? '\n… (truncated)' : ''}`;
          })
          .join('\n\n');
  return `${result}\n\nIncluded files: ${preview.reads.length === 0 ? 'none' : preview.reads.map((file) => file.path).join(', ')}`;
}
