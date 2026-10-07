import type { Terminal } from '@xterm/headless';

/** Observe native focus and input echoes; a visible menu option alone is not input readiness. */
export function terminalSearch(screen: Terminal) {
  let visible = false;
  for (const [final, value] of [
    ['h', true],
    ['l', false],
  ] as const) {
    screen.parser.registerCsiHandler({ prefix: '?', final }, (params) => {
      if (params.includes(25)) {
        visible = value;
      }
      return false;
    });
  }
  const echoed = (value: string) => {
    const buffer = screen.buffer.active;
    return (
      visible &&
      buffer.cursorX >= value.length &&
      buffer.getLine(buffer.cursorY)?.translateToString(false, buffer.cursorX - value.length, buffer.cursorX) === value
    );
  };
  const focused = () => {
    const buffer = screen.buffer.active;
    return (
      visible &&
      /^Search(?: fields)?…?(?:\s|$)/.test(
        buffer.getLine(buffer.cursorY)?.translateToString(false, buffer.cursorX) ?? '',
      )
    );
  };
  const pending = () =>
    !visible &&
    Array.from({ length: screen.rows }, (_, row) => screen.buffer.active.getLine(row)?.translateToString() ?? '').some(
      (line) => /^\s+Search(?: fields)?…?\s*$/.test(line),
    );
  const selected = (label: string, query: string) => {
    if (!echoed(query)) {
      return false;
    }
    const buffer = screen.buffer.active;
    const column = buffer.cursorX - query.length;
    const input = buffer.getLine(buffer.cursorY)!.getCell(column)!;
    for (let row = buffer.cursorY + 1; row < screen.rows; row++) {
      const line = buffer.getLine(row)!;
      const titleColumn = line.translateToString(false, column, column + 2) === '✓ ' ? column + 2 : column;
      if (line.translateToString(false, titleColumn, titleColumn + label.length) !== label) {
        continue;
      }
      const first = line.getCell(titleColumn)!;
      const last = line.getCell(titleColumn + label.length - 1)!;
      // Native selection is a highlighted row. The dot marks the current value,
      // and can remain on another option while filtering changes selection.
      if (
        first.getBgColorMode() !== 0 &&
        first.getBgColorMode() === last.getBgColorMode() &&
        first.getBgColor() === last.getBgColor() &&
        (first.getBgColorMode() !== input.getBgColorMode() || first.getBgColor() !== input.getBgColor())
      ) {
        return true;
      }
    }
    return false;
  };
  const promptFocused = () => {
    const buffer = screen.buffer.active;
    return (
      visible &&
      buffer.cursorX === 5 &&
      buffer.cursorY >= screen.rows - 9 &&
      buffer.getLine(buffer.cursorY)?.translateToString(false, 0, 5) === '  ┃  '
    );
  };
  return {
    focused,
    echoed,
    pending,
    promptFocused,
    selected,
  };
}
