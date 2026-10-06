import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import type { nativeHarness } from './harness.ts';

type Host = Awaited<ReturnType<typeof nativeHarness>>;
export type PermissionAction = 'allow' | 'ask' | 'deny';
export interface PermissionAgent {
  name: string;
  permission: { permission: string; pattern: string; action: PermissionAction }[];
  prompt?: string | null;
  model?: { modelID: string };
}
interface ToolMessage {
  info: { id: string; error?: unknown };
  parts: { tool?: string; state?: { status: string; output?: string; error?: string } }[];
}
export const skillContent = 'PERMISSION_ACCEPTANCE_SKILL_CONTENT';
export async function installSkill(host: Host) {
  const directory = join(host.configRoot, 'skills/included-skill');
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'SKILL.md'),
    `---\nname: included-skill\ndescription: Native permission acceptance skill.\n---\n${skillContent}\n`,
  );
}

/** Invoke the real skill in a fresh session without session-level permission overrides. */
export async function nativeSkill(host: Host, agent: string, action: PermissionAction) {
  const session = await host.api<{ id: string }>('/session', { title: `Native permission ${agent}: ${action}` });
  const before = host.requests.length;
  const state = { done: false };
  const request = host
    .api<ToolMessage>(`/session/${session.id}/message`, {
      agent,
      parts: [{ type: 'text', text: 'Load included-skill now.' }],
    })
    .then(
      (value) => {
        state.done = true;
        return { value };
      },
      (error: unknown) => {
        state.done = true;
        return { error };
      },
    );
  let asked = false;
  for (let attempt = 0; attempt < 300 && !state.done; attempt++) {
    const pending =
      await host.api<{ id: string; sessionID: string; permission: string; patterns: string[] }[]>('/permission');
    for (const permission of pending.filter((item) => item.sessionID === session.id)) {
      assert.equal(action, 'ask', `${agent} unexpectedly requested approval`);
      assert.equal(asked, false, 'one native skill call needs one approval');
      assert.equal(permission.permission, 'skill');
      assert.deepEqual(permission.patterns, ['included-skill']);
      assert.ok(
        !JSON.stringify(host.requests.slice(before)).includes(skillContent),
        'the skill cannot reach the provider before approval',
      );
      asked = true;
      await host.api(`/permission/${permission.id}/reply`, { reply: 'once' });
    }
    await setTimeout(30);
  }
  const result = await request;
  if ('error' in result) {
    throw result.error;
  }
  assert.equal(result.value.info.error, undefined);
  assert.equal(asked, action === 'ask', `${agent}: native approval decision`);
  const messages = await host.api<ToolMessage[]>(`/session/${session.id}/message`);
  const tool = messages.flatMap((message) => message.parts).find((part) => part.tool === 'skill');
  assert.ok(tool?.state !== undefined, `${agent}: native skill result must exist`);
  assert.equal(tool.state.status, action === 'deny' ? 'error' : 'completed', `${agent}: ${JSON.stringify(tool.state)}`);
  const captures = host.requests.slice(before);
  assert.ok(captures.length >= 2, 'native tool decision returns to the local provider');
  assert.equal(
    JSON.stringify(captures).includes(skillContent),
    action !== 'deny',
    `${agent}: provider-visible skill content`,
  );
  if (action === 'deny') {
    assert.match(tool.state.error ?? '', /rule which prevents you from using this specific tool call/);
  } else {
    assert.match(tool.state.output ?? '', new RegExp(skillContent));
  }
  assert.deepEqual(await host.api('/permission'), [], 'one-time approval leaves no pending permission request');
  return { session, messages, captures };
}
