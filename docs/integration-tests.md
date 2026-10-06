# Native integration tests

Run `npm ci` and `npm run test:integration` with Node 24 on Linux x64 or Windows x64.
The command builds the package, installs the exact OpenCode version from
`engines.opencode` (currently **1.18.34**), verifies its reported version, packs Composer,
and installs the tarball in temporary consumer projects. It also installs and checksum-verifies
the real ripgrep 15.1.0 binary used by the pinned host on both platforms before startup,
so reload cannot interrupt OpenCode’s lazy dependency download. Set `OPENCODE_BIN` to an
existing binary to avoid downloading it; a version mismatch fails the run.
Before host startup, the harness installs the matching public `@opencode-ai/plugin`
dependency in the fixture's shared and existing project configuration directories.
OpenCode normally initializes those dependencies during its first request; preparing
them serially within each fixture keeps cold Windows dependency installation outside request
deadlines and prevents its configuration directories from competing for npm resources.
When source creation adds a configuration directory after startup, the same dependency
preparation runs before the next explicit reload. Cancelled creation still leaves the
source absent. Native plugin loading and composition run normally.

The **Integration** workflow runs the same functional cases on `ubuntu-latest` and
`windows-latest` for pull requests and pushes to `main`. Each platform runs nine suites
(`core`, `canonical`, `editor`, `terminal`, `content`, `content-terminal`, `permissions`,
`runtime-terminal` and `cleanup`) so fresh Windows package installations fit the job limits.
A partition check ensures every portable test file runs exactly once per platform.
Run one suite locally with `npm run test:integration -- --suite core`, `--suite canonical`,
`--suite editor`, `--suite terminal`, `--suite content`, `--suite content-terminal`,
`--suite permissions`, `--suite runtime-terminal` or `--suite cleanup`; the default command runs all nine. Manual dispatch is also
available after the workflow reaches the default branch. All matrix jobs finish
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
tests distinguish saved settings from settings applied by an explicit reload and wait
for the new token to be visible before dispatching a request. Fixtures
are deleted after the host stops, including on failures. The outer runner owns a
separate fixture root and tracks detached test runners and native hosts so its deadline or cancellation
can clean up even when test hooks never run. Interruption regressions launch the pinned native host
through the same isolated launch and registration helper as functional fixtures. They test process
ownership without installing Composer; functional cases continue to install the tarball.

The persistence, activation and registry tests import the **installed** editor implementation and connect its
reload callback to the real OpenCode API. They exercise the storage used by the TUI;
they do not establish UI confirmation, catalog validation or filesystem authorization by themselves.
The terminal suite separately uses node-pty (PTY on Linux, ConPTY on Windows) and a headless
VT terminal to drive the installed `/compose` interface. Selection waits for the native
search input to gain focus, echo the typed query and highlight the matching filtered option before Enter; command autocomplete
and a dialog’s first paint do not establish input readiness. Assertions read the current screen,
saved JSONC, native state and actual provider requests after explicit reload. No source implementation
is substituted, and no unimplemented feature is represented by a skipped test.

## Coverage matrix

