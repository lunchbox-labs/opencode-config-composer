# Native integration tests

Run `npm ci` and `npm run test:integration` with Node 24 on Linux x64 or Windows x64.
The command builds the package, installs the exact OpenCode version from
`engines.opencode` (currently **1.18.34**), verifies its reported version, packs Composer,
and installs the tarball in temporary consumer projects. It also installs and checksum-verifies
the real ripgrep 15.1.0 binary used by the pinned host on both platforms before startup,
so reload cannot interrupt OpenCode’s dependency download. Set `OPENCODE_BIN` to an
existing binary to avoid downloading it; a version mismatch fails the run.
Before host startup, the harness installs the matching public `@opencode-ai/plugin`
dependency in the fixture's shared and existing project configuration directories.
OpenCode normally initializes those dependencies during its first request; preparing
them serially within each fixture keeps cold Windows dependency installation outside request
deadlines and prevents its configuration directories from competing for npm resources.
When source creation adds a configuration directory after startup, the same dependency
preparation runs before the next explicit reload. Cancelled creation still leaves the
source absent. Native plugin loading and composition run normally.

The [Integration workflow](../.github/workflows/integration.yml) runs the same functional
cases on `ubuntu-latest` and `windows-latest` for pull requests, pushes to `main`, and
manual dispatch. Each platform runs 14 suites:

`core`, `canonical`, `editor`, `terminal`, `cleanup`, `content`, `content-terminal`,
`permissions`, `runtime-terminal`, `running-inspector`, `scoped-apply`, `shortcuts`, `availability`, and
`profile-switching`.

These partitions are defined in [the runner](../scripts/integration.mjs). A partition
check ensures every portable test file runs exactly once per platform. To run one suite:

```sh
npm run test:integration -- --suite scoped-apply
```

Use any suite name above; the default command runs all 14. Matrix jobs finish
independently, and new pushes cancel obsolete pull-request integration runs.
The running inspector has its own partition so its terminal scenarios do not share
the runtime editor suite's eight-minute budget. Test assertions and deadlines are unchanged.

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
tests distinguish saved settings from settings applied by an explicit reload and verify
the applied revision or reload token before dispatching a request. Fixtures
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

