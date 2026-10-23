---
name: config-composer-explain
description: Explain Config Composer groups, profile selection, precedence, and runtime evidence.
---

Use [the schema reference](references/schema.md) and `/view-configs` for server-attested field decisions. Do not reconstruct authored frontmatter from normalized native config. Explain the configured value, its origin, and any blocked Composer candidate.

For `modelRef`, explain both the consuming patch and the root or selected-profile `models` binding shown by inspection. Profile bindings replace whole model/variant choices; absent binding variants reset to native default. Explicit referencing variants, later patches and final frontmatter may override them. A profile-only alias contributes no model or variant in Shared only; an active consumed reference without a root or selected-profile binding is an error.

Definitions are shared; selection is per canonical source and worktree. Each agent owns its ordered groups. The catalog defines settings, and profiles patch those settings without owning membership. For each membership entry, apply the shared group and then its selected profile patch; later membership entries win overlaps. Follow default and None are distinct. A failed composition publishes “Composer not applied” and has no applied revision. A valid authority permits selecting a valid profile to recover.

Definitions and their source/state identity remain those loaded for each directory/worktree in the server process. Edits require restarting the OpenCode server process; reconnecting the TUI does not load them. `/view-configs` reads loaded attestation and the current external choice, so file edits do not change inspection. `/profiles` switches among loaded profiles, the loaded default, and Shared only.

Native bodies remain opaque and host-owned. Profile application uses the idle native instance lifecycle and refuses directly observed native file changes with a restart instruction. Failed startup with incomplete attestation requires correcting the input and restarting the server. Saved choices remain pending if application cannot be verified. Applying does not reliably clear retained session model/variant selections; recommend native `/models` or `/variants` when the user wants to change those selections. Other plugins' inputs and host lifecycle remain independent.
