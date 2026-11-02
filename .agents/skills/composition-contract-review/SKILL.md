---
name: composition-contract-review
description: Use when Config Composer changes group or profile composition, native frontmatter authority, permission ordering, model bindings or process/worktree state.
---

# Composition contract review

Review the supplied diff and affected paths without editing files or changing runtime state. Read AGENTS.md and the relevant source, tests and existing evidence. Ask the implementing agent for missing logs or screenshots; do not launch mutating checks from this reviewer.

Report only actionable findings: severity, file/line or observed evidence, the triggering user scenario, user impact and the smallest useful correction. Separate source inference from observed runtime or screenshot evidence. State what was checked and any gaps; no finding quota, and say when no actionable findings remain. This is an agent review, not real-user usability testing or accessibility certification.

Use skills/config-composer-explain/references/schema.md as the detailed contract; trace affected code in src/config-composer/composition/, frontmatter.ts, membership.ts and storage.ts against native/integration evidence.

- Check membership order, not definition-map order. Each group receives its selected-profile patch before the next group; root and profile named-agent patches follow. Actual authored frontmatter remains final, including empty options and model pins; native prompts and command bodies stay host-owned.
- Trace permission decisions through native defaults, profile-wide defaults, ordered group pairs, named patches and authored rules. Touched tool blocks move last with retained patterns; duplicate patterns move last within a block. Check real allow/ask/deny outcomes, not just serialized maps.
- Check whole model-binding replacement, omitted variant defaults, explicit patch variants, profile-only aliases and binding parameters tied to the actual model. Do not confuse concrete model patches with alias replacement.
- Verify source/worktree identity, saved versus applied selection, process override precedence and isolation between worktrees and simultaneous processes. Process overrides must not read/write saved selections. Loaded definitions remain captured until server restart; busy/failed Apply stays pending.
- Inspect error paths and unaffected native/session behavior. Require real host evidence for host-dependent claims; parser mocks alone cannot establish native precedence, permission enforcement or lifecycle behavior.
