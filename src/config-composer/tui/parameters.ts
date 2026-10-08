import type { TuiDialogSelectOption } from '@opencode-ai/plugin/tui';
import type { Snapshot } from '../storage.ts';
import { definitionDestinations } from '../composition/authoring.ts';
import {
  type ConfigurationTarget,
  type ParameterField,
  configurationTargets,
  parameterValue,
} from '../composition/parameter-authoring.ts';

type Action = TuiDialogSelectOption<string> & { run: () => void | Promise<void> };
interface ParameterUi {
  menu: (title: string, options: Action[]) => void;
  prompt: (title: string, value: string, confirmed: (value: string) => void | Promise<void>) => void;
  propose: (target: ConfigurationTarget, field: ParameterField, text: string) => Promise<void>;
}
export function openParameters(snapshot: Snapshot, ui: ParameterUi): void {
  const edit = (target: ConfigurationTarget) => {
    const current = parameterValue(snapshot, target);
    ui.menu(`${target.label}: parameters saved here`, [
      ...(['temperature', 'topP', 'topK', 'maxOutputTokens', 'options'] as const).map((field) => ({
        title: field === 'options' ? 'Custom provider options (JSON)' : field,
        value: field,
        description: `${current[field] === undefined ? 'Inherit earlier values' : JSON.stringify(current[field])} · ${field === 'options' ? 'Provider support varies; values require JSON' : field === 'temperature' ? '0–2' : field === 'topP' ? '0–1' : 'Positive safe integer'}`,
        run: () =>
          ui.prompt(
            `${field}: blank removes this local value`,
            current[field] === undefined ? '' : JSON.stringify(current[field]),
            (text) => ui.propose(target, field, text),
          ),
      })),
      {
        title: 'Reset local parameters…',
        value: 'reset',
        description: 'Remove this source’s parameter fields and inherit earlier contributions',
        run: () => ui.propose(target, 'reset', ''),
      },
    ]);
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
