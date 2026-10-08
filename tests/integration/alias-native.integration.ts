import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compositionFixture } from './composition-fixture.ts';
import { installedEditor } from './editor.ts';
import { httpRelay } from './http-relay.ts';
import type * as Revision from '../../src/config-composer/composition/revision.ts';

test(
  'packaged native apply accepts an explicit configuration-directory alias and still blocks actual native JSON edits',
  { timeout: 180_000 },
  async (t) => {
    const f = await compositionFixture(t, 'native-configuration-alias');
    await f.write(f.paths.shared, {
      componentGroups: {
        work: { agents: ['worker'], configuration: { model: 'fixture/beta', prompt: { append: ['ALIAS_COMPOSER'] } } },
      },
      profiles: { work: { layers: [{ componentGroup: 'work' }] } },
      activeProfiles: [],
    });
    const alias = join(f.host.root, 'native-config-alias');
    await symlink(f.host.configRoot, alias, 'junction');
    assert.equal(await realpath(alias), await realpath(f.host.configRoot));
    assert.notEqual(alias, f.host.configRoot, 'the explicit native environment retains its lexical directory alias');
    await f.host.start({ configurationAlias: alias });
    assert.equal(f.host.environment.OPENCODE_CONFIG_DIR, alias);
    const server = await httpRelay(t, () => f.host.url);
    const api = async <T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> => {
      const response = await fetch(`${server.url}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'x-opencode-directory': f.host.project },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      assert.ok(response.ok, `${path}: ${await response.clone().text()}`);
      return (await response.json()) as T;
    };
    const editor = await installedEditor({ ...f.host, api });
    const { compositionRevision, observeNativeFiles } = (await import(
      pathToFileURL(join(f.host.installed.directory, 'dist/config-composer/composition/revision.js')).href
    )) as typeof Revision;
    const initial = await editor.runtime();
    const saved = await editor.snapshot();
    assert.equal(saved.root, await realpath(alias));
    assert.notEqual(saved.root, alias, 'the Node editor observes the canonical directory independently of native env');
    assert.equal(
      initial.applied.observedNativeFiles,
      await observeNativeFiles(saved.root),
      'the real native hook and packaged Node editor attest identical unchanged native files',
    );
    assert.equal(await observeNativeFiles(alias), initial.applied.observedNativeFiles);
    const nativePath = join(f.host.configRoot, 'opencode.jsonc');
    const nativeBefore = await readFile(nativePath, 'utf8');
    const original = await f.send();
    assert.equal(original.captured.model, 'alpha');
    const history = await f.history(original.session.id);
    await f.saveScope('shared', { operation: 'selection', profiles: ['work'] });
    assert.equal((await editor.runtime()).applied.id, initial.applied.id, 'a saved Composer edit remains unapplied');
    const candidate = await editor.snapshot();
    const expected = compositionRevision(candidate.sources, candidate.resolved, candidate.files);
    const start = server.requests.length;
    await editor.reload(candidate);
    const requests = server.requests.slice(start);
    assert.equal(requests.filter((request) => request.path === '/instance/dispose').length, 1);
    assert.ok(requests.some((request) => request.path === '/session/status' && request.status === 200));
    for (const path of ['/config', '/config/providers', '/agent']) {
      assert.ok(requests.some((request) => request.path === path && request.status === 200));
    }
    assert.ok(!requests.some((request) => request.path === '/global/config'));
    const applied = await editor.runtime();
    assert.notEqual(applied.applied.id, initial.applied.id);
    assert.deepEqual(applied.applied.revision, expected);
    assert.equal(applied.applied.observedNativeFiles, initial.applied.observedNativeFiles);
    assert.equal(await readFile(nativePath, 'utf8'), nativeBefore);
    assert.deepEqual(await f.history(original.session.id), history);
    const continued = await f.send(original.session.id);
    assert.equal(continued.captured.model, 'beta');
    assert.match(JSON.stringify(continued.captured.messages), /ALIAS_COMPOSER/);
    assert.ok(JSON.stringify(continued.captured.messages).includes('verified'));
    await writeFile(nativePath, nativeBefore + '\n// Actual saved native JSON change\n');
    const beforeRejection = server.requests.length;
    await assert.rejects(editor.reload(), /Native JSON configuration changed.*Restart OpenCode/s);
    assert.ok(!server.requests.slice(beforeRejection).some((request) => request.path === '/instance/dispose'));
    assert.equal((await editor.runtime()).applied.id, applied.applied.id);
    assert.match(await readFile(nativePath, 'utf8'), /Actual saved native JSON change/);
  },
);
