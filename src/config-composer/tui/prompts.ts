import type { TuiDialogSelectOption } from '@opencode-ai/plugin/tui';
import type { Snapshot } from '../storage.ts';
import { definitionDestinations } from '../composition/authoring.ts';
import type { ConfigurationTarget } from '../composition/parameter-authoring.ts';
import { type PromptChange, promptTargets, promptValue } from '../composition/prompt-authoring.ts';

type Action = TuiDialogSelectOption<string> & { run: () => void | Promise<void> };
interface PromptUi {
  menu: (title: string, actions: Action[] | (() => Action[])) => void;
  prompt: (title: string, value: string, confirmed: (value: string) => void | Promise<void>) => void;
  back: () => void;
  propose: (target: ConfigurationTarget, change: PromptChange) => Promise<void>;
}

export function openPrompts(snapshot: Snapshot, ui: PromptUi): void {
  const fragments = (target: ConfigurationTarget, field: 'prepend' | 'append') => {
    const pending = [...(promptValue(snapshot, target)[field] ?? [])];
    ui.menu(`${target.label}: ${field} fragments`, () => [
      {
        title: 'Save ordered fragments…',
        value: '+save',
        run: () => ui.propose(target, { field, value: [...pending] }),
      },
      ...pending.map((text, index) => ({
        title: `${index + 1}. ${text.slice(0, 100).replaceAll('\n', ' ↵ ')}`,
        value: String(index),
        run: () =>
          ui.menu(`Fragment ${index + 1}`, [
            {
              title: 'Edit multiline text or include',
              value: 'edit',
              run: () =>
                ui.prompt('Prompt text: multiline and {{include:@source/file.md}} supported', text, (value) => {
                  pending[index] = value;
                  ui.back();
                  ui.back();
                }),
            },
            ...(index === 0
              ? []
              : [
                  {
                    title: 'Move earlier',
                    value: 'earlier',
                    run: () => {
                      pending.splice(index, 1);
                      pending.splice(index - 1, 0, text);
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
                      pending.splice(index + 1, 0, text);
                      ui.back();
                    },
                  },
                ]),
            {
              title: 'Remove fragment',
              value: 'remove',
              run: () => {
                pending.splice(index, 1);
                ui.back();
              },
            },
          ]),
      })),
      {
        title: 'Add multiline fragment or include',
        value: '+add',
        run: () =>
          ui.prompt('Prompt text: multiline and {{include:@source/file.md}} supported', '', (text) => {
            pending.push(text);
            ui.back();
          }),
      },
      {
        title: 'Remove this local operation…',
        value: '+inherit',
        description: 'Remove this source’s ordered list; earlier contributions remain available',
        run: () => ui.propose(target, { field }),
      },
    ]);
  };
  const edit = (target: ConfigurationTarget) => {
    const current = promptValue(snapshot, target);
    ui.menu(`${target.label}: prompt operations`, [
      ...(['prepend', 'append'] as const).map((field) => ({
        title: `Ordered ${field} fragments`,
        value: field,
        description: `${current[field]?.length ?? 0} fragments saved here`,
        run: () => fragments(target, field),
      })),
      ...(['defaults', 'componentGroups'].includes(target.path[0])
        ? []
        : (['inheritDefaults', 'inheritGroups'] as const).map((field) => ({
            title: field,
            value: field,
            description: current[field] === undefined ? 'Follow earlier explicit controls' : String(current[field]),
            run: () =>
              ui.menu(field, [
                { title: 'Inherit earlier control', value: 'inherit', run: () => ui.propose(target, { field }) },
                {
                  title: 'Include contributions',
                  value: 'true',
                  run: () => ui.propose(target, { field, value: true }),
                },
                {
                  title: 'Exclude contributions',
                  value: 'false',
                  run: () => ui.propose(target, { field, value: false }),
                },
              ]),
          }))),
      {
        title: 'Reset local prompt settings…',
        value: 'reset',
        description: 'Remove local operations and inheritance controls',
        run: () => ui.propose(target, { field: 'reset' }),
      },
    ]);
  };
  ui.menu(
    'Prompt destination',
    definitionDestinations(snapshot).map((file) => ({
      title: file.path,
      value: file.path,
      description: 'Prompt operations preserve authored base bodies; native defaults without a body stay native',
      run: () =>
        ui.menu(
          'Prompt target',
          promptTargets(snapshot, file.path).map((target) => ({
            title: target.label,
            value: JSON.stringify(target.path),
            run: () => edit(target),
          })),
        ),
    })),
  );
}
