import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { compositionFixture } from './integration/composition-fixture.ts';
import { installSkill, nativeSkill } from './integration/permission-fixture.ts';
import { pathToFileURL } from 'node:url';
import type * as Baseline from '../src/config-composer/composition/runtime-baseline.ts';
import { validateReferenceDiagnostics } from '../src/config-composer/composition/reference-diagnostics.ts';
import type { CompositionDocument } from '../src/config-composer/composition/types.ts';

test(
  'native names resolve shared, project, external and configured sources without mappings, preserving permissions and reload isolation',
  { timeout: 300_000 },
  async (t) => {
    const f = await compositionFixture(t, 'native-component-references');
    const host = f.host;
    const { readRuntimeReferenceDiagnostics } = (await import(
      pathToFileURL(join(host.installed.directory, 'dist/config-composer/composition/runtime-baseline.js')).href
    )) as typeof Baseline;
    const skillFiles: string[] = [];
    for (const [directory, name, body] of [
      [join(host.configRoot, 'skills/different-directory'), 'shared-skill', 'SHARED'],
      [join(host.project, '.opencode/skills/different-directory'), 'project-skill', 'PROJECT'],
      [join(host.project, '.agents/skills/external'), 'external-skill', 'EXTERNAL'],
      [join(host.root, 'configured/another-directory'), 'configured-skill', 'CONFIGURED'],
      [join(host.configRoot, 'skills/shadow'), 'shadowed', 'SHADOWED'],
    ]) {
      await mkdir(directory, { recursive: true });
      const path = join(directory, 'SKILL.md');
      skillFiles.push(path);
      await writeFile(path, `---\nname: ${name}\ndescription: Native fixture\n---\n${body}\n`);
    }
    await installSkill(host);
    const nativePath = join(host.configRoot, 'opencode.jsonc');
    const native = JSON.parse(await readFile(nativePath, 'utf8')) as Record<string, unknown>;
    native.skills = { paths: [join(host.root, 'configured')] };
    native.command = {
      shadowed: { template: 'Ordinary command wins its name' },
      'json-command': { template: 'JSONC' },
    };
    native.agent = { worker: { mode: 'primary', prompt: 'NATIVE_WORKER' }, disabled: { disable: true } };
    await writeFile(nativePath, `// Native JSONC\n${JSON.stringify(native)}`);
    await mkdir(join(host.project, '.opencode/agents'), { recursive: true });
    await mkdir(join(host.project, '.opencode/commands'), { recursive: true });
    await writeFile(
      join(host.project, '.opencode/agents/markdown-agent.md'),
      '---\ndescription: Native agent\nmode: subagent\n---\nNATIVE_MARKDOWN_AGENT',
    );
    await writeFile(
      join(host.project, '.opencode/commands/different-file.md'),
      '---\nname: markdown-command\ndescription: Native command\n---\nNATIVE_MARKDOWN_COMMAND',
    );
    const names = [
      'shared-skill',
      'project-skill',
      'external-skill',
      'configured-skill',
      'shadowed',
      'included-skill',
      'customize-opencode',
    ];
    const document: CompositionDocument = {
      components: { agents: { helper: { prompt: 'Composer-only agent', skills: names } } },
      componentGroups: {
        work: {
          agents: ['worker', 'markdown-agent', 'helper', 'disabled', 'missing-agent'],
          commands: ['json-command', 'markdown-command', 'init', 'review', 'project-skill', 'missing-command'],
          skills: [...names, 'missing-skill'],
          configuration: {
            model: 'fixture/beta',
            permissions: [{ tool: 'skill', pattern: 'included-skill', action: 'deny' }],
          },
        },
      },
      profiles: { work: { layers: [{ componentGroup: 'work' }] } },
      activeProfiles: ['work'],
    };
    await f.write(f.paths.project, document);
    const before = await Promise.all(skillFiles.map((path) => readFile(path, 'utf8')));
    await host.start();
    const inspect = async () => {
      const { location } = await f.editor.runtime();
      const config = await host.api('/config');
      const skills = await host.api<{ name: string; location: string }[]>('/skill');
      const commands = await host.api<{ name: string; source?: string }[]>('/command');
      const baseline = readRuntimeReferenceDiagnostics(config, location, host.configRoot);
      return {
        config,
        skills,
        commands,
        diagnostics: validateReferenceDiagnostics(baseline.diagnostics, { skills, commands }),
      };
    };
    const initial = await inspect();
    for (const name of names) {
      assert.ok(
        initial.skills.some((skill) => skill.name === name),
        name,
      );
    }
    assert.deepEqual(
      initial.diagnostics.map((item) => [item.name, item.status]),
      [
        ['disabled', 'disabled'],
        ['missing-agent', 'missing'],
        ['missing-command', 'missing'],
        ['missing-skill', 'missing'],
      ],
    );
    assert.equal(initial.commands.find((item) => item.name === 'shadowed')?.source, 'command');
    assert.equal((await f.send()).captured.model, 'beta');
    await nativeSkill(host, 'worker', 'deny');
    assert.match(host.stderr, /missing-skill/);
    const originalSkillPaths = (initial.config as { skills: { paths: string[] } }).skills.paths;
    assert.ok(
      !originalSkillPaths.some((path) => path.includes('different-directory')),
      'name-only references add no duplicate discovery paths',
    );
    // Another project uses the same shared registry but cannot inherit this project's skills or diagnostics.
    const other = join(host.root, 'other');
    await mkdir(join(other, '.opencode'), { recursive: true });
    await host.prepareConfigurationDependencies([other]);
    const isolated = await fetch(`${host.url}/skill`, { headers: { 'x-opencode-directory': other } });
    assert.equal(isolated.ok, true);
    const otherSkills = (await isolated.json()) as { name: string }[];
    assert.ok(otherSkills.some((item) => item.name === 'shared-skill'));
    assert.ok(!otherSkills.some((item) => item.name === 'project-skill' || item.name === 'external-skill'));
    document.componentGroups!.work.agents = ['worker', 'markdown-agent', 'helper'];
    document.componentGroups!.work.commands = ['json-command', 'markdown-command', 'init', 'review', 'project-skill'];
    document.componentGroups!.work.skills = names;
    await f.write(f.paths.project, document);
    await f.editor.reload();
    assert.deepEqual((await inspect()).diagnostics, []);
    await nativeSkill(host, 'worker', 'deny');
    document.activeProfiles = [];
    await f.write(f.paths.project, document);
    await f.editor.reload();
    assert.equal((await f.send()).captured.model, 'alpha');
    const reset = await inspect();
    assert.deepEqual(reset.diagnostics, []);
    assert.ok(
      reset.skills.some((item) => item.name === 'project-skill'),
      'clearing selection does not hide native skills',
    );
    assert.deepEqual(await Promise.all(skillFiles.map((path) => readFile(path, 'utf8'))), before);
  },
);
