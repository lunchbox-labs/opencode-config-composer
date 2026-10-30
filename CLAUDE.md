# Claude Code instructions

@AGENTS.md

## Claude Code notes

- The shared Lunchbox Labs standards linked from `AGENTS.md` are in the public `lunchbox-labs/.github` repository
  under `agent-guidance/`. Read `common.md`, `workflows.md`, and `npm-packages.md` before editing. In cloud sessions
  look for a checkout at `../lunchbox-labs/.github`; clone `https://github.com/lunchbox-labs/.github` there when absent.
- Install with `npm ci`. Node 22.18 or newer is required; CI runs Node 24.
- `npm run check` runs typecheck, lint, format check, unit tests, and the packed-package test.
- Native suites (`tests/*.native.ts`) need x64 Linux or Windows. `npm run test:native` installs the newest
  `opencode-linux-x64` release in the range from `tests/opencode.json` into a temporary directory. Set `OPENCODE_BIN`
  and `OPENCODE_TEST_VERSION` to reuse an installed binary; `node scripts/opencode.mjs install <dir>` installs one.
  `OPENCODE_TEST_VERSION=minimum` selects the floor version.
- `npm run test:integration` runs the suites under `tests/integration/` against the built package.
