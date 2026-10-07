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

State the active selection, replay order, matching contribution, and native fallback. Local `activeProfiles`
replaces the shared/project list; an absent key inherits and `[]` selects none. Definitions alone activate nothing.
A later matching permission rule wins even if looser. An unsupported scope skips its Composer permissions,
warns, and can become more permissive. Session approvals are outside configured previews.

`profileShortcuts` declares named TUI actions with an ordered `activeProfiles` list and optional description.
Invoking one chooses shared, project, or local scope, then previews and saves through Composer's normal flow.
An empty list selects none. Declaring a shortcut does not activate it, apply settings, or send a model prompt.
Native prompt-command and TUI alias collisions require a different shortcut name; refresh shortcuts in `/compose`
after editing their definitions.

Saved Composer edits require explicit apply or restart. Apply affects the current instance using its running native
baseline; native JSON edits require restart. Existing session
model selections remain. Native defaults and explicit agent model pins can survive profile changes.
If evidence is missing, identify the missing source or native state instead of inventing an effective result.

Common mistakes: treating groups as presets, merging profile-selection lists, assuming a deny always wins,
or claiming a saved preview is an applied revision. Automatic Composer profile/component discovery and a custom lazy-loading engine
are not implemented. Native skills remain on-demand and subject to native permissions.
