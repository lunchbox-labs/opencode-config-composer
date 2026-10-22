import { SettingsError } from './settings.ts';

/** Bound diagnostic text and neutralize terminal controls; never include observed source values. */
function bounded(value: string, limit = 320): string {
  const text = value.replace(/[\p{Cc}\p{Cf}]/gu, ' ');
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export function changedInput(message: string, path: string, category: 'identity' | 'selection'): SettingsError {
  return new SettingsError(`${bounded(message, 768)}\nObserved ${category}: ${bounded(path)}`);
}
