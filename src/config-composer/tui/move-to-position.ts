import { SettingsError } from '../settings.ts';

interface PositionUi {
  prompt: (title: string, value: string, confirmed: (value: string) => void) => void;
  back: () => void;
}

/** Move the selected occurrence without sorting or coalescing equal entries. */
export function moveToPosition(ui: PositionUi, pending: unknown[], index: number): void {
  ui.prompt(`Move to position (1–${pending.length})`, String(index + 1), (text) => {
    const value = text.trim();
    const position = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(position) || position < 1 || position > pending.length) {
      throw new SettingsError(`Enter a whole number from 1 to ${pending.length}.`);
    }
    if (position !== index + 1) {
      const [item] = pending.splice(index, 1);
      pending.splice(position - 1, 0, item);
    }
    // Leave both the prompt and the occurrence menu, whose index is now obsolete.
    ui.back();
    ui.back();
  });
}
