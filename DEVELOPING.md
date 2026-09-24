# Developing

## Setup

An **npm-installed** Pi is required. Runtime imports and test types resolve from the development `pi` executable, and only the npm layout exposes those packages: the standalone tar.gz build compiles them into a single binary. A standalone Pi is a supported *runtime target*, not a supported development host, and `npm run check` says so by name, and names `PI_CLAUDE_CODE_PROVIDER_DEV_PI`, if the `pi` it resolves is the compiled build.

```bash
npm run setup:dev
npm run check
npm test
```

Do not run `npm install` at the repository root. The package has no installed dependencies and must not contain root `node_modules` or a root lockfile. `setup:dev` installs the isolated, locked `tooling/` package containing the TypeScript parser/compiler and Node declarations used by source-policy checks and typechecking. Its ignored `node_modules/` is generated development state, not published runtime code. Pi loads the TypeScript extension directly; there is no runtime build.

When npm and standalone Pi installations coexist, development uses `PI_CLAUDE_CODE_PROVIDER_DEV_PI` when it is set, and otherwise whichever `pi` resolves first on `PATH`. To keep a standalone Pi as your default `pi`, set `PI_CLAUDE_CODE_PROVIDER_DEV_PI` in your shell profile to an npm installation's `pi` executable; on POSIX that can be a global install or the `node_modules/.bin/pi` link of an `npm install --prefix` one. Otherwise put the npm installation's bin directory first on `PATH` for `npm run check` and `npm test`, and verify it with `command -v pi` on POSIX or `where pi` on Windows. Keep the development host npm-based, and use `PI_CLAUDE_CODE_PROVIDER_PI_BIN` only to select a standalone executable for the live bridge lane. The resolver finds the package that owns the `pi` executable at any CLI depth and checks package identities. Resolving an installation does not establish version compatibility: if its exported modules have missing dependencies, use an isolated npm installation of the verified Pi version rather than modifying the global install.

To load a local checkout:

```bash
pi install /absolute/path/to/pi-claude-code-provider
```

## Architecture

| Change area | Owning modules | Focused validation |
| --- | --- | --- |
| Extension startup, session lifetime, and session working directory | `extensions/index.ts` (manifest entry), `extensions/pi-claude-code-provider.ts`, `src/session-registry.ts`, `src/session-image-store.ts` | `extension.test.js`, `session-registry.test.js`, `session-image-store.test.js` |
| Authentication, CLI, model catalog, and compatibility | `src/auth.ts`, `src/catalog.ts`, `src/claude-args.ts`, `src/compatibility.ts` | `auth.test.js`, `catalog.test.js`, `claude-args.test.js`, `compatibility.test.js` |
| Transcript and provider lifecycle | `src/context-serializer.ts`, `src/provider.ts`, `src/stream-events.ts`, `src/claude-protocol.ts`, `src/jsonl.ts`, `src/output.ts`, `src/errors.ts`, `src/types.ts` | `context-serializer.test.js`, `provider.test.js`, `stream-events.test.js`, `claude-protocol.test.js`, `jsonl.test.js`, `errors.test.js` |
| Runtime launch, process trees, and private state | `src/claude-process.ts`, `src/host-runtime.ts`, `src/process-utils.ts`, `src/runtime-directories.ts` | `process-utils.test.js`, `runtime-directories.test.js` |
| Visible web search | `src/web-search.ts` | `web-search.test.js` |
| Diagnostics and metrics | `src/diagnostics.ts`, `src/doctor.ts`, `src/metrics.ts`, `src/claude-models.ts` | `metrics-doctor.test.js`, `claude-models.test.js` |
| Proposal-only MCP bridge | `bridge/mcp-proposal-server.js` | `mcp-bridge.test.js` |
| Paid and live validation | `src/paid-launch-budget.ts`, `scripts/paid-test-runner.js`, `scripts/live-test.js`, `scripts/model-matrix.js`, `scripts/lib/paid-stages.js`, `scripts/lib/paid-confirmation.js`, `scripts/lib/live-process.js`, `scripts/lib/pi-installation.js` | `paid-stages.test.js`, `paid-confirmation.test.js`, `paid-runner-lifecycle.test.js`, `live-process.test.js`, `pi-installation.test.js` |
| Repository policy and capture tooling | `scripts/check.js`, `scripts/typecheck.js`, `scripts/release-check.js`, `scripts/lib/dependency-policy.js`, `scripts/lib/documentation-policy.js`, `scripts/lib/source-policy.js`, `scripts/capture-claude-surface.js`, `scripts/capture-claude-breakpoints.js`, `scripts/capture-claude-stream-recovery.js` | `dependency-policy.test.js`, `documentation-policy.test.js`, `source-policy.test.js`, `claude-fixture.test.js`, `node-fixture.test.js` |