| Capability                                   | Observable evidence                                                                                                                                                                                                                                                                         | Coverage / remaining work                                                                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Built package and pinned host                | Installed tarball, native version check, separate consumer dependency tree                                                                                                                                                                                                                  | Both platforms; package/declaration checks also run in Check                                                                                                                               |
| Dedicated/custom settings                    | Custom plugin options, settings-relative source paths, preserved JSONC comments                                                                                                                                                                                                             | Both platforms                                                                                                                                                                             |
| Components and explicit imports              | Installed runtime activates imported agents, commands, skills and named prompts; paths resolve from their declaring files; unimported files stay inactive                                                                                                                                   | Both platforms; automatic Composer bundle discovery remains deferred                                                                                                                       |
| Canonical profiles                           | Ordered named profiles replay parent chains; later scope selections replace earlier ones, absence inherits, and `[]` selects none; targeted presets and overrides reach actual requests                                                                                                     | Both platforms; independent source globals remain active after profile deselection                                                                                                         |
| Model presets and ordered groups             | Captured model/variant requests; preset-reference chains; native agent pins; profile order wins over membership order                                                                                                                                                                       | Both platforms                                                                                                                                                                             |
| Built-in/custom membership                   | Native build/plan/explore membership by name, inline components and custom frontmatter; installed membership editor; retained native fields and no shadow agent files                                                                                                                       | Both platforms, including compiled canonical permission policies                                                                                                                           |
| Global model defaults                        | Shared/project/local precedence for `model` and `small_model`; late-bound references; removal restores inherited defaults                                                                                                                                                                   | Both platforms                                                                                                                                                                             |
| Session model selection                      | Captured explicit model and variant selections compared with native agent pins; stored selections and conversation records survive apply and restart                                                                                                                                        | Both platforms; native TUI reset limitation is described below                                                                                                                             |
| Running configuration inspector              | Packaged native terminal reads running defaults and applied Composer parameters while saved edits are pending or invalid; recorded conversation values are labeled separately                                                                                                               | Both platforms; GET-only navigation/refresh, unchanged settings/selection/history and no additional provider requests; live TUI selection and final request parameters remain unavailable  |
| Typed model parameters                       | Captured temperature, top-p, output-token limit and generic options without a selected variant; removing generic options clears later requests; native variant precedence; model changes clear previous-model parameters                                                                    | Both platforms                                                                                                                                                                             |
| Utility dispatch                             | Automatic title updates and manually requested compaction summaries, with captured model and parameter values                                                                                                                                                                               | Both platforms; automatic context-triggered compaction remains untested                                                                                                                    |
| Prompt composition                           | Authored Markdown, inline and file prompt references, group/default order, per-agent inheritance, nested includes, provider-visible text                                                                                                                                                    | Both platforms                                                                                                                                                                             |
| Commands and native skills                   | Real imported command execution; expanded native skill tool result and following provider request; metadata and companion files                                                                                                                                                             | Both platforms                                                                                                                                                                             |
| Native permissions                           | Actual allow, deny and interactive ask decisions; active deny rules prevent native skill content from reaching the provider                                                                                                                                                                 | Native and canonical ordered policies; both platforms                                                                                                                                      |
| Canonical editors                            | Imported preset edits reach their declaring writable JSONC; mixed bundles, comments, parameters and inactive permission data survive model-only changes; membership edits do not activate profiles                                                                                          | Both platforms; preservation of inactive permission data does not establish enforcement                                                                                                    |
| Save and apply                               | Installed editor saves without changing the running configuration; explicit current-instance disposal and refresh attest the reviewed revision; repeated apply retains prompts and history                                                                                                  | Both platforms; native JSON changes require restart                                                                                                                                        |
| Removed contributions                        | Membership replacement, explicit pin/clear, profile deselection restores the complete native agent registry and removes imported commands/skills                                                                                                                                            | Both platforms                                                                                                                                                                             |
| Persistence                                  | Multi-file save, process restart, retained session messages, profile activation and imported settings                                                                                                                                                                                       | Both platforms                                                                                                                                                                             |
| Generated-agent ownership                    | The installed hook is replayed on the same native config objects after an external description edit; a completed replay, new prompt/model and captured request exclude stale state                                                                                                          | Both platforms; fixture-controlled hook replay inside the real host, distinct from an API reload                                                                                           |
| Optional shared configuration                | Project-only composition opens and reloads without creating the absent optional shared default                                                                                                                                                                                              | Both platforms                                                                                                                                                                             |
| Import alias identity                        | Retargeting a directory symlink/junction rejects stale reload before its token is written; reopening applies the new source and leaves the previous target untouched                                                                                                                        | Both platforms                                                                                                                                                                             |
| Interrupted runs                             | Outer numeric timeout and SIGINT/SIGTERM handlers terminate a real native host and a blocked nested test runner, removing their fixtures without test hooks                                                                                                                                 | Both platforms; the Windows regression emits Node signal events because `process.kill()` terminates directly on Windows                                                                    |
| Invalid/concurrent edits                     | Read-only import edits, referenced-preset deletion, invalid model input, missing imports, lock collisions, stale snapshots and malformed JSONC reject; file bytes and locks are checked; failed prompt composition leaves native settings unmodified                                        | Both platforms; exhaustive rollback/fault combinations remain focused unit tests                                                                                                           |
| Terminal authoring and apply                 | Real keyboard navigation creates the first shared source, a group, a preset and a profile; edits membership and ordered layers; saves without applying, then reloads and captures the changed model in the retained conversation                                                            | Enabled on both platforms; real filesystem and ancestor-boundary checks gate acceptance                                                                                                    |
| Registry authoring                           | Installed create/patch/rename/delete operations across imported JSONC and Markdown; reference rewrites, read-only references, stale snapshots, original native baseline fallback and retained messages                                                                                      | Both platforms; API coverage is distinct from terminal confirmation/catalog/authorization                                                                                                  |
| Activation and source creation               | Empty installation, cancelled first-source preview, create-only publication, shared/project/local ordered replacement, absence inheritance, explicit empty selection, add/reorder/remove in the terminal                                                                                    | Installed API and real terminal cases enabled on both platforms                                                                                                                            |
| Source-addition race                         | A native Markdown agent appears inside asynchronous validation; save rejects and the proposed local selection file remains absent                                                                                                                                                           | Both platforms                                                                                                                                                                             |
| Composer permission compilation and fallback | Latest matching allow/ask/deny wins even if less restrictive; later nonmatches retain earlier matches; unsupported global/agent scopes skip all Composer permissions for that scope, retain native fallback and allow independent scopes to compile                                         | Both platforms; warnings identify potentially more permissive fallback, including omitted denies; native skill-grant normalization is limited to complete contiguous packaged grant blocks |
| Permission warning lifecycle                 | Actual native toast events and stderr identify scope/source and potentially more permissive fallback; unchanged same-instance replay and repeated session messages deduplicate; changed source, agent switching and recovery produce the expected notices                                   | Both platforms; fixture-controlled installed-hook replay establishes same-instance behavior, distinct from public reload                                                                   |
| Invalid membership repair                    | Real terminal inspects invalid saved membership, removes the unavailable member, reviews the validated candidate and its fallback warning before Save; cancel preserves source bytes; save alone preserves active behavior; explicit reload applies the repaired model and native fallback  | Native terminal acceptance enabled on both platforms                                                                                                                                       |
| Bundled guidance                             | Installed explain/create/migrate skills appear with real package paths; native tool execution delivers their bodies to the provider; deny prevents content delivery; migration guidance remains loadable after rejected legacy configuration                                                | Both platforms                                                                                                                                                                             |
| Compose hub and provenance                   | Real terminal inspection of selected/replayed profiles, resolved field value, origin and overwritten contributions, writable/read-only files; no file changes or provider requests from inspection                                                                                          | Enabled on both platforms; real filesystem and ancestor-boundary checks gate acceptance                                                                                                    |
| Parameter authoring                          | Real native catalog rejects unsupported top-k and invalid output limits/options; installed and terminal edits persist temperature/options; cancel and stale writes preserve bytes; explicit reload changes captured requests; reset restores inheritance and removes stale options          | Enabled on both platforms                                                                                                                                                                  |
| Configured permission editor                 | Ordered add/edit/reorder/remove/reset with exact match/no-match and overwritten provenance; invalid and stale proposals preserve bytes; real terminal edits save without applying, explicitly reload changed native decisions, warn before unsupported saves and restore corrected policies | Installed editor and native terminal acceptance enabled on both platforms                                                                                                                  |
| Prompt operation editor                      | Real terminal multiline paste/save/reload; installed prepend/append order, inheritance toggles and resets; native requests preserve blank lines and remove stale operations; retained conversations                                                                                         | Enabled on both platforms                                                                                                                                                                  |
| Prompt components and aliases                | Declaring-file paths, repeated/reordered/removed/reset references, reusable inline/file bodies, alias rename and reference review, comments and escaped markers; actual native prompts after reload                                                                                         | Enabled on both platforms; real terminal drives alias rename and repeated references                                                                                                       |
| Prompt source atomicity                      | Referenced snippet/body edits and directory redirection reject stale plans; external read-only import consumers and declared Markdown consumers block renames before any JSONC write                                                                                                        | Enabled on both platforms                                                                                                                                                                  |
| Native project discovery                     | Native JSONC and Markdown sources, ancestor paths outside Git, environment/file substitutions, duplicate detection, native pins and unchanged declaring bytes                                                                                                                               | Both platforms                                                                                                                                                                             |
| Automatic Composer bundle discovery          | Discovery boundaries and precedence for optional bundles                                                                                                                                                                                                                                    | Deferred; Composer bundles use explicit imports                                                                                                                                            |
| Scoped revision-aware apply                  | Real terminal apply checks native activity, saved inputs and refreshed revision; busy child/retry work and concurrent source edits prevent disposal/refresh; other instances and complete conversation records remain unchanged                                                             | Both platforms; genuine native JSON edits require restart; connection and directory races are listed below                                                                                 |
| Configurable profile shortcuts               | Real native registration, explicit save destination, masking, ordered/reversed profiles, cancel/save without dispatch, separate apply, explicit none, stale callback rejection, refresh and visible command collision                                                                       | Both platforms; retained session selections and history; open-confirmation races are listed below                                                                                          |
| Explicit native workflow agents              | Profile availability changes actual native admission/fallback, preserves definitions, pins and permissions, rejects disabled explicit requests before provider dispatch, and restores enabled agents                                                                                        | Installed API and real terminal cases on both platforms; visible-primary/default eligibility and internal-toggle rejection are exercised                                                   |
| Profile switching                            | Immediate native config checks precede any continuation; same-model A → B → A → none removes deselected variant, typed parameters, nested options and prompts while retaining current base contributions, native pins and history                                                           | Both platforms; ordered and reversed active selections are also exercised                                                                                                                  |
| Lazy prompt loading                          | Composer prompt loading remains eager; native skills use the host’s on-demand tool path                                                                                                                                                                                                     | Custom lazy prompt loading remains feasibility research; no shipped feature or acceptance claim                                                                                            |

