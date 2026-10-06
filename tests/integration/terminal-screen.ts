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
      /^Search(?: fields)?…/.test(buffer.getLine(buffer.cursorY)?.translateToString(false, buffer.cursorX) ?? '')
    );
  };
  return {
    focused,
    echoed,
  };
}
