---
name: config-composer-migrate
description: Use when Config Composer rejects legacy composition keys or a user wants to convert older groups, model presets, permission maps to the canonical profile format.
---

# Migrate Composer configuration

Use the [before](examples/before.jsonc), [after](examples/after.jsonc), and unchanged
[native agent](examples/worker.md) examples as a small, concrete mapping. Their provider IDs are synthetic;
retain the user's actual model IDs and validated variants. There is no legacy compatibility mode.

Inventory actual Composer sources, native JSON/Markdown agents, explicit model pins, prompt text, and group
membership first. Prepare a reviewable change to Composer JSONC. Native OpenCode files remain native; a
legacy top-level `agent` in Composer settings is not an instruction to move native agents into components.

| Legacy Composer field                   | Canonical destination                                                              |
| --------------------------------------- | ---------------------------------------------------------------------------------- |
| `agent.groups.<name>`                   | `componentGroups.<name>.configuration` plus retained membership                    |
| `agent.modelPresets`                    | `configurationPresets`                                                             |
| `agent.permission` in permission drafts | `defaults.permissions`                                                             |
| Group or agent override permission map  | Ordered `configuration.permissions` or `overrides.agents.<name>.permissions` array |

For a permission-draft source, first establish its original scope and precedence; the released legacy
format did not support every draft permission field. Convert each permission map entry in authored order into `{tool, pattern, action}`; omitted pattern means
all inputs. Preserve later looser matches. Do not flatten separate contributions or claim an unsupported
native ordering is equivalent. Review compiler warnings: an unsupported scope skips its Composer permissions
and may fall back to more permissive native rules.

Create explicit profiles selecting the groups that previously contributed. The example activates `migrated`
to preserve its single native worker's prior behavior. For real configurations, inventory every consumer of
old defaults and overrides: canonical agent settings affect selected agents only, and overrides require selected
targets. Legacy frontmatter group order could differ per agent, while canonical profile layer order controls
replay for all targets. Compare each affected agent before translating multiple groups; retain differing
behavior with explicit targeted layers/overrides only after proving equivalence. Preserve configured-default scope precedence; a local default list replaces the shared list. Imported files must not
contain top-level selection, defaults, overrides, or activeProfiles; keep those in scope files.

Validate the candidate and review sources, selected agents, pins, permission outcomes, and
unchanged native bytes. Save and apply are separate; reload or restart only when requested. Apply affects the current
instance using the running native baseline; native JSON or native-agent edits require restart. Current TUI sessions may retain a
previous model and variant after apply. Select the destination/base model through `/models`, then its configured
variant or `Default` through `/variants`; conversation history is preserved. Report unproven equivalence or
missing source evidence explicitly rather than silently deleting unknown settings or adding a fallback mode.


For selection-state migration, move each scoped `activeProfiles` list to `selection.defaultProfiles` in the same file, preserving order, scope precedence and explicit `[]`. Review all scopes together: any configured `selection.defaultProfiles` takes priority over the legacy fallback. Existing fields remain readable until this explicit migration. Profile switching and shortcuts write external per-project state only. `selection.retainOnRestart` defaults to true; false resets on server restart, not a new session or an attached TUI disconnect.
