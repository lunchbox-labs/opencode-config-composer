# Agent instructions

Read the applicable shared Lunchbox Labs standards before editing this repository:

- [Common agent guidance](https://github.com/lunchbox-labs/.github/blob/main/agent-guidance/common.md)
- [Workflow conventions](https://github.com/lunchbox-labs/.github/blob/main/agent-guidance/workflows.md)
- [npm package conventions](https://github.com/lunchbox-labs/.github/blob/main/agent-guidance/npm-packages.md)

These documents must be read explicitly; GitHub does not automatically inherit them here.

`npm run check` includes static checks, unit tests, and packed-package tests. Native integration uses `npm run test:integration`; the local native suite uses `npm run test:native`.

Write documentation for knowledgeable OpenCode users: explain plugin-specific concepts without host or package-install basics or unnecessary cautions. Keep installation examples simple and unversioned. Use short, relevant README snippets and put full, simple, realistic examples in `docs/examples/`. Omit maintainer publishing and release-process walkthroughs; release notes are still appropriate.

## Contributor workflows

Use independent `opencode-user-review` for changes to profiles, selection/Apply, inspector, diagnostics or user-facing documentation. Use independent `composition-contract-review` for composition, frontmatter authority, permissions, models or process/worktree state changes. Use both when both surfaces change; unrelated changes do not need these specialist reviews. Supply the diff, affected paths and actual test/runtime evidence, then address findings and recheck fixes.

Canonical procedures live in `.agents/skills/<name>/SKILL.md`; brief native agent files in `.codex/agents`, `.claude/agents` and `.opencode/agents` load them. Codex reviewer permissions inherit the parent; non-editing is an instruction, not a separate sandbox. Claude/OpenCode adapters restrict tools to reading evidence. If native delegation is unavailable, give an independent reviewer the canonical file and report the discovery/invocation gap.

Use `.agents/skills/native-package-verification/SKILL.md` to select applicable checks; it is not an additional review role. Claude's `.claude/skills` entries forward to the same procedures. Keep contributor workflows separate from the shipped end-user `skills/` directory.
