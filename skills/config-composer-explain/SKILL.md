---
name: config-composer-explain
description: Explain Config Composer groups, profile selection, precedence, and runtime evidence.
---

Use [the schema reference](references/schema.md) and `/view-configs` for server-attested field decisions. Do not reconstruct authored frontmatter from normalized native config. Explain the configured value, its origin, and any blocked Composer candidate.

Definitions are shared; selection is per canonical source and worktree. Root groups always apply. Follow default and None are distinct. A failed composition publishes “Composer not applied” and has no applied revision. A valid authority permits selecting a valid profile to recover.

Native bodies remain opaque. With complete runtime attestation, `/reload-configs` reloads native Markdown and project JSON in this idle instance. Changed native global JSON requires restarting the OpenCode server process. If failed bootstrap leaves incomplete native attestation, correct the input and restart the server before reviewing. Applying does not reliably clear all retained session model/variant selections. Inspect stored fallback separately and recommend `/models` or `/variants` when the user wants to change those selections.

Use `/profiles` to choose the worktree profile and `/reload-configs` after supported external changes. Native global JSON changes require restarting the OpenCode server process.
