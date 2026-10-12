import type { TuiDialogSelectOption } from '@opencode-ai/plugin/tui';
import type { Snapshot } from '../storage.ts';
import { definitionDestinations } from '../composition/authoring.ts';
import {
  type ConfigurationTarget,
  type ParameterField,
  configurationTargets,
  parameterValue,
  parseParameterInput,
} from '../composition/parameter-authoring.ts';
import { type ModelParameters, parseParameters } from '../composition/parameters.ts';
import { SettingsError } from '../settings.ts';

type Action = TuiDialogSelectOption<string> & { run: () => void | Promise<void> };
interface ParameterUi {
  menu: (title: string, options: Action[]) => void;
  prompt: (title: string, value: string, confirmed: (value: string) => void | Promise<void>) => void;
  propose: (target: ConfigurationTarget, field: ParameterField, text: string) => Promise<void>;
}
function parameterActions(
  current: ModelParameters,
  prompt: ParameterUi['prompt'],
  propose: (field: ParameterField, text: string) => void | Promise<void>,
): Action[] {
  return [
    ...(['temperature', 'topP', 'topK', 'maxOutputTokens', 'options'] as const).map((field) => ({
      title: field === 'options' ? 'Custom provider options (JSON)' : field,
      value: field,
      description: `${current[field] === undefined ? 'Inherit earlier values' : JSON.stringify(current[field])} · ${field === 'options' ? 'Provider support varies; values require JSON' : field === 'temperature' ? '0–2' : field === 'topP' ? '0–1' : 'Positive safe integer'}`,
      run: () =>
        prompt(
          `${field}: blank removes this local value`,
          current[field] === undefined ? '' : JSON.stringify(current[field]),
          (text) => propose(field, text),
        ),
    })),
    {
      title: 'Reset local parameters…',
      value: 'reset',
      description: 'Remove this source’s parameter fields and inherit earlier contributions',
      run: () => propose('reset', ''),
    },
  ];
}

export function openParameterDraft(
  ui: Pick<ParameterUi, 'prompt'> & {
    menu: (title: string, options: () => Action[]) => void;
    back: () => void;
    refresh: () => void;
  },
  selected: (parameters: ModelParameters) => void | Promise<void>,
): void {
  let pending: ModelParameters = {};
  ui.menu('New preset: staged parameters', () => [
    {
      title: 'Review and create preset…',
      value: '+save',
      description: 'No model binding; model-dependent support is checked at dispatch. Nothing is saved yet.',
      run: () => {
        if (!Object.keys(pending).some((key) => key !== 'options') && Object.keys(pending.options ?? {}).length === 0) {
          throw new SettingsError('Stage at least one valid parameter before creating the preset.');
        }
        return selected(parseParameters(pending));
      },
    },
    ...parameterActions(pending, ui.prompt, (field, text) => {
      const value = parseParameterInput(field, text);
      if (field === 'reset') {
        pending = {};
        ui.refresh();
        return;
      }
      if (value === undefined) {
        Reflect.deleteProperty(pending, field);
      } else {
        pending = parseParameters({ ...pending, [field]: value });
      }
      ui.back();
    }),
  ]);
}

export function openParameters(snapshot: Snapshot, ui: ParameterUi): void {
  const edit = (target: ConfigurationTarget) => {
    const current = parameterValue(snapshot, target);
    ui.menu(
      `${target.label}: parameters saved here`,
      parameterActions(current, ui.prompt, (field, text) => ui.propose(target, field, text)),
    );
  };
  ui.menu(
    'Parameter destination',
    definitionDestinations(snapshot).map((file) => ({
      title: file.path,
      value: file.path,
      description: 'Edit only this source; later profiles and explicit agent pins may mask values',
      run: () =>
        ui.menu(
          'Parameter target',
          configurationTargets(snapshot, file.path).map((target) => ({
            title: target.label,
            value: JSON.stringify(target.path),
            description: `/${target.path.join('/')} · ${file.path}`,
            run: () => edit(target),
          })),
        ),
    })),
  );
}