The manifest entry `extensions/index.ts` only re-exports the implementation. Keep the entry an `index.ts`: Pi's startup extension list appends any other entry's filename to the package name.

Pi remains authoritative for prepared context, branches, compaction, active tools, execution, provider handoff, and cancellation. Read the matching Pi checkout's contributor and provider documentation before changing those boundaries. Pi imports remain optional `*` peer dependencies and are not bundled.

Two contracts are easy to break silently:

- `streamSimple` owns both halves of Pi's provider request contract: apply the `onPayload` replacement before launching Claude, and invoke `onResponse` once initialization validates, before publishing content. Dropping either disables the matching Pi extension event for this provider.
- Windows cleanup must remain rooted at the exact retained child PID. Never replace it with `/IM`, name-based PowerShell termination, or global process enumeration. Automatic stale-directory recovery stays disabled on Windows; inspect Node's temporary root and package markers before removing confirmed stale state.

## Compatibility baseline

`src/compatibility.ts` owns Pi/Claude version, platform, and expected model-family values; `.github/workflows/ci.yml` owns the Node CI matrix and the Pi version CI installs. These two files and the baseline table below move together in one reviewed commit, whether during development, as [Updating compatibility](#updating-compatibility) describes, or in the release commit. Never advance them to a version the paid release gate did not exercise: the gate runs again against the release commit and nothing is published unless it passes, so a baseline advanced during development is still proven against exactly what ships.

`MINIMUM_VERSIONS` in the same file is a separate frozen constant, stated in `README.md` and reported by the doctor, and is deliberately not derived from `VERIFIED_VERSIONS`. The baseline rises whenever a gate passes; the minimum moves only by an explicit decision to change what is supported. Deriving one from the other would drop support for working installs as a side effect of a baseline bump. Assert nothing about their relative order.

| Component | Verified baseline |
| --- | --- |
| Pi | 0.87.1, npm distribution; standalone tar.gz bridge live-verified on Linux x64 |
| Claude Code | 2.1.281 |
| Node.js | 24.16.0 on WSL2, Ubuntu CI, and Apple Silicon macOS CI; 22.23.1 on Ubuntu CI and Windows CI |
| Platform | WSL2 Ubuntu/Linux x64; native Windows x64; macOS (deterministic CI) |

### Pi provider contexts

Pi gives custom providers a normalized `TranscriptContext`: system messages carry the prompt, sections, and tool additions/removals. The public `Context` shorthand, top-level `systemPrompt` and `tools`, is folded into those messages by Pi-AI's `normalizeContext()` before any provider is reached, and `TranscriptContext` is brand-typed so a raw `Context` cannot arrive by accident. `src/provider.ts` uses the host Pi-AI replay helpers to recover the current prompt and tools, then removes system messages from the conversation sent to the existing serializer. An empty recovery collapses to `undefined` rather than `""` or `[]`, so the logical payload keeps its "absent" shape. The recovered prompt is used for cwd routing **before** `before_provider_request`; that hook still receives the package's logical top-level payload.

Provider-facing tests must build their fixtures through `normalizeContext()` for the same reason. A hand-built pre-normalization context still runs, but its `systemPrompt` and `tools` land where the provider never reads them, so the test passes while measuring nothing.

Inspect the matching Pi provider types, replay helpers, agent-loop call path, and side-Agent callers on any later contract change.

Pi's distribution is part of the baseline: the npm build runs on Node, the standalone tar.gz build is a compiled Bun binary, and `process.execPath` means something different on each. `scriptLaunch` in `src/host-runtime.ts` owns that difference. It sets `BUN_BE_BUN=1` so a compiled Pi runs the proposal bridge instead of its own entry point, and pins `--config=` to a neutral `bunfig.toml` in the private request directory: Pi's `--no-compile-autoload-bunfig` does not survive `BUN_BE_BUN`, so a `bunfig.toml` in the bridge's working directory would otherwise preload code into it. Keep the joined `--config=` form, because Bun ignores a space-separated one and then consumes the script path. The mechanism is part of the embedded Bun runtime on every standalone target. Record a standalone baseline only after `npm run test:paid:bridge-standalone` passes against that exact build.

A platform is live-verified only after `npm run test:paid:release` passes on it. `platformStatus` also treats `darwin` as verified, across architectures, on the [deterministic GitHub Actions matrix](.github/workflows/ci.yml), because nothing here takes a darwin-specific code path beyond the doctor's `sw_vers` probe. Other platforms and versions continue with advisory warnings, while protocol and isolation mismatches fail closed. Sonnet, Fable, and Opus support `low` through `max` effort; Haiku has no effort control and uses Claude Code's default thinking.

### Captured Claude Code surface

`test/support/captured/claude-<version>-help.txt` is `claude --help` captured byte-for-byte from the version `CAPTURED_CLAUDE_VERSION` in `test/support/claude-fixture.js` names. `validateClaudeCapabilities` decides whether the provider registers at all, so it is tested against help the CLI really emits rather than a hand-written list, which can spell flags the real help never shows.

Compare the installed CLI's help with the pinned capture when moving the verified baseline. If it changes, run `npm run capture:claude-surface`, review the diff, and re-pin `CAPTURED_CLAUDE_VERSION`. The capture may remain on an older version when the help is identical.

### Captured stream-recovery records

`test/support/captured/claude-<version>-stream-<scenario>.jsonl` is Claude Code's own stdout for each way it recovers from an API failure, captured from the version `CAPTURED_STREAM_RECOVERY_VERSION` in `test/support/claude-fixture.js` names. The provider's handling of these shapes is tested against them rather than against hand-written sequences, for the same reason the help surface is: a hand-written sequence encodes what we believe Claude Code emits, and the recovery paths are exactly where that belief was wrong.

`npm run capture:claude-stream-recovery` regenerates them, using **no quota**. It runs the CLI against a loopback server that scripts each attempt's response, with a dummy token, a temporary `HOME`, and the provider's own `providerArgs` and `buildClaudeEnvironment`. Pass scenario names to capture a subset, `--claude` to select a build, and `--print` to inspect without writing. That dummy login resolves no subscription, so anything the CLI derives from account state carries its unauthenticated default -- most visibly `contextWindow` in each record's `modelUsage`, which reads 200000 for every alias. These files are fixtures for record *shape*; they are not evidence about the window a real account is served, and `src/catalog.ts` records where that evidence does come from. Each file is named for the version in its own init record, so a capture on a newer CLI lands beside the pinned set instead of overwriting it; read the diff, then re-pin `CAPTURED_STREAM_RECOVERY_VERSION` and delete the version the tests no longer load.

`claude-<version>-stream-live-cut-late.jsonl` is the exception: it came from a real API stream interrupted by a local forwarding proxy, so it cost quota and this command cannot reproduce it. It keeps its own `CAPTURED_LIVE_CUT_VERSION` instead of following the scripted set; keep that file when deleting a superseded version.

## Validation

### Deterministic checks

`npm run check` enforces dependency and import policy, Markdown links and versions, source boundaries, JavaScript syntax, and strict TypeScript. `npm test` runs deterministic tests. Neither command performs Claude inference or consumes subscription quota; `check` may run `claude --version` for advisory metadata.

### Paid tests

Subscription-consuming commands are named `test:paid:*`. They show the detected subscription, request caps, and quota/spend warning. Set `PI_CLAUDE_CODE_PROVIDER_CONFIRM_PAID_TESTS=1` to confirm in either mode; otherwise an interactive terminal requires the exact phrase `USE PAID CLAUDE QUOTA`. Noninteractive runs require the variable. The underlying scripts refuse direct invocation, perform no automatic retries, and atomically claim a stage and aggregate slot before every provider or web-search Claude launch.

The runner gives Pi a temporary agent directory and disables automatic extension, skill, context-file, and prompt-template loading. Only the explicitly selected provider package is loaded. Both controls matter: `PI_CODING_AGENT_DIR` alone does not suppress `~/.agents/skills`. Keep personal skill directories in place; tests must not depend on moving them. Claude subscription authentication and organization-managed policy remain available.

| Command | Maximum Claude launches |
| --- | ---: |
| `npm run test:paid:smoke` | 1 |
| `npm run test:paid:compat-npm` | 2 |
| `npm run test:paid:compat-standalone` | 2 |
| `npm run test:paid:bridge` | 3 |
| `npm run test:paid:bridge-standalone` | 3 |
| `npm run test:paid:post-tools` | 6 |
| `npm run test:paid:full` | 28 |
| `npm run test:paid:cache` | 3 |
| `npm run test:paid:cache-haiku` | 3 |
| `npm run test:paid:cache-images` | 3 |
| `npm run test:paid:cache-images-haiku` | 3 |
| `npm run test:paid:fable` | 1 |
| `npm run test:paid:opus` | 1 |
| `npm run test:paid:matrix` | 11 |
| `npm run test:paid:release` | 57 |

Run paid stages one at a time. `model-matrix.js` checks for leaked private state by diffing the temporary root for leftover private *request* directories, so another provider request running at the same time reads as a leak. The session image directory is deliberately outside that diff, because it is session-scoped rather than per-request; `session-image-store.test.js` covers its removal.

The tool steps need only the shell Pi's `bash` tool uses: on Windows, Git Bash at `%ProgramFiles%\Git\bin\bash.exe` or a `bash.exe` on `PATH`. They run shell scripts rather than an interpreter such as Python, so a gate result never depends on what else is installed, and `test:paid:full` checks for that shell before its first Claude launch.

`PI_CLAUDE_CODE_PROVIDER_PI_BIN` selects which Pi executable the live scripts launch; without it they launch the CLI entry of the development Pi described under Setup. This is deliberately separate from package resolution, so one npm-hosted development host can drive both distributions. The `compat-standalone` and `bridge-standalone` stages require the variable; point it at an extracted tar.gz `pi`.

Both bridge lanes are required, and `test:paid:release` runs both. A `--no-tools` turn passes even when the proposal bridge never starts, so only a turn that actually round-trips a tool distinguishes a working bridge from a broken one. `/pi-claude-code-provider-doctor` performs the same handshake without consuming quota.

RPC stages that read replies through `assistantReply` fail on non-redacted thinking blocks with empty text. Print-mode stages do not use that check. Adaptive thinking can skip a turn, so the cache probe and model matrix also report whether thinking text appeared and how many reasoning tokens were used; a turn with no reasoning tokens did not exercise the check.

The release suite covers text, tool, image, isolation, recovery, Unicode, history, web search, cache reuse, both bridge lanes, the gated aliases, and the supported effort matrix. Successful RPC harnesses close stdin so Pi can run session shutdown and flush metrics before exit. The model matrix asserts the family an alias serves, not a dated model id, so an upstream model refresh cannot fail the gate while an alias serving the wrong family still does. Every entry also checks that the context window and default output cap Claude Code reports for the served model equal the configured ones, cleanup, and the absence of leaked private directories.

Fable is selectable but excluded from the release gate, because its availability and billing vary by tier. On Pro it requires usage credits, and with credits turned off every Fable request fails with an assistant error. Run `npm run test:paid:fable` only on an account where that spend is available and separately authorized; the blocking Sonnet and Opus cases already exercise the shared transport.

**Read the reported error before blaming the model.** When a turn ends in an assistant error, such as disabled usage credits, a rate limit, or a lost login, the live scripts fail with that error by name. Only a reply that arrived with the wrong text is evidence about model behavior.

### Mid-response recovery

Claude Code has three recoveries after a response starts streaming, and the provider must recognize all of them (see [DESIGN.md](DESIGN.md#process-and-storage-lifecycle)). When changing `ClaudeEventMapper`, preserve these:

- **Never rewrite published content.** Pi's assistant events are append-only. `stream-events.test.js` replays every captured scenario through Pi's own `AssistantMessageFrameEncoder` and `reduceAssistantMessageFrames`, in both consumption orders; reusing a content index makes them throw.
- **The error wording is load-bearing.** A transient interruption must carry the fixed `stream ended before message_stop` phrase that Pi's `isRetryableAssistantError` matches (`packages/ai/src/utils/retry.ts`), or the turn is lost instead of retried. A cause that repeating cannot clear must not match it; `billing` is on Pi's non-retryable list.
- **Do not read a handoff as an interruption.** `system/permission_denied` and a tool_result `user` record precede `message_delta(stop_reason: tool_use)` in every normal tool turn, and mid-stream `assistant` echoes carry the open stream's own message id.
- **Keep both handoffs latched.** After a tool-use or output-limit stop, stream events still in the pipe are ignored. Claude Code answers each with another message of its own, and the result must not depend on whether termination wins that race.

### Prompt caching

Cache-hit percentage is `cacheRead / (input + cacheRead + cacheWrite) * 100`; cache writes seed later reuse and are not hits. [DESIGN.md](DESIGN.md#compatibility-and-performance) explains the mechanisms behind these rules.

Preserve these when changing serialization or Claude arguments:

- **Append-stable history.** Each request serializes the complete current transcript as append-stable history blocks with a sorted tool catalog. Never rewrite unchanged history.
- **The token-reminder pin.** Keep `totalTokensReminder: "off"` in the pinned settings; Claude Code otherwise appends a changing `<total_tokens>` reminder that breaks reuse across fresh print-mode processes. The setting is undocumented and follows [bcherny's maintainer guidance](https://github.com/anthropics/claude-code/issues/81259#issuecomment-5311888970), so do not remove it without a replacement cache probe and new upstream guidance.
- **The transcript breakpoint.** `providerArgs` marks the last history block with `ttl: "1h"`, because Claude Code places no breakpoint inside the replayed history. The TTL is load-bearing: the API's longest-TTL-first ordering rejects a shorter one ahead of Claude Code's own markers. The API allows four breakpoints, and a fifth from any source fails every request, so count them with the capture below before adding one. `PI_CLAUDE_CODE_PROVIDER_TRANSCRIPT_BREAKPOINT=off` is the user-facing escape hatch for that failure, not a substitute for the release gate.
- **Attachments.** Keep every image in the effective Pi context attached, including after a reply, at a content-addressed path stable for the Pi session. Preserve transcript records and generated attachment order. A changing private path ahead of the transcript can defeat reuse. [DESIGN.md](DESIGN.md#request-and-transcript-transport) explains why.
- **Records per request.** Keep the records appended between requests under the ceiling described in DESIGN.md.

`npm run capture:claude-breakpoints` checks the request shape without spending quota. It builds a request from the provider's own `providerArgs` and `buildClaudeEnvironment`, captures it against a loopback server with a dummy token, and prints the breakpoint table, the first block that differs between two captures in different private directories, and a verdict; it exits non-zero unless the shape is healthy. Like the provider, it runs Claude in a project directory: a disposable git repository with a configured clean filter and a same-size edit to the filtered file. The verdict is also BROKEN if that filter runs, a project file changes, Claude Code reports no working directory or one other than the project, the private request directory reaches the model outside attachment narration, or the proposal bridge is not ready. `--claude` selects a build, `--model` an alias and `--effort` a supported effort level (not Haiku), `--strip-marker` gives the control arm without editing `src/`, `--images` and `--no-tools` vary the payload, and `--output` writes the last captured request body to a file. Run it against every new Claude Code build before trusting the rules above.

`test:paid:cache` runs on `sonnet:low` and `test:paid:cache-haiku` on `haiku`. Both are required: Haiku receives Claude Code's environment block ahead of the transcript, so a varying block there breaks Haiku while Sonnet still passes. Each reuse turn must reach 80% cache hits and write less than a quarter of turn 1's cache write, so a large stable system prompt cannot hide a rewritten transcript. Haiku 4.5 caches nothing below 4096 tokens, so keep the probe's padding above that. The padding starts with a per-run nonce; its turns are otherwise identical between runs, so without one a warm entry from an earlier run could satisfy turn 2 while reuse inside the run is broken.

`test:paid:cache-images` and `test:paid:cache-images-haiku` apply the same hit and write bounds on Sonnet and Haiku while asking three different questions about one image attached only on turn 1. Correct answers on turns 2 and 3 prove Claude can re-inspect a historical image; the usage bounds prove stable attachment paths preserve cache reuse. These stages are blocking in `test:paid:release`.

`PI_CLAUDE_CODE_PROVIDER_CACHE_MODEL` points the `cache` stage at another alias. The probe's exact-reply assertions are written for Sonnet and Haiku, so on another alias read the reported error first and use `npm run capture:claude-breakpoints` for the request shape.

**A single zero reading is not evidence.** Reuse can read 0% on a request byte-identical to one that reads 99%. Before concluding that a model or a serialization change has broken caching, repeat the measurement and diff the wire requests with `npm run capture:claude-breakpoints`.

## Updating compatibility

When updating Claude Code compatibility:

1. Compare the required CLI flags, initialization fields, stream records, and exact tool inventory.
2. If the installed CLI's help differs from the pinned capture, recapture it with `npm run capture:claude-surface` and re-pin `CAPTURED_CLAUDE_VERSION`.
3. Run `npm run capture:claude-breakpoints` for `sonnet` and `haiku`, and continue only on HEALTHY verdicts.
4. Cover readiness, invalid or oversized JSONL, timeouts, aborts, error exits, and descendant cleanup deterministically.
5. Move `src/compatibility.ts`, CI, and the baseline table together, under the rule in [Compatibility baseline](#compatibility-baseline).

When updating Pi compatibility, read the current package, extension, provider, session, and compaction contracts, then test a clean Git or packed installation on both the npm and standalone distributions.

## Release policy

Releases are prepared and published by the maintainer against a checklist kept
outside this repository. The steps there change between releases; what follows
are the rules a release must satisfy regardless of how it is carried out.

- A release ships one reviewed commit, with `[Unreleased]` in `CHANGELOG.md` promoted to a dated version entry and the package version matching the tag. When a release removes or changes documented behaviour, its changelog entry leads with that change and its migration note.
- `npm run release:check` and `npm publish --dry-run` must both pass, and the packed inventory is read rather than inferred from an exit status. The published file list is checked against the previous release, and every difference must trace to a reviewed change.
- The packed tarball is verified on **both** Pi distributions, npm and standalone. The extension must load under Node and under the compiled Bun binary; exercising one lane leaves the other unproven.
- When runtime code changed, the explicitly authorized paid release gate must pass against the exact commit that ships. A gate run against an earlier commit proves that commit, not this one.
- When the Claude Code build under test changed, `npm run capture:claude-breakpoints` must return HEALTHY verdicts for `sonnet` and `haiku` before any quota is spent on the gate.
- Publishing, tagging, and creating the GitHub release are manual and maintainer-authorized. This repository contains no automatic publishing workflow and stores no publishing credential.
- Published npm versions and release tags are immutable. Correct a bad release by deprecating it and shipping a higher version, never by unpublishing or overwriting.

## Documentation and Git hygiene

- `README.md` owns installation, usage, configuration, material limitations, and troubleshooting.
- `DESIGN.md` owns architecture and security design.
- `DEVELOPING.md` owns setup, validation, compatibility, and release policy.
- `CONTRIBUTING.md` owns contribution requirements.
- `SECURITY.md` owns vulnerability reporting.
- `CHANGELOG.md` owns user-visible release history.

Maintained documents state current behavior, rules, and procedures, each with its reason. Record measurements, individual test runs, and investigation history in commit messages, pull requests, or `CHANGELOG.md` entries, so these files stay useful rather than turning into activity logs.

Do not commit credentials, Claude state, prompts, temporary transport data, diagnostic reports, metrics logs, coverage, root dependencies, or a root lockfile. Stage explicit paths and inspect every diff before committing.
