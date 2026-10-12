import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { compositionFixture } from './composition-fixture.ts';
import { nativeTerminal } from './terminal.ts';

for (const kind of ['layers', 'permissions'] as const) {
  test(
    `native ${kind} position prompt validates, cancels, repeats and retains stale-write protection`,
    { timeout: 240_000 },
    async (t) => {
      const f = await compositionFixture(t, `move-${kind}`);
      const layers = [
        { componentGroup: 'a' },
        { componentGroup: 'b' },
        { componentGroup: 'a' },
        { componentGroup: 'c' },
      ];
      const permissions = [
        { tool: 'bash', action: 'deny' as const },
        { tool: 'read', action: 'allow' as const },
        { tool: 'bash', action: 'deny' as const },
        { tool: '*', action: 'ask' as const },
      ];
      await f.write(f.paths.shared, {
        componentGroups: { a: {}, b: {}, c: {} },
        profiles: { ordered: { layers } },
        configurationPresets: { checks: { permissions } },
      });
      await f.host.start();
      const original = await f.send();
      const terminal = await nativeTerminal(f.host, original.session.id, `move-${kind}`);
      await terminal.wait(['Acceptance conversation', 'verified', 'ctrl+p', 'commands']);
      const list = kind === 'layers' ? 'ordered: ordered layers' : 'Preset: checks: ordered permissions';
      const item = kind === 'layers' ? 'Layer' : 'Rule';
      const third = kind === 'layers' ? '3. a' : '3. bash';
      const first = kind === 'layers' ? '1. a' : '1. bash';
      const last = kind === 'layers' ? '4. a' : '4. bash';
      const save = kind === 'layers' ? 'Save layers' : 'Save ordered rules';
      const review = kind === 'layers' ? 'Save composition definition?' : 'Save configured permission rules?';
      const open = async () => {
        await terminal.command('/compose-configs', 'Compose configs');
        if (kind === 'layers') {
          await terminal.choose('Author groups, presets and profiles', 'Composition definitions');
          await terminal.choose('Profiles', 'Create definition');
          await terminal.choose('ordered', 'Profiles: ordered');
          await terminal.choose('Ordered layers', list);
        } else {
          await terminal.choose('Ordered permission rules and configured previews', 'Permission destination');
          await terminal.press('\r', 'Permission target');
          await terminal.choose('Preset: checks', list);
        }
      };
      await open();
      const before = await readFile(f.paths.shared, 'utf8');
      await terminal.choose(third, `${item} 3`);
      await terminal.choose('Move to position', 'Move to position (1–4)');
      await terminal.press('\x15' + '0\r', 'Enter a whole number from 1 to 4.', 'Move to position (1–4)');
      await terminal.press('\x15' + '1.5\r', 'Enter a whole number from 1 to 4.', 'Move to position (1–4)');
      await terminal.press('\x1b', `${item} 3`);
      await terminal.choose('← Back', list);
      assert.equal(await readFile(f.paths.shared, 'utf8'), before);
      await terminal.choose(third, `${item} 3`);
      await terminal.choose('Move to position', 'Move to position (1–4)');
      await terminal.press('\x15' + '1\r', list);
      await terminal.choose(first, `${item} 1`);
      await terminal.choose('Move to position', 'Move to position (1–4)');
      await terminal.press('\x15' + '4\r', list, last);
      await terminal.choose(last, `${item} 4`);
      await terminal.choose('Move to position', 'Move to position (1–4)');
      await terminal.press('\r', list, last); // Current position remains a no-op.
      await terminal.choose(save, review);
      await terminal.press('\x1b', list);
      assert.equal(await readFile(f.paths.shared, 'utf8'), before, 'cancelled save leaves the source untouched');
      await terminal.choose(save, review);
      await terminal.press('\r', 'Settings saved');
      const document = await f.document(f.paths.shared);
      assert.deepEqual(
        kind === 'layers' ? document.profiles!.ordered.layers : document.configurationPresets!.checks.permissions,
        kind === 'layers'
          ? [layers[0], layers[1], layers[3], layers[2]]
          : [permissions[0], permissions[1], permissions[3], permissions[2]],
      );
      await terminal.choose('Apply on next restart', 'ctrl+p', 'commands');
      await open();
      await terminal.choose(last, `${item} 4`);
      await terminal.choose('Move to position', 'Move to position (1–4)');
      await terminal.press('\x15' + '1\r', list);
      await terminal.choose(save, review);
      const concurrent = `${await readFile(f.paths.shared, 'utf8')}\n// concurrent edit\n`;
      await writeFile(f.paths.shared, concurrent);
      await terminal.press('\r', 'changed');
      assert.equal(await readFile(f.paths.shared, 'utf8'), concurrent);
      assert.equal(f.host.requests.length, 1);
    },
  );
}
