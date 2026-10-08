import { writeFile } from 'node:fs/promises';

// Observe the real keymap without registering or dispatching replacement actions.
export async function tui(api, options) {
  let previous;
  let busy = false;
  const capture = async () => {
    if (busy || api.lifecycle.signal.aborted) {
      return;
    }
    busy = true;
    try {
      const commands = api.keymap.getCommands({ visibility: 'registered' }).map((command) => ({
        name: command.name,
        slashName: command.slashName,
        title: command.title,
      }));
      const serialized = JSON.stringify(commands);
      if (serialized !== previous) {
        await writeFile(options.file, serialized);
        previous = serialized;
      }
    } finally {
      busy = false;
    }
  };
  const unsubscribe = api.keymap.on('state', () => void capture().catch(() => {}));
  const timer = setInterval(() => void capture().catch(() => {}), 100);
  api.lifecycle.onDispose(() => {
    clearInterval(timer);
    unsubscribe();
  });
  await capture();
}

export default { id: 'shortcut-registration-probe', tui };
