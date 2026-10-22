---
name: config-composer-create
description: Create a shared Config Composer definition file for existing native agents and commands.
---

Read the current definition and native target names before editing. Use the packaged schema and [review example](examples/review.jsonc). Ask for the destination if it is not known. Do not create or rewrite native prompt bodies.

Author one JSONC file with optional `groups`, `agent`, `command`, `model`, `small_model`, `profiles`, and `defaultProfile`. Group membership is centralized under `members.agent` and `members.command`. All groups always apply. Profile `groups` references root names and may override their agent or command patches without changing membership. One profile can be selected per worktree. Validate inactive profiles too.

Authored native agent frontmatter always overrides Composer settings, including literal empty values. Model and variant are independent. Options replace the entire field. Permission objects replace exact tool blocks; frontmatter permission replaces the whole policy. Never invent a command variant.

Use `/profiles` for a direct worktree choice: Follow configured default, Shared only, or a named profile. Preview and Apply while idle. `/view-configs` inspects shared groups, every profile, fields, source origins, final raw pins and verified applied values. Edit the definition file externally, then use `/reload-configs` to reload this idle instance. Native Markdown and project JSON reload; changed native global JSON requires restarting the OpenCode server process. Initial global cache freshness cannot be proven by disk hashes. Failed application remains pending. Existing session model/variant choices can remain retained.
