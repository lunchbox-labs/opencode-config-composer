# Per-project profile selection

Use [config-composer.jsonc](config-composer.jsonc) as a selection-policy example; add your component groups and
preset layers to the empty profiles. Each project starts with `development` until it has its own saved choice.
Switch to `review` in Compose or use a profile shortcut. The switch changes external project state, leaving
this file unchanged. **Use configured defaults** restores `development` without editing the default list.

Set `retainOnRestart` to `false` to start from configured defaults in each fresh OpenCode server process.
Instance apply/reload preserves the selection; new conversations do not reset it. Different projects sharing
this file keep independent selections. Composition is project-wide, so simultaneous conversations in one
project use the same applied configuration. Saving remains separate from explicit idle-checked apply.

OpenCode 1.18.34 uses an absolute `XDG_STATE_HOME` when set, otherwise
`<home>/.local/state`, on both Linux and Windows. Composer uses its `opencode/config-composer/v1/`
subdirectory. Retained choices live in `projects/<identity-hash>.json`; transient choices live in
`processes/<server-lifetime>/<identity-hash>.json`. Identity combines the canonical project composition
root and base configuration path. It does not use Git remote URLs or the non-Git `global` project ID.

A server-created proof file verifies that attached editors share this state filesystem before saving.
Sharing configuration or project mounts alone is insufficient. Writes use revision checks, exclusive
locks and same-directory atomic replacement; cooperating definition saves and selection saves share a
transaction lock. Stale locks require manual review. Old process namespaces are not automatically
removed and can be removed once those server processes have stopped.
