import { SettingsError } from './settings.ts';

export type InputChange =
  'content' | 'permissions' | 'identity' | 'source-list' | 'selection' | 'environment' | 'missing' | 'unavailable';
export interface ChangedInput {
  path: string;
  category: InputChange;
}
export interface FileOutcome {
  path: string;
  outcome: 'restored' | 'removed' | 'external-bytes-preserved' | 'restore-failed';
}
export interface SaveDetails {
  input?: ChangedInput;
  phase?: 'before-writes' | 'rollback';
  outcomes?: FileOutcome[];
  omittedOutcomes?: number;
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

/** Add context to an existing failed read without probing disk again or changing its rejection. */
export function inputReadFailure(error: unknown, path: string): never {
  if (error instanceof SaveDiagnosticError) {
    throw error;
  }
  throw changedInput(
    error instanceof Error ? error.message : 'Could not read settings input.',
    path,
    error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 'missing' : 'unavailable',
    error,
  );
}

export const maxFileOutcomes = 8;

export function saveFailure(error: unknown, outcomes: FileOutcome[], total: number): SaveDiagnosticError {
  const phase = total === 0 ? 'before-writes' : 'rollback';
  const boundedOutcomes = outcomes.map((item) => ({ ...item, path: bounded(item.path) }));
  const details: SaveDetails = {
    ...(error instanceof SaveDiagnosticError ? error.details : {}),
    phase,
    outcomes: boundedOutcomes,
    omittedOutcomes: total - outcomes.length,
  };
  const original = error instanceof Error ? bounded(error.message, 768) : 'Unknown save failure';
  const labels = {
    restored: 'Restored original file',
    removed: 'Removed newly created file',
    'external-bytes-preserved': 'External bytes preserved; inspect manually',
    'restore-failed': 'Restoration failed; inspect manually',
  };
  return new SaveDiagnosticError(
    [
      original,
      phase === 'before-writes' ? 'Save rejected before file writes.' : 'Save failed; rollback outcomes:',
      ...boundedOutcomes.map((item) => `${labels[item.outcome]}: ${item.path}`),
      ...(total > outcomes.length
        ? [`${total - outcomes.length} more file outcomes omitted; inspect the planned files.`]
        : []),
    ].join('\n'),
    details,
    error,
  );
}
