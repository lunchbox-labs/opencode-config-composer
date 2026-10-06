import assert from 'node:assert/strict';
import { test } from 'node:test';
import headless from '@xterm/headless';
import { terminalSearch } from './integration/terminal-screen.ts';

test('native select readiness waits beyond autocomplete and first paint for focus and an actual query echo', async (t) => {
  const screen = new headless.Terminal({ cols: 180, rows: 55, allowProposedApi: true });
  t.after(() => screen.dispose());
  const search = terminalSearch(screen);
  const write = (text: string) => new Promise<void>((resolve) => screen.write(text, resolve));
  // Cursor locations and DECTCEM transitions reproduce the failed Windows capture.
  await write('\x1b[47;4H/compose        Compose configuration\x1b[49;6H/compose\x1b[?25h');
  assert.equal(search.focused(), false, 'command autocomplete is not the Compose search input');
  await write('\x1b[?25l\x1b[16;65HCompose\x1b[18;65HSearch…\x1b[22;65HPrompt operations and inheritance\x1b[55;180H');
  assert.ok(screen.buffer.active.getLine(21)!.translateToString().includes('Prompt operations and inheritance'));
  assert.equal(search.focused(), false, 'first dialog paint precedes native input focus');
  assert.equal(search.echoed('Prompt operations and inheritance'), false, 'an option title does not prove typed input');
  await write('\x1b[18;65H\x1b[?25h');
  assert.equal(search.focused(), true);
  assert.equal(
    search.echoed('Prompt operations and inheritance'),
    false,
    'empty focused input is not a submitted query',
  );
  await write('\x1b[18;65HPrompt operations and inheritance');
  assert.equal(search.echoed('Prompt operations and inheritance'), true);
  assert.equal(search.focused(), false, 'a submitted query must not be mistaken for the next dialog input');
  await write('\x1b[?25l\x1b[22;97H');
  assert.equal(
    search.echoed('Prompt operations and inheritance'),
    false,
    'an unfocused option cannot satisfy the echo guard',
  );
  await write('\x1b[18;65H\x1b[KSearch fields…\x1b[18;65H\x1b[?25h');
  assert.equal(search.focused(), true, 'the saved composition inspector has a distinct search placeholder');
});
