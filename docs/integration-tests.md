# Native integration tests

Run `npm ci` and `npm run test:integration` with Node 24 on Linux x64 or Windows x64.
The command builds the package, installs the exact OpenCode version from
`engines.opencode` (currently **1.18.34**), verifies its reported version, packs Composer,
and installs the tarball in temporary consumer projects. Set `OPENCODE_BIN` to an
existing binary to avoid downloading it; a version mismatch fails the run.

The **Integration** workflow runs the same functional cases on `ubuntu-latest` and
`windows-latest` for pull requests and pushes to `main`. Manual dispatch is also
available after the workflow reaches the default branch. Both matrix jobs finish
independently. New pushes cancel obsolete integration runs for that pull request.
The existing **Check** workflow remains unchanged.

## What the harness exercises

OpenCode runs as a real local server. Requests go to a deterministic HTTP provider
bound to loopback. That provider returns fixed text or requests a native skill call;
OpenCode performs composition, model dispatch, tool execution and permission checks.
Assertions inspect public host responses, native tool results, captured provider
requests, and saved file bytes. Debug CLI output is not part of the test contract.
There are no genuine provider API calls or provider secrets.

Every fixture has separate home, configuration, cache, data, state and session database
paths. Temporary paths contain spaces. Only OS launch variables and network transport
(proxy/CA) settings needed for host dependency installation are inherited. Provider
credentials and personal OpenCode configuration are excluded. File watchers are disabled;
tests distinguish saved settings from settings applied by an explicit reload. Fixtures
are deleted after the host stops, including on failures.

The persistence tests import the **installed** editor implementation and connect its
reload callback to the real OpenCode API. They exercise the storage used by the TUI;
they do not establish that every interactive menu action works. No source implementation
is substituted, and no unimplemented feature is represented by a skipped test.

## Coverage matrix

| Capability | Observable evidence | Coverage / remaining work |
| --- | --- | --- |
| Built package and pinned host | Installed tarball, native version check, separate consumer dependency tree | Both platforms; package/declaration checks also run in Check |
| Dedicated/custom settings | Custom plugin options, settings-relative source paths, preserved JSONC comments | Both platforms |
| Agent model presets and ordered groups | Effective native agents and captured model/variant requests; explicit agent pins; project model/small-model references | Both platforms |
| Built-in/custom membership | JSONC membership on native build/plan/explore; custom frontmatter; shared ordered model groups, no shadow agent files, unchanged native fields/permissions | Both platforms for implemented model groups; Composer permission overlays and final presets require #33 and canonical-schema integration |
| Session model selection | Captured explicit model and variant override | Both platforms |
| Prompt composition | Authored Markdown, group/default order, per-agent inheritance, nested includes, provider-visible text | Both platforms |
| Native skills | Expanded native tool result and following provider request; metadata and companion files | Both platforms |
| Native permissions | Actual allow, deny and interactive ask decisions; denied content never reaches provider | Both platforms; Composer permission-group composition is separate work in [#33](https://github.com/lunchbox-labs/opencode-config-composer/pull/33) |
| Save and apply | Installed editor saves, unchanged active cache before reload, actual reload API, repeated reload without duplicate prompts | Both platforms |
| Removed contributions | Ordered membership replacement, empty membership removal, explicit pin/clear and captured dispatch | Both platforms |
| Persistence | Multi-file save, process restart, retained session messages and settings | Both platforms |
| Invalid/concurrent edits | Rejected referenced-preset deletion, malformed preset, lock collision, stale snapshot, malformed JSONC; byte comparisons and lock cleanup; failed prompt composition leaves native settings unmodified | Both platforms; exhaustive rollback/fault combinations remain covered by focused unit tests |
| Terminal menus | Packaged entrypoint and both existing menus render through a real pseudo-terminal | Existing Linux Check only; Windows terminal driving and complete interaction/save/reload flows remain open |
| Composer model defaults | Native overrides, fallback removal and session interactions | Await integration of [#31](https://github.com/lunchbox-labs/opencode-config-composer/pull/31) |
| Typed model parameters | Provider request mapping, variant precedence, title/compaction parameters and removal | Await integration of [#34](https://github.com/lunchbox-labs/opencode-config-composer/pull/34); its existing native request assertions supply regression cases |
| Components, component groups, configuration presets | Canonical schema, explicit imports, resolution and validation | Schema contract in [#36](https://github.com/lunchbox-labs/opencode-config-composer/pull/36); runtime/import assembly pending |
| Profiles and ordered `activeProfiles` | Local replacement; absent inherits; empty disables; ordering, reload and persistence | Schema contract in [#36](https://github.com/lunchbox-labs/opencode-config-composer/pull/36); runtime integration pending; [#30](https://github.com/lunchbox-labs/opencode-config-composer/pull/30) is earlier source/profile work |
| Compose TUI and provenance | Real terminal navigation, inspection, selection, save/apply and error flows | Await integration of [#32](https://github.com/lunchbox-labs/opencode-config-composer/pull/32) and the final profile UI |
| Automatic source discovery | Discovery boundaries and precedence | Deferred; explicit imports come first |

Final acceptance must cover actual tool decisions after invalid or unsupported configuration (including swallowed host hook errors), group presets, Composer permission/model overlays and deterministic ordering across both built-in JSONC and custom frontmatter membership, while preserving unspecified native behavior.

The final feature integration PR must complete the applicable pending rows against
real implementations before claiming full feature coverage. This infrastructure PR
does not claim profiles, future schema behavior, Composer permission groups or complete
TUI coverage.

OpenCode 1.18.34 catches plugin configuration-hook errors and can continue with native
settings. The invalid-include case verifies that Composer applies no partial prompt or
model overlay and that a corrected reload recovers. It does **not** establish that the
host blocks subsequent model requests after such an error. Invalid JSONC rejected by
the editor before reload leaves the previous active settings in effect.

## Diagnostics and limits

Failure artifacts contain only bounded runner/host logs, synthetic request captures,
and version metadata in `integration-results/`. Each log/capture is capped at 64 KiB;
the current suite produces less than 400 KiB before compression. Databases, dependency
trees and caches are excluded. CI uploads these files only on failure with three-day
retention. Successful runs upload nothing. No Actions cache is configured.

Jobs use standard public runners, `contents: read`, and a 15-minute job timeout, with
shorter install, request, test and process limits. This workflow adds no required-check
or branch-protection rules. Linux verification locally cannot substitute for the Windows
CI result. The terminal smoke test uses POSIX pseudo-terminal APIs and is deliberately
outside this portable functional suite; no Linux command is presented as Windows coverage.
