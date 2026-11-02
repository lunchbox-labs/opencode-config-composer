---
name: native-package-verification
description: Use when selecting or reporting checks for Config Composer source, packaging, native OpenCode behavior or contributor workflow changes.
---

# Native and package verification

Read package.json, tests/opencode.json and the affected tests before selecting checks. Use the supported Node version and existing dependencies (`npm ci` when installation is needed). Keep test state isolated; do not use a personal OpenCode configuration or paid model/provider calls.

- For source changes, run `npm run check`: static checks, unit tests and packed-package tests are included. Do not describe this as native integration coverage.
- For package exports, shipped files or build changes, use `npm run test:package` if the aggregate was not run. Inspect `npm pack --dry-run --json` contents: the shipped `skills/config-composer-create` and `skills/config-composer-explain` are end-user features; contributor `.agents`, `.codex`, `.claude`, `.opencode`, AGENTS.md and CLAUDE.md must stay out of the artifact.
- For host behavior, run `npm run test:integration` or an applicable existing `-- --suite <name>` from scripts/integration.mjs. Profile/model changes map to `profile`; permission ordering to `permissions`; process/worktree state to `core` and `apply`; inspector changes to `inspector`; user interaction to `terminal`; registration to `registration`. Include affected cross-cutting suites rather than treating one mapping as exhaustive.
- `npm run test:native` runs top-level native tests; it does not replace nested integration suites. Inspect scripts/opencode.mjs and scripts/integration.mjs for OPENCODE_BIN and OPENCODE_TEST_VERSION support. Use an available compatible host or the repository's established installer; report unavailable tooling and do not substitute parser mocks for native evidence.
- For instruction-only changes, validate YAML/TOML metadata, canonical references, conditional routing and package exclusion. Check discovery with installed runtimes without issuing model calls: OpenCode `debug skill` and `debug agent <name>`; use available non-generating discovery in Codex/Claude. Report discovery separately from invocation; do not claim an agent was invoked merely because its file parsed.

Record commands, outcomes, host version/platform, coverage boundaries and unavailable checks. Give this evidence to an independent reviewer where AGENTS.md calls for review; this skill itself is a verification workflow, not another mandatory review role.
