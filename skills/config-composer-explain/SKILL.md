---
name: config-composer-explain
description: Explain Config Composer groups, profile selection, precedence, and runtime evidence.
---

Use [the schema reference](references/schema.md) and `/compose-configs` → Effective for server-attested field decisions. Do not reconstruct authored frontmatter from normalized native config. Explain the configured value, its origin, and any blocked Composer candidate.

Definitions are shared; selection is per canonical source and worktree. Root groups always apply. Follow default and None are distinct. A failed composition publishes “Composer not applied” and has no applied revision. A valid authority permits selecting a valid profile to recover.

Native bodies remain opaque. Native Markdown changes require a restart before review; native JSON has a separate global cache restart requirement. Applying does not reliably clear all retained session model/variant selections. Inspect stored fallback separately and recommend `/models` or `/variants` when the user wants to change those selections.
