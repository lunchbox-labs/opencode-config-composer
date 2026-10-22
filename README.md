# Config Composer

Compose settings for existing OpenCode agents and commands using one shared JSONC file, always-active groups, and one selected profile per worktree. Tested against OpenCode 1.19.x. This project is licensed under MIT. Native Markdown owns agent prompts and command templates; Composer changes settings only.

Register `@lunchbox-labs/opencode-config-composer` in the `plugin` array of both native `opencode.jsonc` and `tui.jsonc`. The package exports `.`, `./server`, `./tui`, and `./schema.json`; helpers are internal.

The definition file defaults to `configurationDirectory()/config-composer.jsonc` (the OpenCode config directory, honoring `OPENCODE_CONFIG_DIR`). A plugin tuple may specify `{ "configFile": "settings/composer.jsonc" }`; relative paths resolve in that directory. An absent implicit file means an empty installation. An explicitly configured missing file is an error. There is no project source stack.

```jsonc
{
  "$schema": "https://unpkg.com/@lunchbox-labs/opencode-config-composer/schema.json",
  "groups": [
    {
      "name": "reviewers",
      "members": { "agent": ["plan", "explore"] },
      "agent": { "temperature": 0.2 }
    }
  ],
  "profiles": {
    "review": { "groups": [{ "name": "reviewers", "agent": { "temperature": 0 } }] }
  },
  "defaultProfile": "review"
}
```

Use `/compose-configs` → Profile → choose → preview → Apply. Definitions are shared across projects; selection persists for the canonical source and current worktree. **Use configured default** follows `defaultProfile`; **No profile — keep shared settings** retains all shared groups and named settings. Choosing a profile does not edit `defaultProfile`. A missing saved profile remains recoverable through Profile.

Profile edits concrete profile settings and group patches. Groups edits shared settings, central membership, and common-group order; membership toggles stay staged until reviewed. Effective shows configured values beside verified-applied values, raw frontmatter pins, and blocked Composer candidates, with explicit shared/profile destinations for named exceptions. Shared and profile global `model` / `small_model` settings have separate destinations. Inherit removes an authored setting; variant Default writes an empty string. Document edits preserve unaffected JSONC comments and file mode. Native JSON and Markdown remain read-only.

Precedence is root groups in array order → native settings → root named settings → selected profile groups in array order → selected profile named settings → actual authored agent frontmatter. Every group applies. Profile group references use root membership. Omitted frontmatter fields do not pin synthetic native defaults. Authored fields always win, including empty strings, zero, false, and empty objects. Across native Markdown roots, the last source authoring a field wins the entire field, even over a later native JSON value.

Agent patches allow `model`, `variant`, `temperature`, `top_p`, `options`, `mode`, and `permission`. Command patches allow `agent`, `model`, and `subtask`. Global `model` and `small_model` affect only the corresponding native global fields. Models use `provider/model`; variant is independent and an empty variant means configured Default. Native empty models remain inherited. Composer never creates prompt content or enables disabled agents.

`options` replaces the whole field. A Composer permission object replaces each touched exact tool block, moving that tool to incoming order; a pattern map replaces the whole block. Untouched keys retain their order. Composer `{}` contributes no changes. A scalar action replaces the policy. Authored frontmatter options and permissions replace the whole final field, including `{}`; scalar permission becomes `{ "*": action }`. Native `/agent` may still contain builtin or global permission inheritance even when `/config` has an empty agent policy.

Unknown keys, duplicate keys, duplicate groups or members, unknown targets, and invalid references fail before applying. All profiles are validated, including inactive profiles. A retained native default agent must remain enabled, visible, and not a subagent.

Document and selection save/apply verify the shared filesystem, connection, source, selection, and native observations. Changed native Markdown requires: “Native agent metadata changed. Restart OpenCode, then review again.” Native JSON changes also require a restart because the native global cache cannot be refreshed by instance disposal. Busy instances are not disposed. A busy or failed apply reports **Saved; not applied** and offers a guarded retry. The public API has no conditional dispose transaction, so there is a small race after the last idle check.

Applying config does not clear every native session model or variant. Existing conversations remain saved; use `/models` and `/variants` to change retained selections. The inspector distinguishes configured effects from stored session fallback and does not claim to observe final provider parameters.

Run `npm run check` for static, unit, and installed production-package checks. `npm run test:integration` exercises isolated native installations on the supported Linux and Windows CI matrix. No personal config or credentials are used by these fixtures.
