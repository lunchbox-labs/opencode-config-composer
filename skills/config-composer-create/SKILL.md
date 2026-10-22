---
name: config-composer-create
description: Create a shared Config Composer definition file for existing native agents and commands.
---

Read the current definition and native target names before editing. Use the packaged schema and [review example](examples/review.jsonc). Ask for the destination if it is not known. Do not create or rewrite native prompt bodies.

Author one JSONC file with optional `groups`, `agent`, `command`, `model`, `small_model`, `profiles`, and `defaultProfile`. Group membership is centralized under `members.agent` and `members.command`. All groups always apply. Profile `groups` references root names and may override their agent or command patches without changing membership. One profile can be selected per worktree. Validate inactive profiles too.

Authored native agent frontmatter always overrides Composer settings, including literal empty values. Model and variant are independent. Options replace the entire field. Permission objects replace exact tool blocks; frontmatter permission replaces the whole policy. Never invent a command variant.

Use `/compose-configs` to choose a profile, preview, confirm selection, and apply while idle. This release's UI changes selection only; author definitions directly in the shared JSONC file. Existing session model/variant choices can remain retained. Native metadata changes require restarting OpenCode before review.
