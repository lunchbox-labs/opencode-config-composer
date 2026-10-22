import { parseConfiguration } from '../configuration.ts';
import { findNodeAtLocation, getNodeValue, parseTree } from 'jsonc-parser';
import { type EditorView, destination, roster, sourceText } from './view.ts';
import { type SettingsTarget, setGlobal, setSetting, settingsPath } from '../composition/authoring.ts';
import { agentFields, commandFields } from '../composition/document.ts';
import { SettingsError, record } from '../settings.ts';
import { resolveComposition } from '../composition/runtime.ts';
function nativeValue(text: string): unknown {
  const parsed = parseConfiguration(`{"value":${text}}`);
  if (Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, 'value')) {
    throw new SettingsError('Enter one native JSON value.');
  }
  return parsed.value;
}
export function authoredSettings(view: EditorView, target: SettingsTarget): Record<string, unknown> {
  const tree = parseTree(sourceText(view));
  if (tree === undefined) {
    throw new SettingsError('Invalid Composer JSONC document.');
  }
  const node = findNodeAtLocation(tree, settingsPath(sourceText(view), target));
  const value: unknown = node === undefined ? {} : getNodeValue(node);
  return record(value) ? value : {};
}
export async function pickModel(view: EditorView, title: string, selected: (model: string) => void): Promise<void> {
  const models = await view.catalog();
  view.nav.menu({
    title,
    placeholder: 'Search…',
    options: models.map((model) => ({
      title: model.name,
      value: model.id,
      description: model.id,
      category: model.provider,
    })),
    onSelect: (option) => selected(option.value),
  });
}
export async function pickVariant(
  view: EditorView,
  title: string,
  model: string | undefined,
  selected: (variant: string) => void,
): Promise<void> {
  const models = await view.catalog();
  const found = models.find((item) => item.id === model);
  if (found === undefined) {
    throw new SettingsError('Choose an explicit model before choosing its variant.');
  }
  view.nav.menu({
    title,
    options: [
      { title: 'Default', value: '', description: 'Write an empty variant; clear inherited variant' },
      ...Object.keys(found.variants).map((name) => ({ title: name, value: name })),
    ],
    onSelect: (option) => selected(option.value),
  });
}
function variantModel(view: EditorView, target: SettingsTarget): string | undefined {
  const own = authoredSettings(view, target).model;
  if (typeof own === 'string') {
    return own;
  }
  const result = resolveComposition(
    view.context.source.document,
    target.profile ?? null,
    view.context.runtime.native,
    view.context.runtime.observation.authority,
  );
  const names =
    target.group === undefined
      ? [target.name]
      : (view.context.source.document.groups.find((group) => group.name === target.group)?.members.agent ?? []);
  const models = new Set(
    names.map((name) =>
      Object.hasOwn(result.agent, name) ? (result.agent[name].model ?? result.model) : result.model,
    ),
  );
  if (models.size !== 1) {
    throw new SettingsError('Members inherit different models. Set a model here before choosing a variant.');
  }
  const model = [...models][0];
  return typeof model === 'string' ? model : undefined;
}
function editPermission(view: EditorView, target: SettingsTarget): void {
  const label = destination(target);
  const value = authoredSettings(view, target).permission;
  const write = (next: unknown) => view.review(setSetting(sourceText(view), target, 'permission', next), label);
  view.nav.menu({
    title: `${label} · permission`,
    options: [
      {
        title: 'Edit complete permission',
        value: 'complete',
        description: 'Native scalar action or tool map; no rule DSL',
      },
      { title: 'Add tool block', value: 'add', description: 'Exact native tool key' },
      ...Object.keys(record(value) ? value : {}).map((key) => ({
        title: key,
        value: `tool:${key}`,
        description: JSON.stringify(record(value) ? value[key] : undefined),
      })),
    ],
    onSelect: (option) =>
      view.run(() => {
        const tool = (key: string) => {
          view.nav.menu({
            title: `${label} · permission · ${key}`,
            options: [
              { title: 'Edit tool block', value: 'edit' },
              { title: 'Inherit/remove this tool block', value: 'remove' },
            ],
            onSelect: (action) =>
              view.run(() => {
                const next: Record<string, unknown> = record(value)
                  ? structuredClone(value)
                  : typeof value === 'string'
                    ? { '*': value }
                    : {};
                if (action.value === 'remove') {
                  Reflect.deleteProperty(next, key);
                  return write(next);
                }
                view.nav.prompt({
                  title: `${label} · permission · ${key}`,
                  value: JSON.stringify(next[key] ?? 'ask'),
                  placeholder: '"allow", "ask", "deny", or a native pattern object',
                  onConfirm: (text) =>
                    view.defer(() => {
                      Object.defineProperty(next, key, {
                        value: nativeValue(text),
                        enumerable: true,
                        writable: true,
                        configurable: true,
                      });
                      return write(next);
                    }),
                });
              }),
          });
        };
        if (option.value === 'complete') {
          view.nav.prompt({
            title: `${label} · permission JSON`,
            value: JSON.stringify(value ?? {}),
            onConfirm: (text) => view.defer(() => write(nativeValue(text))),
          });
        } else if (option.value === 'add') {
          view.nav.prompt({
            title: 'Native permission tool key',
            onConfirm: (key) =>
              view.defer(() => {
                if (key.trim() === '') {
                  throw new SettingsError('Enter a tool key.');
                }
                tool(key);
              }),
          });
        } else {
          tool(option.value.slice(5));
        }
      }),
  });
}
function openField(view: EditorView, target: SettingsTarget, field: string): void {
  const label = destination(target);
  const value = authoredSettings(view, target)[field];
  const write = (next: unknown) => view.review(setSetting(sourceText(view), target, field, next), label);
  view.nav.menu({
    title: `${label} · ${field}`,
    options: [
      { title: 'Edit value', value: 'edit', description: value === undefined ? 'Inherit' : JSON.stringify(value) },
      { title: 'Inherit/remove this authored setting', value: 'inherit' },
    ],
    onSelect: (option) =>
      view.run(() => {
        if (option.value === 'inherit') {
          return write(undefined);
        }
        if (field === 'model') {
          return pickModel(view, `${label} · model`, (model) =>
            view.run(() =>
              target.kind === 'agent'
                ? pickVariant(view, `${label} · variant`, model, (variant) =>
                    view.run(() =>
                      view.review(
                        setSetting(setSetting(sourceText(view), target, 'model', model), target, 'variant', variant),
                        label,
                      ),
                    ),
                  )
                : write(model),
            ),
          );
        }
        if (field === 'variant') {
          return pickVariant(view, `${label} · variant`, variantModel(view, target), (variant) =>
            view.run(() => write(variant)),
          );
        }
        if (field === 'mode' || field === 'subtask' || field === 'agent') {
          const choices =
            field === 'mode'
              ? ['primary', 'subagent', 'all']
              : field === 'subtask'
                ? ['true', 'false']
                : roster(view, 'agent');
          view.nav.menu({
            title: `${label} · ${field}`,
            options: choices.map((name) => ({ title: name, value: name })),
            onSelect: (choice) => view.run(() => write(field === 'subtask' ? choice.value === 'true' : choice.value)),
          });
          return;
        }
        if (field === 'permission') {
          editPermission(view, target);
          return;
        }
        view.nav.prompt({
          title: `${label} · ${field}`,
          value: value === undefined ? '' : JSON.stringify(value),
          placeholder: field === 'options' ? 'Native JSON options object' : 'Finite number, including 0',
          onConfirm: (text) =>
            view.defer(() => {
              if (field === 'options') {
                return write(nativeValue(text));
              }
              if (text.trim() === '' || !Number.isFinite(Number(text))) {
                throw new SettingsError('Enter a finite number. Use Inherit to remove the setting.');
              }
              return write(Number(text));
            }),
        });
      }),
  });
}
export function openAgentSettings(view: EditorView, target: SettingsTarget): void {
  const fields = target.kind === 'agent' ? agentFields : commandFields;
  const own = authoredSettings(view, target);
  view.nav.menu({
    title: `${destination(target)} · ${target.kind} settings`,
    placeholder: 'Search…',
    options: fields.map((field) => ({
      title: field,
      value: field,
      description: Object.hasOwn(own, field) ? JSON.stringify(own[field]) : 'Inherit',
    })),
    onSelect: (option) => view.run(() => openField(view, target, option.value)),
  });
}
export const openCommandSettings = openAgentSettings;
export function openGlobals(view: EditorView, profile?: string): void {
  const label = profile === undefined ? 'Shared' : `Profile ${profile}`;
  const layer = profile === undefined ? view.context.source.document : view.context.source.document.profiles[profile];
  view.nav.menu({
    title: `${label} · global models`,
    options: (['model', 'small_model'] as const).map((field) => ({
      title: field,
      value: field,
      description: layer[field] ?? 'Inherit',
    })),
    onSelect: (option) =>
      view.run(() => {
        const field = option.value === 'small_model' ? 'small_model' : 'model';
        view.nav.menu({
          title: `${label} · ${field}`,
          options: [
            { title: 'Choose model', value: 'edit' },
            { title: 'Inherit/remove this authored setting', value: 'inherit' },
          ],
          onSelect: (action) =>
            view.run(() =>
              action.value === 'inherit'
                ? view.review(setGlobal(sourceText(view), profile, field, undefined), label)
                : pickModel(view, `${label} · ${field}`, (model) =>
                    view.run(() => view.review(setGlobal(sourceText(view), profile, field, model), label)),
                  ),
            ),
        });
      }),
  });
}
