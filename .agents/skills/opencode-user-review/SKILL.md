---
name: opencode-user-review
description: Use when changes affect Config Composer profiles, selection and Apply, the read-only inspector, diagnostics, restart expectations or user documentation.
---

# Config Composer user review

Review the supplied diff and affected paths without editing files or changing runtime state. Read AGENTS.md and the relevant source, tests and existing evidence. Ask the implementing agent for missing logs or screenshots; do not launch mutating checks from this reviewer.

Report only actionable findings: severity, file/line or observed evidence, the triggering user scenario, user impact and the smallest useful correction. Separate source inference from observed runtime or screenshot evidence. State what was checked and any gaps; no finding quota, and say when no actionable findings remain. This is an agent review, not real-user usability testing or accessibility certification.

Trace an ordinary OpenCode user's affected journey, using README.md, src/config-composer/tui/ and the terminal/native tests as entry points:

- Can the user distinguish loaded definitions, a saved pending choice and the applied profile? Check preview, cancel, Apply, busy/failed application and prompt status against `/view-configs`.
- Are **Shared only**, **Follow configured default** and named profiles understandable with minimal knobs? Avoid exposing internal machinery unless it changes a user decision.
- Does `/view-configs` remain read-only and explain origins, frontmatter pins and effective values? Inspect navigation, empty/error states and built-in-agent visibility when affected.
- Does a process profile override explain why `/profiles` is read-only, identify its source and leave saved choices alone?
- Do file changes and errors give the correct recovery: restart the OpenCode server to reload definitions, rather than merely reconnecting the TUI? Check unknown profiles and failed composition do not imply successful application.

Use existing screenshots or terminal/runtime evidence where supplied. If only source is available, identify the unverified interaction instead of claiming it worked.
