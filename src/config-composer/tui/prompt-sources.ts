import type { TuiDialogSelectOption } from '@opencode-ai/plugin/tui';
import type { Snapshot } from '../storage.ts';
import { definitionDestinations } from '../composition/authoring.ts';
import { valueAt } from '../composition/parameter-authoring.ts';
import { type PromptAssetChange, type PromptRegistry, promptAssetSource } from '../composition/prompt-sources.ts';

type Action = TuiDialogSelectOption<string> & { run: () => void | Promise<void> };
interface AssetUi {
  menu: (title: string, actions: Action[] | (() => Action[])) => void;
  prompt: (title: string, value: string, confirmed: (value: string) => void | Promise<void>) => void;
  alert: (title: string, message: string) => void;
  back: () => void;
  propose: (change: PromptAssetChange) => Promise<void>;
  references: (agent: string, references: string[] | undefined) => Promise<void>;
}
export function openPromptSources(snapshot: Snapshot, ui: AssetUi): void {
  const define = (registry: PromptRegistry, name: string, sourceId?: string) => {
    const declaring = sourceId ?? promptAssetSource(snapshot, registry, name);
    const source = snapshot.sources.documents.find((source) => source.id === declaring);
    const path = registry === 'prompts' ? ['components', 'prompts', name] : [registry, name];
    const save = (value: unknown) =>
      ui.propose(
        sourceId === undefined
          ? { operation: 'set', registry, name, value }
          : { operation: 'create', registry, name, sourceId, value },
      );
    if (registry === 'sourceDirectories') {
      const current = valueAt(source?.value, path);
      ui.prompt(`Directory path, relative to ${declaring}`, typeof current === 'string' ? current : '', save);
    } else {
      ui.menu(
        'Prompt content source',
        ['text', 'file'].map((field) => ({
          title: field === 'text' ? 'Inline multiline content' : 'Declared file path',
          value: field,
          description: field === 'text' ? 'Include markers are supported' : `Relative paths belong to ${declaring}`,
          run: () => {
            const current = valueAt(source?.value, [...path, field]);
            ui.prompt(
              field === 'text' ? 'Multiline prompt content' : `Prompt file relative to ${declaring}`,
              typeof current === 'string' ? current : '',
              (value) => save({ [field]: value }),
            );
          },
        })),
      );
    }
  };
  const assets = (registry: PromptRegistry) => {
    const entries =
      registry === 'prompts'
        ? (snapshot.sources.registry.components?.prompts ?? {})
        : (snapshot.sources.registry.sourceDirectories ?? {});
    ui.menu(registry === 'prompts' ? 'Reusable prompt components' : 'Include source aliases', [
      {
        title: 'Create definition…',
        value: '+create',
        run: () =>
          ui.prompt('Definition name', '', (name) =>
            ui.menu(
              'Explicit JSONC destination',
              definitionDestinations(snapshot).map((file) => ({
                title: file.path,
                value: file.path,
                run: () => define(registry, name, file.path),
              })),
            ),
          ),
      },
      ...Object.keys(entries).map((name) => ({
        title: name,
        value: `asset:${name}`,
        description: promptAssetSource(snapshot, registry, name),
        run: () => {
          const source = promptAssetSource(snapshot, registry, name);
          ui.menu(`${name}: declaring definition`, [
            {
              title: 'Inspect source and resolved path',
              value: 'inspect',
              description: source,
              run: () =>
                ui.alert(
                  name,
                  `${source}\n\n${JSON.stringify(entries[name], null, 2)}\n\nChanges edit this declaring definition. Use agent/group prompt operations for scoped contributions.`,
                ),
            },
            { title: 'Edit content or path…', value: 'edit', description: source, run: () => define(registry, name) },
            {
              title: 'Rename with reference review…',
              value: 'rename',
              run: () =>
                ui.prompt('New definition name', name, (nextName) =>
                  ui.propose({ registry, name, operation: 'rename', nextName }),
                ),
            },
            {
              title: 'Delete unused definition…',
              value: 'delete',
              run: () => ui.propose({ registry, name, operation: 'delete' }),
            },
          ]);
        },
      })),
    ]);
  };
  const references = (agent: string) => {
    const current = snapshot.sources.registry.components?.agents?.[agent];
    const pending = [...(current?.promptRefs ?? [])];
    ui.menu(`${agent}: ordered prompt references`, () => [
      { title: 'Save ordered references…', value: '+save', run: () => ui.references(agent, [...pending]) },
      ...pending.map((name, index) => ({
        title: `${index + 1}. ${name}`,
        value: String(index),
        run: () =>
          ui.menu(`Reference ${index + 1}: ${name}`, [
            ...(index === 0
              ? []
              : [
                  {
                    title: 'Move earlier',
                    value: 'earlier',
                    run: () => {
                      pending.splice(index, 1);
                      pending.splice(index - 1, 0, name);
                      ui.back();
                    },
                  },
                ]),
            ...(index === pending.length - 1
              ? []
              : [
                  {
                    title: 'Move later',
                    value: 'later',
                    run: () => {
                      pending.splice(index, 1);
                      pending.splice(index + 1, 0, name);
                      ui.back();
                    },
                  },
                ]),
            {
              title: 'Remove reference',
              value: 'remove',
              run: () => {
                pending.splice(index, 1);
                ui.back();
              },
            },
          ]),
      })),
      {
        title: 'Append reusable prompt',
        value: '+add',
        run: () =>
          ui.menu(
            'Prompt component',
            Object.keys(snapshot.sources.registry.components?.prompts ?? {}).map((name) => ({
              title: name,
              value: `prompt:${name}`,
              run: () => {
                pending.push(name);
                ui.back();
              },
            })),
          ),
      },
      { title: 'Reset declared references…', value: '+reset', run: () => ui.references(agent, undefined) },
    ]);
  };
  ui.menu('Prompt components and source aliases', [
    { title: 'Reusable prompt components', value: 'prompts', run: () => assets('prompts') },
    { title: 'Include source aliases', value: 'sourceDirectories', run: () => assets('sourceDirectories') },
    {
      title: 'Ordered agent prompt references',
      value: 'references',
      run: () =>
        ui.menu(
          'Composer agent component',
          Object.keys(snapshot.sources.registry.components?.agents ?? {}).map((name) => ({
            title: name,
            value: `agent:${name}`,
            description: 'Append reusable prompt bodies in order after the authored base body',
            run: () => references(name),
          })),
        ),
    },
    {
      title: 'Include syntax and limits',
      value: 'limits',
      run: () =>
        ui.alert(
          'Include syntax and limits',
          'Use {{include:@alias/path.md}} or a contained .txt file. A whole @alias/path.md shorthand is available in prompt operations. Escape a literal marker with a backslash.\n\nLimits: 64 KiB per included snippet, 256 KiB per composed prompt, 32 nested includes, 256 expansions. Escaping paths, cycles, invalid UTF-8 and NUL bytes are rejected.\n\nReference review covers loaded definitions, declared files, native agent bodies, and their nested includes. No directories are scanned for additional consumers. Referenced Markdown bodies must be edited at their declaring source before alias rename/deletion.',
        ),
    },
  ]);
}