Terminal acceptance requires the real shared-filesystem proof before opening the editor
and the separate project proof before project writes. The proof uses a location-relative
path with the native file API on both platforms. Empty-installation and existing-composition
scenarios exercise this boundary through the installed TUI; a rejected proof fails acceptance.

Outside Git, native source discovery resolves OpenCode's `/` worktree sentinel from
the canonical opened directory's volume or UNC share root. This retains ancestor discovery
to the native boundary without treating Bun's Windows `realpath('/')` result as a
drive-relative path. The installed-editor adapter passes the original native worktree value
unchanged, and the real terminal cases require the same source implementation to accept it.

The permission partitions exercise the runtime compiler, candidate warnings, actual
native decisions and recovery. The latest matching rule can loosen an earlier deny;
a later nonmatch leaves the earlier match available. An unsupported scope skips every
Composer permission contribution for that scope. Agent fallback retains native agent
permissions plus the applied global policy; global fallback retains native globals
while independent agent policies can still compile. The warning states that fallback
may be more permissive, including omitted intended denies. Acceptance verifies that
case alongside native ask and surviving independent deny rules. No session permission
overlays substitute for the compiler or native decisions.

The notification fixture delegates the real installed config/chat hooks and native
notification delivery while controlling same-instance replay order. Other cases use
public reload. Configured permission previews do not establish the final effect of
remembered native session approvals.

