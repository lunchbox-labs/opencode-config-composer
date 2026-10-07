import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { compositionFixture } from './composition-fixture.ts';

export interface AvailabilityAgent {
  name: string;
  mode: string;
  hidden?: boolean;
  prompt?: string;
  permission: { permission: string; pattern: string; action: string }[];
  model?: { providerID: string; modelID: string };
}

interface AvailabilityMessage {
  info: { id: string; agent: string; modelID: string; error?: unknown };
  parts: { type: string; text?: string }[];
}

export async function availabilityFixture(t: TestContext, name: string, defaultAgent?: string) {
  const f = await compositionFixture(t, name);
  const nativePath = join(f.host.configRoot, 'opencode.jsonc');
  const native = JSON.parse(await readFile(nativePath, 'utf8')) as {
    default_agent?: string;
    agent: Record<string, unknown>;
  };
  delete native.default_agent;
  if (defaultAgent !== undefined) {
    native.default_agent = defaultAgent;
  }
  native.agent = {
    worker: { mode: 'primary', prompt: 'NATIVE_WORKER' },
    pinned: { mode: 'primary', prompt: 'NATIVE_PINNED', model: 'fixture/alpha' },
    dormant: { mode: 'primary', prompt: 'NATIVE_DORMANT', model: 'fixture/alpha', disable: true },
    concealed: { mode: 'primary', prompt: 'NATIVE_CONCEALED', hidden: true },
    child: { mode: 'subagent', prompt: 'NATIVE_CHILD' },
    general: { disable: true },
    title: { disable: true },
    summary: { disable: true },
  };
  await writeFile(nativePath, JSON.stringify(native));
  await f.write(f.paths.shared, {
    components: {
      agents: {
        workflow: {
          mode: 'primary',
          prompt: 'WORKFLOW_BODY',
          configuration: { model: 'fixture/alpha' },
          disable: true,
        },
        unselected: { mode: 'primary', prompt: 'UNSELECTED_BODY' },
      },
    },
    componentGroups: {
      team: {
        agents: ['build', 'plan', 'worker', 'pinned', 'workflow'],
        configuration: { model: 'fixture/beta' },
      },
    },
    profiles: {
      work: {
        layers: [{ componentGroup: 'team' }],
        overrides: { model: 'fixture/beta' },
        agentAvailability: { workflow: true },
      },
      reduced: { agentAvailability: { build: false, worker: false, pinned: false, workflow: false } },
      restored: { agentAvailability: { build: true, worker: true, pinned: true, workflow: true, dormant: true } },
    },
    activeProfiles: [],
  });
  const agents = () => f.host.api<AvailabilityAgent[]>('/agent');
  const find = async (name: string) => (await agents()).find((agent) => agent.name === name);
  const select = async (profiles: string[]) => {
    await f.saveScope('shared', { operation: 'selection', profiles });
    await f.editor.reload();
  };
  const send = async (
    agent?: string,
    sessionID?: string,
    model?: { providerID: string; modelID: string },
    text = 'Reply with verified.',
  ) => {
    const session =
      sessionID === undefined
        ? await f.host.api<{ id: string }>('/session', { title: 'Availability conversation' })
        : { id: sessionID };
    const before = f.host.requests.length;
    const message = await f.host.api<AvailabilityMessage>(`/session/${session.id}/message`, {
      ...(agent === undefined ? {} : { agent }),
      ...(model === undefined ? {} : { model }),
      parts: [{ type: 'text', text }],
    });
    assert.equal(message.info.error, undefined, JSON.stringify(message.info.error));
    assert.ok(message.parts.some((part) => part.text === 'verified'));
    assert.equal(f.host.requests.length, before + 1, 'one dispatch reaches the synthetic provider');
    return { session, message, captured: f.host.requests.at(-1)! };
  };
  return { ...f, nativePath, agents, find, select, send };
}