| Capability                                   | Observable evidence                                                                                                                                                                                                                                                                                                              | Coverage / remaining work                                                                                                                                              |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Built package and pinned host                | Installed tarball, native version check, separate consumer dependency tree                                                                                                                                                                                                                                                       | Both platforms; package/declaration checks also run in Check                                                                                                           |
| Dedicated/custom settings                    | Custom plugin options, settings-relative source paths, preserved JSONC comments                                                                                                                                                                                                                                                  | Both platforms                                                                                                                                                         |
| Components and explicit imports              | Installed runtime activates imported agents, commands, skills and named prompts; paths resolve from their declaring files; unimported files stay inactive                                                                                                                                                                        | Both platforms; automatic Composer bundle discovery remains deferred                                                                                                   |
| Canonical profiles                           | Ordered `activeProfiles` replay parent chains; local selection replaces shared selection, absence inherits, and `[]` disables; profile overrides and targeted presets affect actual requests                                                                                                                                     | Both platforms                                                                                                                                                         |
| Model presets and ordered groups             | Captured model/variant requests; preset-reference chains; native agent pins; profile order wins over membership order                                                                                                                                                                                                            | Both platforms                                                                                                                                                         |
| Built-in/custom membership                   | Native build/plan/explore JSONC membership, inline components and custom frontmatter; installed membership editor; unchanged native fields/permissions and no shadow agent files                                                                                                                                                 | Both platforms, including canonical permission overlays                                                                                                                |
| Global model defaults                        | Shared/project/local precedence for `model` and `small_model`; late-bound references; removal restores inherited defaults                                                                                                                                                                                                        | Both platforms                                                                                                                                                         |
| Session model selection                      | Captured explicit model and variant selection compared with a native pinned agent                                                                                                                                                                                                                                                | Both platforms                                                                                                                                                         |
| Typed model parameters                       | Captured temperature, top-p, output-token limit and generic options without a selected variant; removing generic options clears later requests; native variant precedence; model changes clear previous-model parameters                                                                                                         | Both platforms                                                                                                                                                         |
| Utility dispatch                             | Automatic title updates and manually requested compaction summaries, with captured model and parameter values                                                                                                                                                                                                                    | Both platforms; automatic context-triggered compaction remains untested                                                                                                |
| Prompt composition                           | Authored Markdown, inline and file prompt references, group/default order, per-agent inheritance, nested includes, provider-visible text                                                                                                                                                                                         | Both platforms                                                                                                                                                         |
| Commands and native skills                   | Real imported command execution; expanded native skill tool result and following provider request; metadata and companion files                                                                                                                                                                                                  | Both platforms                                                                                                                                                         |
| Native permissions                           | Actual allow, deny and interactive ask decisions; denied content never reaches provider                                                                                                                                                                                                                                          | Native and canonical ordered policies; both platforms                                                                                                                  |
| Canonical editors                            | Imported preset edits reach their declaring writable JSONC; mixed bundles, comments, parameters and inactive permission data survive model-only changes; membership edits do not activate profiles                                                                                                                               | Both platforms; preservation of inactive permission data does not establish enforcement                                                                                |
| Save and apply                               | Installed editor saves, unchanged active cache before reload, actual reload API, repeated reload without duplicate prompts                                                                                                                                                                                                       | Both platforms                                                                                                                                                         |
| Removed contributions                        | Membership replacement, explicit pin/clear, profile deselection restores the complete native agent registry and removes imported commands/skills                                                                                                                                                                                 | Both platforms                                                                                                                                                         |
| Persistence                                  | Multi-file save, process restart, retained session messages, profile activation and imported settings                                                                                                                                                                                                                            | Both platforms                                                                                                                                                         |
| Generated-agent ownership                    | The installed hook is replayed on the same native config objects after an external description edit; a completed replay, new prompt/model and captured request exclude stale state                                                                                                                                               | Both platforms; fixture-controlled hook replay inside the real host, distinct from an API reload                                                                       |
| Optional shared configuration                | Project-only composition opens and reloads without creating the absent optional shared default                                                                                                                                                                                                                                   | Both platforms                                                                                                                                                         |
| Import alias identity                        | Retargeting a directory symlink/junction rejects stale reload before its token is written; reopening applies the new source and leaves the previous target untouched                                                                                                                                                             | Both platforms                                                                                                                                                         |
| Interrupted runs                             | Outer numeric timeout and SIGINT/SIGTERM handlers terminate a real native host and a blocked nested test runner, removing their fixtures without test hooks                                                                                                                                                                      | Both platforms; the Windows regression emits Node signal events because `process.kill()` terminates directly on Windows                                                |
| Invalid/concurrent edits                     | Read-only import edits, referenced-preset deletion, invalid model input, missing imports, lock collisions, stale snapshots and malformed JSONC reject; file bytes and locks are checked; failed prompt composition leaves native settings unmodified                                                                             | Both platforms; exhaustive rollback/fault combinations remain focused unit tests                                                                                       |
| Terminal authoring and apply                 | Real keyboard navigation creates the first shared source, a group, a preset and a profile; edits membership and ordered layers; saves without applying, then reloads and captures the changed model in the retained conversation                                                                                                 | Enabled on both platforms; real filesystem and ancestor-boundary checks gate acceptance                                                                                |
| Registry authoring                           | Installed create/patch/rename/delete operations across imported JSONC and Markdown; reference rewrites, read-only references, stale snapshots, original native baseline fallback and retained messages                                                                                                                           | Both platforms; API coverage is distinct from terminal confirmation/catalog/authorization                                                                              |
| Activation and source creation               | Empty installation, cancelled first-source preview, create-only publication, shared/project/local ordered replacement, absence inheritance, explicit empty selection, add/reorder/remove in the terminal                                                                                                                         | Installed API and real terminal cases enabled on both platforms                                                                                                        |
| Source-addition race                         | A native Markdown agent appears inside asynchronous validation; save rejects and the proposed local selection file remains absent                                                                                                                                                                                                | Both platforms                                                                                                                                                         |
| Composer permission compilation and fallback | Actual chronological allow/ask/deny decisions across ordered presets, groups and profile overrides; native built-in and custom membership; complete independent policy arrays and decisions survive unsupported global/agent scopes; native and supported-rule fallback, provenance, explicit repair/reload and retained history | Native cases enabled on both platforms; native-host reordering is normalized only within complete contiguous blocks of the three packaged skill-directory allow grants |
| Permission warning lifecycle                 | Actual native toast events and stderr identify scope/source and potentially more permissive fallback; unchanged same-instance replay and repeated session messages deduplicate; changed source, agent switching and recovery produce the expected notices                                                                        | Both platforms; fixture-controlled installed-hook replay establishes same-instance behavior, distinct from public reload                                               |
| Invalid membership repair                    | Real terminal inspects invalid saved membership, removes the unavailable member, reviews the validated candidate and its fallback warning before Save; cancel preserves source bytes; save alone preserves active behavior; explicit reload applies the repaired model and native fallback                                       | Native terminal acceptance enabled on both platforms                                                                                                                   |
| Bundled guidance                             | Installed explain/create/migrate skills appear with real package paths; native tool execution delivers their bodies to the provider; deny prevents content delivery; migration guidance remains loadable after rejected legacy configuration                                                                                     | Both platforms                                                                                                                                                         |
| Compose hub and provenance                   | Real terminal inspection of selected/replayed profiles, resolved field value, origin and overwritten contributions, writable/read-only files; no file changes or provider requests from inspection                                                                                                                               | Enabled on both platforms; real filesystem and ancestor-boundary checks gate acceptance                                                                                |
| Parameter authoring                          | Real native catalog rejects unsupported top-k and invalid output limits/options; installed and terminal edits persist temperature/options; cancel and stale writes preserve bytes; explicit reload changes captured requests; reset restores inheritance and removes stale options                                               | Enabled on both platforms                                                                                                                                              |
| Configured permission editor                 | Ordered add/edit/reorder/remove/reset with exact match/no-match and overwritten provenance; invalid and stale proposals preserve bytes; real terminal edits save without applying, explicitly reload changed native decisions, warn before unsupported saves and restore corrected policies                                      | Installed editor and native terminal acceptance enabled on both platforms                                                                                              |
| Prompt operation editor                      | Real terminal multiline paste/save/reload; installed prepend/append order, inheritance toggles and resets; native requests preserve blank lines and remove stale operations; retained conversations                                                                                                                              | Enabled on both platforms                                                                                                                                              |
| Prompt components and aliases                | Declaring-file paths, repeated/reordered/removed/reset references, reusable inline/file bodies, alias rename and reference review, comments and escaped markers; actual native prompts after reload                                                                                                                              | Enabled on both platforms; real terminal drives alias rename and repeated references                                                                                   |
| Prompt source atomicity                      | Referenced snippet/body edits and directory redirection reject stale plans; external read-only import consumers and declared Markdown consumers block renames before any JSONC write                                                                                                                                             | Enabled on both platforms                                                                                                                                              |
| Native project discovery                     | Native JSONC and Markdown sources, ancestor paths outside Git, environment/file substitutions, duplicate detection, native pins and unchanged declaring bytes                                                                                                                                                                    | Both platforms                                                                                                                                                         |
| Automatic Composer bundle discovery          | Discovery boundaries and precedence for optional bundles                                                                                                                                                                                                                                                                         | Deferred; Composer bundles use explicit imports                                                                                                                        |
| Scoped revision-aware apply                  | Apply specific saved revisions and scopes, reject stale revisions and preserve unaffected state                                                                                                                                                                                                                                  | Pending implementation and native acceptance in #23                                                                                                                    |
| Configurable profile shortcuts               | Configured shortcut discovery, activation, conflict handling and persistence                                                                                                                                                                                                                                                     | Pending implementation and native terminal acceptance in #24                                                                                                           |
| Explicit native workflow agents              | Available workflow agents and their actual dispatch under explicit configuration                                                                                                                                                                                                                                                 | Pending implementation and native acceptance in #25                                                                                                                    |
| Lazy prompt loading                          | Native loading behavior and request-visible results                                                                                                                                                                                                                                                                              | Separate research in #13; no acceptance claim                                                                                                                          |
| Complete feature documentation               | Final consumer behavior, examples and limitations after the remaining implementations                                                                                                                                                                                                                                            | Pending #8                                                                                                                                                             |

