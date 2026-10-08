---
name: config-composer-explain
description: Use when a user asks about OpenCode Config Composer profiles, groups, presets, selection order, permission fallback, prompt fragments, or why saved settings differ from a running conversation.
---

# Explain Config Composer

Explain the saved composition using the user's actual JSONC and the packaged [schema reference](references/schema.md).
Keep native OpenCode settings, Composer contributions, and session selections distinct.

Read the shared configuration, its explicit `imports`, project `.opencode/config-composer.jsonc`, and local
`.opencode/config-composer.local.jsonc` when available. Resolve relative paths from the declaring file.
The `/compose` saved preview shows source paths, ordered profiles, compiled permissions, and field origins.

Use **Compose → Running configuration inspector** for current server `model`, `small_model`, `default_agent`
and running agent settings. Keep **Applied Composer parameters** separate from **Recorded conversation** and
saved pending edits. **Refresh** rereads the server; unavailable applied metadata is not a saved-settings fallback.
Recorded session/request/response values do not reveal the current unsent TUI selection or complete final provider
request parameters. State those limits explicitly. Inspection does not apply settings or send a prompt, and remains
usable for native observations when saved composition is invalid. Values under credential-like option keys are redacted.

State the active selection, replay order, matching contribution, and native fallback. Local `activeProfiles`
replaces the shared/project list; an absent key inherits and `[]` selects none. Definitions alone activate nothing.
A later matching permission rule wins even if looser. An unsupported scope skips its Composer permissions,
warns, and can become more permissive. Session approvals are outside configured previews.

`profileShortcuts` declares named TUI actions with an ordered `activeProfiles` list and optional description.
Invoking one chooses shared, project, or local scope, then previews and saves through Composer's normal flow.
An empty list selects none. Declaring a shortcut does not activate it, apply settings, or send a model prompt.
Native prompt-command and TUI alias collisions require a different shortcut name; refresh shortcuts in `/compose`
after editing their definitions.

Profile `agentAvailability` maps native/component agent names to booleans. Ordered profile occurrences use the
last decision; absence inherits. Disabled definitions, memberships, and history remain intact. Hidden agents
stay hidden when enabled. A visible primary and a valid native `default_agent` must remain; internal
`title`, `summary`, and `compaction` agents cannot be toggled. Inspect the saved availability view for origins.
Apply requires idle work; retry when agents are idle. The TUI falls back to a remaining visible primary, while explicit headless requests
for disabled agents fail; an existing conversation can continue with an explicitly enabled agent.

Saved Composer edits require explicit apply or restart. Apply affects the current instance using its original
running native baseline; native JSON or native-agent edits require restart. Profile switching rebuilds from that baseline and
the destination's ordered profiles, removing old-profile-only contributions while retaining base values the
destination does not override. Conversations remain available. Current TUI sessions may retain their previous
model and variant; use `/models`, then `/variants`, to select the destination/base model and its configured
variant or `Default`. Native explicit agent model pins keep their documented precedence.
If evidence is missing, identify the missing source or native state instead of inventing an effective result.

Common mistakes: treating groups as presets, merging profile-selection lists, assuming a deny always wins,
or claiming a saved preview is an applied revision. Automatic Composer profile/component discovery and a custom lazy-loading engine
are not implemented. Native skills remain on-demand and subject to native permissions.