## Profile switching and native session selections

[Profile recomposition cases](../tests/integration/profile-recomposition.integration.ts)
check the public native configuration immediately after apply, before a continuation
or provider request. Same-model A → B → A → none reconstructs the destination from
current sources and the original native baseline. Deselected fields disappear even
when the model is unchanged; currently selected profiles still merge in authored order.
Assertions cover typed parameters, nested custom options, prompt removal, native pins,
component selection, source globals, unchanged native files and every prior message.
Captured compatible-adapter options establish transport to the local provider, not
validation by a remote model API.

[Native session and terminal cases](../tests/integration/profile-session-terminal.integration.ts)
separately observe OpenCode 1.18.34’s persisted session model and independent TUI choice.
A restored TUI model/variant can continue to override the destination after apply,
including when the configured model changes. Clearing profiles can retain a previous
native session model; a fresh implicit session uses the restored native fallback.
Native message history does not distinguish a manual choice from a profile-seeded
choice with the same model and variant.

Apply confirmation and completion explain this limitation. The public concrete session
model API can update the stored session model without rewriting history, but cannot
reset the native TUI’s separate local choice. Public picker command payloads open a
picker without applying a supplied model or variant. To recover in the TUI, open
`/models` and select the destination model, or the native base model after clearing
profiles. Then open `/variants` and select the intended destination variant or
**Default**. Selecting only a model can reuse its cached variant. These supported
picker actions and subsequent provider requests are tested with conversation history
and native configuration bytes preserved.

OpenCode 1.18.34 catches plugin configuration-hook errors and can continue with native
settings. The invalid-include case verifies that Composer applies no partial prompt or
model overlay and that a corrected reload recovers. It does **not** establish that the
host blocks subsequent model requests after such an error. The editor also rejects an invalid prompt include before applying it; a separate native
global-config update exercises the real hook error. Invalid JSONC rejected by
the editor before reload leaves the previous active settings in effect.

## Coverage limits

Automatic context-triggered compaction is untested; utility coverage uses automatic
titles and explicitly requested compaction. Automatic Composer directory discovery is
deferred; component bundles require explicit imports. A custom lazy prompt loader
remains feasibility research.

Native terminal acceptance does not exercise a connection handoff or opened-directory
retarget while an apply dialog is open. It also does not exercise shortcut definition,
client, directory or dialog changes during open destination/review screens or deferred
reads. Source changes during the real activity request and stale shortcut callbacks
before invocation are exercised. [Focused apply tests](../tests/scoped-apply.test.ts)
cover connection checks at apply boundaries, and [TUI tests](../tests/config-composer.test.ts)
cover project changes at confirmation and delayed route/dialog/abort suppression.
These do not replace the native dialog race cases. Imported-directory alias retargeting
already has native coverage and remains distinct from changing the opened directory.
Exhaustive rollback and notification-transport failure combinations remain focused
unit coverage.

The host offers no atomic idle-and-dispose operation, so activity validation cannot
guarantee an uninterrupted hot switch if a new request starts after the idle check.
Saving and applying preserve conversation records; they do not automatically reset
native session or TUI model selections.

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
