import assert from 'node:assert/strict';
import test from 'node:test';
import { readCompositionDocument } from '../src/config-composer/composition/document.ts';
import { resolveGroupAgentNames } from '../src/config-composer/composition/membership.ts';
import type { AgentSettings } from '../src/config-composer/settings.ts';

test('JSONC group membership accepts native names without shadow component declarations', () => {
  // Observed in OpenCode v1.18.34 agent/agent.ts; this fixture is not a runtime allowlist.
  const names = ['build', 'plan', 'general', 'explore', 'compaction', 'title', 'summary'];
  const available: Record<string, AgentSettings> = Object.fromEntries(
    names.map((name) => [name, { prompt: `${name} baseline` }]),
  );
  const document = readCompositionDocument({ componentGroups: { native: { agents: names } } });
  assert.equal(document.components, undefined);
  assert.deepEqual(resolveGroupAgentNames('native', document.componentGroups ?? {}, available), names);
  assert.deepEqual(available, Object.fromEntries(names.map((name) => [name, { prompt: `${name} baseline` }])));
});

test('membership resolves against the supplied host registry rather than a built-in allowlist', () => {
  assert.deepEqual(
    resolveGroupAgentNames('native', { native: { agents: ['host-extension'] } }, { 'host-extension': {} }),
    ['host-extension'],
  );
  assert.throws(() => resolveGroupAgentNames('native', { native: { agents: ['build'] } }, {}), /build.*unavailable/);
  assert.throws(
    () => resolveGroupAgentNames('native', { native: { agents: ['build'] } }, { build: { disable: true } }),
    /build.*disabled/,
  );
});

test('JSONC and custom frontmatter membership form a stable union without duplicate contributions', () => {
  const groups = { review: { agents: ['build', 'reviewer'] }, coding: {} };
  const available: Record<string, AgentSettings> = {
    writer: { options: { groups: ['coding', 'review'] }, model: 'fixture/pinned' },
    reviewer: { groups: ['review', 'coding'], prompt: 'Custom baseline' },
    build: { prompt: 'Native baseline' },
    alpha: { groups: ['review'] },
    disabled: { disable: true, groups: ['review'] },
  };
  const before = structuredClone(available);
  assert.deepEqual(resolveGroupAgentNames('review', groups, available), ['build', 'reviewer', 'alpha', 'writer']);
  assert.deepEqual(resolveGroupAgentNames('coding', groups, available), ['reviewer', 'writer']);
  assert.deepEqual(resolveGroupAgentNames('review', groups, Object.fromEntries(Object.entries(available).reverse())), [
    'build',
    'reviewer',
    'alpha',
    'writer',
  ]);
  assert.deepEqual(available, before, 'membership must preserve prompts, pins, permissions, and authored group order');
});

test('frontmatter membership retains existing validation and direct-field precedence', () => {
  assert.deepEqual(
    resolveGroupAgentNames(
      'review',
      { review: {}, coding: {} },
      { worker: { groups: ['review'], options: { groups: ['coding'] } } },
    ),
    ['worker'],
  );
  assert.throws(() => resolveGroupAgentNames('review', { review: {} }, { worker: { groups: ['missing'] } }), /missing/);
  assert.throws(
    () => resolveGroupAgentNames('review', { review: {} }, { worker: { groups: ['review', 'review'] } }),
    /duplicate/,
  );
  assert.throws(
    () => resolveGroupAgentNames('review', { review: {} }, { worker: { agent_group: 'review' } }),
    /agent_group/,
  );
});