The canonical scenarios depend on the schema, source loader, runtime and editor stack
in [#36](https://github.com/lunchbox-labs/opencode-config-composer/pull/36),
[#38](https://github.com/lunchbox-labs/opencode-config-composer/pull/38),
[#39](https://github.com/lunchbox-labs/opencode-config-composer/pull/39) and
[#40](https://github.com/lunchbox-labs/opencode-config-composer/pull/40).
Native discovery and the terminal authoring/activation scenarios additionally depend on
[#42](https://github.com/lunchbox-labs/opencode-config-composer/pull/42),
[#43](https://github.com/lunchbox-labs/opencode-config-composer/pull/43),
[#44](https://github.com/lunchbox-labs/opencode-config-composer/pull/44) and
[#45](https://github.com/lunchbox-labs/opencode-config-composer/pull/45).
Content editor acceptance additionally depends on [#46](https://github.com/lunchbox-labs/opencode-config-composer/pull/46),
[#48](https://github.com/lunchbox-labs/opencode-config-composer/pull/48),
[#49](https://github.com/lunchbox-labs/opencode-config-composer/pull/49) and
[#50](https://github.com/lunchbox-labs/opencode-config-composer/pull/50).
Membership repair, permission runtime and bundled guidance acceptance additionally depend on
[#51](https://github.com/lunchbox-labs/opencode-config-composer/pull/51),
[#53](https://github.com/lunchbox-labs/opencode-config-composer/pull/53) and
[#54](https://github.com/lunchbox-labs/opencode-config-composer/pull/54).

Terminal acceptance requires the real shared-filesystem proof before opening the editor
and the separate project proof before project writes. The proof uses a location-relative
path with the native file API on both platforms. Empty-installation and existing-composition
scenarios exercise this boundary through the installed TUI; a rejected proof fails acceptance.

Outside Git, native source discovery resolves OpenCode's `/` worktree sentinel from
the canonical opened directory's volume or UNC share root. This retains ancestor discovery
to the native boundary without treating Bun's Windows `realpath('/')` result as a
drive-relative path. The installed-editor adapter passes the original native worktree value
unchanged, and the real terminal cases require the same source implementation to accept it.

The permission partitions exercise the implemented runtime compiler, visible candidate warnings,
actual native decisions and recovery. Unsupported scope fallback may allow a tool whose Composer
deny was discarded; acceptance deliberately verifies that case alongside native ask and remaining
supported deny. The notification fixture delegates all real installed config/chat hooks and native
notification delivery while controlling same-instance replay order. Other cases use public reload.
No session permission overlays or skipped placeholders stand in for missing capabilities.
Final feature acceptance still requires native coverage of scoped revision-aware apply, configurable
profile shortcuts and explicit workflow-agent availability when those implementations are available.

OpenCode 1.18.34 catches plugin configuration-hook errors and can continue with native
settings. The invalid-include case verifies that Composer applies no partial prompt or
model overlay and that a corrected reload recovers. It does **not** establish that the
host blocks subsequent model requests after such an error. The editor also rejects an invalid prompt include before applying it; a separate native
global-config update exercises the real hook error. Invalid JSONC rejected by
the editor before reload leaves the previous active settings in effect.

## Diagnostics and limits

Failure artifacts contain only bounded runner/host logs, synthetic request captures,
current terminal screens, bounded VT transcripts, native TUI path diagnostics and version metadata in `integration-results/`.
The optional diagnostic fixture records the real TUI process's working directory, native
directory/worktree paths and their canonical forms without changing Composer or bypassing checks.
Each log/capture/screen is capped at 64 KiB. Each matrix job contains only its suite’s
synthetic diagnostics. Databases, dependency
trees and caches are excluded. CI uploads these files only on failure with three-day
retention. Successful runs upload nothing. No Actions cache is configured.

Jobs use standard public runners, `contents: read`, and a 15-minute job timeout, with
a 10-minute test step and an eight-minute per-suite runner deadline. The full local
test-runner phase has a 15-minute deadline, excluding build, host-binary download and
ripgrep preparation.
Install, request, individual test and process limits
are shorter. TAP output records failures immediately, including before an outer timeout.
This workflow adds no required-check
or branch-protection rules. Linux verification locally cannot substitute for the Windows
CI result. The older Check terminal smoke test uses POSIX APIs; the separate Integration terminal
suite drives both platforms through node-pty. Windows terminal support is verified by
its own CI job.

Timeout and cancellation cleanup stops the test process tree before terminating any
registered detached test runners and native hosts and deleting their fixture roots. SIGINT and SIGTERM
received by the runner follow the same cleanup path. An uncatchable kill of the outer
runner cannot execute JavaScript cleanup; CI runner teardown remains responsible for
that case.
