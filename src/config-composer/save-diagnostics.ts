import { SettingsError } from './settings.ts';

export type InputChange =
  'content' | 'permissions' | 'identity' | 'source-list' | 'selection' | 'environment' | 'missing' | 'unavailable';
export interface ChangedInput {
  path: string;
  category: InputChange;
}
export interface SaveDetails {
  input?: ChangedInput;
}

/** Bound diagnostic text and neutralize terminal controls; never include observed source values. */
function bounded(value: string, limit = 320): string {
  const text = value.replace(/[\p{Cc}\p{Cf}]/gu, ' ');
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export class SaveDiagnosticError extends SettingsError {
  readonly details: SaveDetails;

  constructor(message: string, details: SaveDetails, cause?: unknown) {
    super(message, { cause });
    this.details = details;
  }
}

export function changedInput(
  message: string,
  path: string,
  category: InputChange,
  cause?: unknown,
): SaveDiagnosticError {
  const input = { path: bounded(path), category };
  return new SaveDiagnosticError(`${bounded(message, 768)}\nObserved ${category}: ${input.path}`, { input }, cause);
}
