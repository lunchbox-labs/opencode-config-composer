import type { TuiDialogSelectOption } from '@opencode-ai/plugin/tui';
import type { Snapshot } from '../storage.ts';
import { definitionDestinations } from '../composition/authoring.ts';
import type { ConfigurationTarget } from '../composition/parameter-authoring.ts';
import {
  localPermissionRules,
  permissionRules,
  permissionStatus,
  permissionTargets,
} from '../composition/permission-authoring.ts';
import type { PermissionRule } from '../composition/types.ts';

type Action = TuiDialogSelectOption<string> & { run: () => void | Promise<void> };
interface PermissionUi {
  menu: (title: string, actions: Action[] | (() => Action[])) => void;
  prompt: (title: string, value: string, confirmed: (value: string) => void | Promise<void>) => void;
  back: () => void;
  refresh: () => void;
  propose: (target: ConfigurationTarget, rules: PermissionRule[] | undefined) => Promise<void>;
  preview: (target: ConfigurationTarget, rules: PermissionRule[]) => Promise<void>;
  create: (sourceId: string, name: string) => Promise<void>;
}

export function openPermissions(snapshot: Snapshot, ui: PermissionUi): void {
  const edit = (target: ConfigurationTarget) => {
    const pending = structuredClone(localPermissionRules(snapshot, target) ?? []);
    const ruleMenu = (index: number) =>
      ui.menu(`Rule ${index + 1}`, () => [
        ...(['tool', 'pattern'] as const).map((field) => ({
          title: `Edit ${field}`,
          value: field,
          description: pending[index][field] ?? '* (all inputs)',
          run: () =>
            ui.prompt(
              field === 'pattern' ? 'Pattern: blank means all inputs' : 'Tool name or wildcard',
              pending[index][field] ?? '',
              (text) => {
                const next = { ...pending[index] };
                if (field === 'pattern' && text === '') {
                  delete next.pattern;
                } else {
                  next[field] = text;
                }
                permissionRules([next]);
                pending[index] = next;
                ui.back();
              },
            ),
        })),
        {
          title: `Action: ${pending[index].action}`,
          value: 'action',
          run: () =>
            ui.menu(
              'Permission action',
              (['allow', 'ask', 'deny'] as const).map((action) => ({
                title: action,
                value: action,
                run: () => {
                  pending[index].action = action;
                  ui.back();
                },
              })),
            ),
        },
        ...(index === 0
          ? []
          : [
              {
                title: 'Move earlier',
                value: 'earlier',
                run: () => {
                  const [rule] = pending.splice(index, 1);
                  pending.splice(index - 1, 0, rule);
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
                  const [rule] = pending.splice(index, 1);
                  pending.splice(index + 1, 0, rule);
                  ui.back();
                },
              },
            ]),
        {
          title: 'Remove rule',
          value: 'remove',
          run: () => {
            pending.splice(index, 1);
            ui.back();
          },
        },
      ]);
    ui.menu(`${target.label}: ordered permissions`, () => [
      {
        title: 'Save ordered rules…',
        value: '+save',
        description: permissionStatus,
        run: () => ui.propose(target, pending),
      },
      {
        title: 'Test configured matches…',
        value: '+preview',
        description: 'Later matching rules win, including allow after deny',
        run: () => ui.preview(target, pending),
      },
      ...pending.map((rule, index) => ({
        title: `${index + 1}. ${rule.tool} ${rule.pattern ?? '*'} → ${rule.action}`,
        value: String(index),
        run: () => ruleMenu(index),
      })),
      {
        title: 'Add rule',
        value: '+add',
        description: 'Start with an editable ask rule for all tools',
        run: () => {
          pending.push({ tool: '*', action: 'ask' });
          ui.refresh();
        },
      },
      {
        title: 'Remove local rules…',
        value: '+inherit',
        description: 'Earlier contributions remain; no local rule means no local match',
        run: () => ui.propose(target, undefined),
      },
      {
        title: 'Save an empty rule list…',
        value: '+empty',
        description: 'Keep the local field with no contributions; earlier matching rules still apply',
        run: () => ui.propose(target, []),
      },
    ]);
  };
  ui.menu(
    'Permission destination',
    definitionDestinations(snapshot).map((file) => ({
      title: file.path,
      value: file.path,
      description: permissionStatus,
      run: () =>
        ui.menu('Permission target', [
          {
            title: 'Create permission preset…',
            value: '+create',
            description: 'Create an inactive reusable preset without a model binding',
            run: () => ui.prompt('Permission preset name', '', (name) => ui.create(file.path, name)),
          },
          ...permissionTargets(snapshot, file.path).map((target) => ({
            title: target.label,
            value: JSON.stringify(target.path),
            description: `/${target.path.join('/')}`,
            run: () => edit(target),
          })),
        ]),
    })),
  );
}
