---
name: config-composer-create
description: Use when a user wants a new OpenCode Config Composer profile, component group, reusable configuration preset, custom agent, command, skill relationship, or prompt component.
---

# Create Composer configuration

Start from the installed [review example](examples/review.jsonc), then adapt the user's chosen settings.
Read existing scope files and explicit imports first. Preserve native definitions, explicit model pins,
JSONC comments, and unrelated keys. Use unique component/group/profile names and an explicit writable destination.

Define reusable components, a mixed `componentGroups` bundle, and reusable `configurationPresets` separately.
A profile's ordered `layers` first selects a group, then assigns a preset to already selected agents or groups.
`plan` and `explore` refer directly to native built-ins: no shadow agent files or invented native prompts are needed.
Custom agents need an inline prompt or explicit Markdown file. Skill components need an explicit native
`SKILL.md` path; an agent's `skills` relationship neither injects its body nor grants permission.

The example's `opencode:model` requires an effective `model` value after global Composer contributions.
If none exists, choose a real available
model or omit that reference; retain the permission-only preset. Validate parameters against that model's
capabilities. Keep permission rules ordered: a later matching allow can replace an earlier deny. Review any
compiler warning and its potentially more permissive native fallback.

Prepare a reviewable JSONC edit and inspect it with `/compose`. The packaged example contains definitions only and is safe to import without activating a profile.
Definitions stay inactive until explicitly selected. If activation was requested, establish its scope and complete ordered list; otherwise preserve every
`activeProfiles` field. Local lists replace rather than append, and `[]` selects none. Save preserves conversations. Apply through explicit reload or restart;
current reload affects all workspaces on the server. An existing session model selection can still override defaults.

Common mistakes: placing native configuration under Composer's `components`, assigning a preset before
selecting its target, moving native built-ins into custom files, or silently overwriting an imported source.
