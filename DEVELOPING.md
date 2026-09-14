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
| Extension startup, session lifetime, and session working directory | `extensions/index.ts` (manifest entry), `extensions/pi-claude-code-provider.ts` | `extension.test.js` |
| Authentication, CLI, model catalog, and compatibility | `src/auth.ts`, `src/catalog.ts`, `src/claude-args.ts`, `src/compatibility.ts` | `auth.test.js`, `catalog.test.js`, `claude-args.test.js`, `compatibility.test.js` |
| Transcript and provider lifecycle | `src/context-serializer.ts`, `src/provider.ts`, `src/stream-events.ts`, `src/claude-protocol.ts`, `src/jsonl.ts`, `src/output.ts`, `src/errors.ts`, `src/types.ts` | `context-serializer.test.js`, `provider.test.js`, `stream-events.test.js`, `claude-protocol.test.js`, `jsonl.test.js`, `errors.test.js` |
| Runtime launch, process trees, and private state | `src/claude-process.ts`, `src/host-runtime.ts`, `src/process-utils.ts`, `src/runtime-directories.ts` | `process-utils.test.js`, `runtime-directories.test.js` |
| Bounded diagnostic capture | `src/text.ts` | `text.test.js` |
| Local-model live lane | `test/support/local-claude.js`, `scripts/local-test.js` | `local-claude.test.js` |
| Captured Claude Code protocol | `scripts/capture-claude-protocol.js` | `captured-protocol.test.js` |
| Visible web search | `src/web-search.ts` | `web-search.test.js` |
| Diagnostics and metrics | `src/diagnostics.ts`, `src/doctor.ts`, `src/metrics.ts`, `src/claude-models.ts` | `metrics-doctor.test.js`, `claude-models.test.js` |
| Proposal-only MCP bridge | `bridge/mcp-proposal-server.js` | `mcp-bridge.test.js` |
| Paid and live validation | `src/paid-launch-budget.ts`, `scripts/paid-test-runner.js`, `scripts/live-test.js`, `scripts/model-matrix.js`, `scripts/lib/paid-stages.js`, `scripts/lib/paid-confirmation.js`, `scripts/lib/live-process.js`, `scripts/lib/model-matrix-policy.js`, `scripts/lib/pi-installation.js` | `paid-stages.test.js`, `paid-confirmation.test.js`, `paid-runner-lifecycle.test.js`, `live-process.test.js`, `model-matrix-policy.test.js`, `pi-installation.test.js` |
| Repository policy and capture tooling | `scripts/check.js`, `scripts/typecheck.js`, `scripts/release-check.js`, `scripts/lib/dependency-policy.js`, `scripts/lib/documentation-policy.js`, `scripts/lib/source-policy.js`, `scripts/capture-claude-surface.js`, `scripts/capture-claude-breakpoints.js` | `dependency-policy.test.js`, `documentation-policy.test.js`, `source-policy.test.js`, `claude-fixture.test.js`, `node-fixture.test.js` |

The manifest entry `extensions/index.ts` only re-exports the implementation. Keep the entry an `index.ts`: Pi's startup extension list appends any other entry's filename to the package name.

Pi remains authoritative for prepared context, branches, compaction, active tools, execution, provider handoff, and cancellation. Read the matching Pi checkout's contributor and provider documentation before changing those boundaries. Pi imports remain optional `*` peer dependencies and are not bundled.

Two contracts are easy to break silently:

- `streamSimple` owns both halves of Pi's provider request contract: apply the `onPayload` replacement before launching Claude, and invoke `onResponse` once initialization validates, before publishing content. Dropping either disables the matching Pi extension event for this provider.
- Windows cleanup must remain rooted at the exact retained child PID. Never replace it with `/IM`, name-based PowerShell termination, or global process enumeration. Automatic stale-directory recovery stays disabled on Windows; inspect Node's temporary root and package markers before removing confirmed stale state.

## Compatibility baseline

`src/compatibility.ts` owns Pi/Claude version, platform, and expected model-family values; `.github/workflows/ci.yml` owns the Node CI matrix and the Pi version CI installs. These two files and the baseline table below move together in one reviewed commit, and only after the paid release gate has passed on the build they name: during development, as [Updating compatibility](#updating-compatibility) describes, or in the release commit. The release gate runs again against the release commit and nothing is published unless it passes, so a baseline advanced during development is still proven against exactly what ships. Never advance them to a version the gate did not exercise.

`MINIMUM_VERSIONS` in the same file is a separate frozen constant, stated in `README.md` and reported by the doctor, and is deliberately not derived from `VERIFIED_VERSIONS`. The baseline rises whenever a gate passes; the minimum moves only by an explicit decision to change what is supported. Deriving one from the other would drop support for working installs as a side effect of a baseline bump. Assert nothing about their relative order.

| Component | Verified baseline |
| --- | --- |
| Pi | 0.85.1, npm distribution; standalone tar.gz bridge live-verified on Linux x64 |
| Claude Code | 2.1.270 |
| Node.js | 24.16.0 on WSL2, Ubuntu CI, and Apple Silicon macOS CI; 22.23.1 on Ubuntu CI and Windows CI |
| Platform | Linux x64, gated on WSL2 Ubuntu; native Windows x64; macOS (deterministic CI) |

Pi's distribution is part of the baseline: the npm build runs on Node, the standalone tar.gz build is a compiled Bun binary, and `process.execPath` means something different on each. `scriptLaunch` in `src/host-runtime.ts` owns that difference. It sets `BUN_BE_BUN=1` so a compiled Pi runs the proposal bridge instead of its own entry point, and pins `--config=` to a neutral `bunfig.toml` in the private request directory: Pi's `--no-compile-autoload-bunfig` does not survive `BUN_BE_BUN`, so a `bunfig.toml` in the bridge's working directory would otherwise preload code into it. Keep the joined `--config=` form, because Bun ignores a space-separated one and then consumes the script path. The mechanism is part of the embedded Bun runtime on every standalone target. Record a standalone baseline only after `npm run test:paid:bridge-standalone` passes against that exact build.

A platform is live-verified only after `npm run test:paid:release` passes on it. `platformStatus` also treats `darwin` as verified, across architectures, on the [deterministic GitHub Actions matrix](.github/workflows/ci.yml), because nothing here takes a darwin-specific code path beyond the doctor's `sw_vers` probe. Linux is treated the same way across distributions: the gate runs on `linux/x64`, which is exactly what WSL2 Ubuntu is, and no distribution or kernel selects a different code path here. Architecture still decides verification, because it decides which Claude Code build is installed at all. Other platforms and versions continue with advisory warnings, while protocol and isolation mismatches fail closed. Supported effort values are `low`, `medium`, `high`, `xhigh`, and `max`; Pi `off` and `minimal` are hidden.

### Captured Claude Code surface

`test/support/captured/claude-<version>-help.txt` is `claude --help` captured byte-for-byte from the version `CAPTURED_CLAUDE_VERSION` in `test/support/claude-fixture.js` names. `validateClaudeCapabilities` decides whether the provider registers at all, so it is tested against help the CLI really emits rather than a hand-written list, which can spell flags the real help never shows.

Recapture with `npm run capture:claude-surface`, then point `CAPTURED_CLAUDE_VERSION` at the new file and review the diff. Re-pin deliberately, as part of moving the verified baseline — the diff on a CLI upgrade is the point of committing the artifact.

### Captured Claude Code protocol

Claude Code can run on a model that is not Anthropic's, and that is the cheapest way to see what its headless protocol really emits. It accepts an alternate endpoint and API-key authentication, and it maps each alias to a model of your choosing:

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_BASE_URL` | Endpoint to call, for example a local llama.cpp server answering `/v1/messages` |
| `ANTHROPIC_API_KEY` | Any value; it selects API-key authentication over the claude.ai login |
| `ANTHROPIC_DEFAULT_SONNET_MODEL`, `..._OPUS_MODEL`, `..._HAIKU_MODEL`, `..._FABLE_MODEL` | Model each alias resolves to, so `--model sonnet` reaches the local model |
| `ANTHROPIC_SMALL_FAST_MODEL` | Model for Claude Code's own side queries, such as session titles |

`npm run capture:claude-protocol` drives one provider request that way and writes the JSONL to `test/support/captured/claude-<version>-protocol.jsonl`. Its argument vector comes from `providerArgs`, not from a copy of it, so the capture describes a request this package actually makes; machine-identifying fields are redacted and everything else is kept verbatim. Point it at a server with `--base-url` or `PI_CLAUDE_LOCAL_BASE_URL` and pick the model with `--model`.

Unlike the help capture, this artifact is untracked (see `.gitignore`): it records one machine's run against one model, and it ages with the CLI that produced it. `captured-protocol.test.js` replays whichever capture is present and skips when there is none, so a fresh clone stays green and a contributor who takes a capture immediately gets it checked against the mapper. Take one after a Claude Code upgrade — a protocol change then becomes a failing test rather than a broken release.

This is a capture tool, never a way to run the provider on another model. The provider refuses that configuration at three independent points, and deliberately: `parseAuthStatus` requires a subscription (`src/auth.ts`), `buildClaudeEnvironment` never forwards `ANTHROPIC_*` to the process it starts, and `validateClaudeInitialization` requires `apiKeySource: "none"` (`src/claude-protocol.ts`). A capture also says nothing about Anthropic model behaviour — it exercises the CLI's protocol, not the model behind it, so the paid stages remain the only compatibility statement.

The technique earns its place: the first capture showed Claude Code reporting `max_tokens` on a message capped by `CLAUDE_CODE_MAX_OUTPUT_TOKENS` and then continuing to finish the turn under a different stop reason. This provider had been keeping the first stop reason and reporting a completed answer as truncated, which made Pi discard and repay for every compaction summary.

## Validation

### Deterministic checks

`npm run check` enforces dependency and import policy, Markdown links and versions, source boundaries, JavaScript syntax, and strict TypeScript. `npm test` runs deterministic tests. Neither command performs Claude inference or consumes subscription quota; `check` may run `claude --version` for advisory metadata.

### Free live lane

`npm run test:local` runs real Pi against the real provider transport with a local llama.cpp model standing in for Claude Code, so the lane costs nothing. `test/support/local-claude.js` implements the headless surface this package depends on — `--version`, `auth status`, the captured `--help`, the ordered JSONL protocol, a real `initialize` plus `tools/list` handshake against the proposal bridge, and the 143 exit of a correlated tool handoff — and takes its content from an OpenAI-compatible endpoint. It defaults to `openbmb/MiniCPM5-2B-GGUF:Q4_K_M` at `http://127.0.0.1:8080`; point it at another host with `--base-url` or `PI_CLAUDE_LOCAL_BASE_URL`, choose another model with `--model` or `PI_CLAUDE_LOCAL_MODEL`, and pass `--text-only` to skip the tool round trip. The lane refuses to start when the server does not serve the named model, so a missing server fails in seconds instead of mid-run.

Every deadline in the lane comes from one knob, `--timeout-ms` (or `PI_CLAUDE_LOCAL_TIMEOUT_MS`), defaulting to an hour: Pi's supervisor, the provider's idle and total timeouts, and the stand-in's own HTTP deadline. The provider's production defaults assume Claude Code's latency, and a small model on modest hardware can spend minutes on prompt processing before its first token while the stand-in answers in one piece — so without raising them an honest slow answer is reported as a hung process. The lane asserts against the provider's own metrics log, not the model's prose, so a small model's wording cannot make it flaky.

This lane is not a compatibility gate and never substitutes for one. It says this package's transport, bridge, tool handoff, and cleanup hold; it says nothing about what Claude Code actually emits, because no Claude Code ran. Only the paid stages below can move the verified baseline. `local-claude.test.js` covers the stand-in itself hermetically, against a stub endpoint, so `npm test` stays offline and fast.

### Paid tests

Subscription-consuming commands are named `test:paid:*`. They show the detected subscription, request caps, and quota/spend warning, then require the exact phrase `USE PAID CLAUDE QUOTA`. Noninteractive execution additionally requires `PI_CLAUDE_CODE_PROVIDER_CONFIRM_PAID_TESTS=1`. The underlying scripts refuse direct invocation, perform no automatic retries, and atomically claim a stage and aggregate slot before every provider or web-search Claude launch.

The runner gives Pi a temporary agent directory and disables automatic extension, skill, context-file, and prompt-template loading. Only the explicitly selected provider package is loaded. Both controls matter: `PI_CODING_AGENT_DIR` alone does not suppress `~/.agents/skills`. Keep personal skill directories in place; tests must not depend on moving them. Claude subscription authentication and organization-managed policy remain available.

| Command | Maximum Claude launches |
| --- | ---: |
| `npm run test:paid:smoke` | 1 |
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
| `npm run test:paid:matrix` | 15 |
| `npm run test:paid:release` | 61 |

Run paid stages one at a time. `model-matrix.js` checks for leaked private directories by diffing the whole temporary root, so another provider request running at the same time reads as a leak.

The tool steps need only the shell Pi's `bash` tool uses: on Windows, Git Bash at `%ProgramFiles%\Git\bin\bash.exe` or a `bash.exe` on `PATH`. They run shell scripts rather than an interpreter such as Python, so a gate result never depends on what else is installed, and `test:paid:full` checks for that shell before its first Claude launch.

`PI_CLAUDE_CODE_PROVIDER_PI_BIN` selects which Pi executable the live scripts launch; without it they launch the CLI entry of the development Pi described under Setup. This is deliberately separate from package resolution, so one npm-hosted development host can drive both distributions. `bridge-standalone` refuses to start unless that variable is set; point it at an extracted tar.gz `pi`.

Both bridge lanes are required, and `test:paid:release` runs both. A `--no-tools` turn passes even when the proposal bridge never starts, so only a turn that actually round-trips a tool distinguishes a working bridge from a broken one. `/pi-claude-code-provider-doctor` performs the same handshake without consuming quota.

The release suite covers text, tool, image, isolation, recovery, Unicode, history, web search, cache reuse, both bridge lanes, the gated aliases, and the supported effort matrix. Successful RPC harnesses close stdin so Pi can run session shutdown and flush metrics before exit. The model matrix asserts the family an alias serves, not a dated model id, so an upstream model refresh cannot fail the gate while an alias serving the wrong family still does. Every entry also checks context/output capabilities, cleanup, and the absence of leaked private directories. Pro's `opus` entry retains the conservative 200K context limit.

Fable is selectable but excluded from the release gate, because its availability and billing vary by tier. On Pro it requires usage credits, and with credits turned off every Fable request fails with an assistant error. Run `npm run test:paid:fable` only on an account where that spend is available and separately authorized; the blocking Sonnet and Opus cases already exercise the shared transport.

**Read the reported error before blaming the model.** When a turn ends in an assistant error, such as disabled usage credits, a rate limit, or a lost login, the live scripts fail with that error by name. Only a reply that arrived with the wrong text is evidence about model behavior.

### Prompt caching

Cache-hit percentage is `cacheRead / (input + cacheRead + cacheWrite) * 100`; cache writes seed later reuse and are not hits. [DESIGN.md](DESIGN.md#compatibility-and-performance) explains the mechanisms behind these rules.

Preserve these when changing serialization or Claude arguments:

- **Append-stable history.** Each request serializes the complete current transcript as append-stable history blocks with a sorted tool catalog. Never rewrite unchanged history.
- **The token-reminder pin.** Keep `totalTokensReminder: "off"` in the pinned settings; Claude Code otherwise appends a changing `<total_tokens>` reminder that breaks reuse across fresh print-mode processes. The setting is undocumented and follows [bcherny's maintainer guidance](https://github.com/anthropics/claude-code/issues/81259#issuecomment-5311888970), so do not remove it without a replacement cache probe and new upstream guidance.
- **The transcript breakpoint.** `providerArgs` marks the last history block with `ttl: "1h"`, because Claude Code places no breakpoint inside the replayed history. The TTL is load-bearing: the API's longest-TTL-first ordering rejects a shorter one ahead of Claude Code's own markers. The API allows four breakpoints, and a fifth from any source fails every request, so count them with the capture below before adding one. `PI_CLAUDE_CODE_PROVIDER_TRANSCRIPT_BREAKPOINT=off` is the user-facing escape hatch for that failure, not a substitute for the release gate.
- **Attachments.** Keep every image in the effective Pi context attached, including after a reply, at a content-addressed path stable for the Pi session. Preserve transcript records and generated attachment order. A changing private path ahead of the transcript can defeat reuse. [DESIGN.md](DESIGN.md#request-and-transcript-transport) explains why.
- **Records per request.** Keep the records appended between requests under the ceiling described in DESIGN.md.

`npm run capture:claude-breakpoints` checks the request shape without spending quota. It builds a request from the provider's own `providerArgs` and `buildClaudeEnvironment`, captures it against a loopback server with a dummy token, and prints the breakpoint table, the first block that differs between two captures in different private directories, and a verdict; it exits non-zero unless the shape is healthy. Like the provider, it runs Claude in a project directory: a disposable git repository with a configured clean filter and a same-size edit to the filtered file. The verdict is also BROKEN if that filter runs, a project file changes, Claude Code reports no working directory or one other than the project, the private request directory reaches the model outside attachment narration, or the proposal bridge is not ready. `--claude` selects a build, `--model` an alias and `--effort` its effort level, `--strip-marker` gives the control arm without editing `src/`, `--images` and `--no-tools` vary the payload, and `--output` writes the last captured request body to a file. Run it against every new Claude Code build before trusting the rules above.

`test:paid:cache` runs on `sonnet:low` and `test:paid:cache-haiku` on `haiku:low`. Both are required: Haiku receives Claude Code's environment block ahead of the transcript, so a varying block there breaks Haiku while Sonnet still passes. Each reuse turn must reach 80% cache hits and write less than a quarter of turn 1's cache write, so a large stable system prompt cannot hide a rewritten transcript. Haiku 4.5 caches nothing below 4096 tokens, so keep the probe's padding above that. The padding starts with a per-run nonce; its turns are otherwise identical between runs, so without one a warm entry from an earlier run could satisfy turn 2 while reuse inside the run is broken.

`test:paid:cache-images` and `test:paid:cache-images-haiku` apply the same hit and write bounds on Sonnet and Haiku while asking three different questions about one image attached only on turn 1. Correct answers on turns 2 and 3 prove Claude can re-inspect a historical image; the usage bounds prove stable attachment paths preserve cache reuse. These stages are blocking in `test:paid:release`.

`PI_CLAUDE_CODE_PROVIDER_CACHE_MODEL` points the `cache` stage at another alias. The probe's exact-reply assertions are written for Sonnet and Haiku, so on another alias read the reported error first and use `npm run capture:claude-breakpoints` for the request shape.

**A single zero reading is not evidence.** Reuse can read 0% on a request byte-identical to one that reads 99%. Before concluding that a model or a serialization change has broken caching, repeat the measurement and diff the wire requests with `npm run capture:claude-breakpoints`.

## Updating compatibility

When updating Claude Code compatibility:

1. Compare the required CLI flags, initialization fields, stream records, and exact tool inventory.
2. Recapture the help surface with `npm run capture:claude-surface` and re-pin `CAPTURED_CLAUDE_VERSION`.
3. Run `npm run capture:claude-breakpoints` for `sonnet` and `haiku`, and continue only on HEALTHY verdicts.
4. Cover readiness, invalid or oversized JSONL, timeouts, aborts, error exits, and descendant cleanup deterministically.
5. Run the full paid release gate on the new build, with explicit quota authorization.
6. Only then move `src/compatibility.ts`, CI, and the baseline table together.

When updating Pi compatibility, read the current package, extension, provider, session, and compaction contracts, then test a clean Git or packed installation on both the npm and standalone distributions.

## Release procedure

1. Confirm the worktree is clean and the npm name and metadata are correct.
2. Promote `[Unreleased]` in `CHANGELOG.md` to a dated version entry.
3. Run `npm run release:check` and inspect `npm pack --dry-run`.
4. Install the tarball in a fresh temporary directory and list its models with Pi.
5. If the Claude Code version under test changed since the last release, run `npm run capture:claude-breakpoints` for `sonnet` and `haiku` and require HEALTHY verdicts. If runtime code changed, run the explicitly authorized paid release gate.
6. Run `npm publish --dry-run` and inspect the exact inventory.
7. Publish, tag, and create the GitHub release only with maintainer authorization.

This repository contains no automatic publishing workflow.

## Documentation and Git hygiene

- `README.md` owns installation, usage, configuration, material limitations, and troubleshooting.
- `DESIGN.md` owns architecture and security design.
- `DEVELOPING.md` owns setup, validation, compatibility, and release procedures.
- `CONTRIBUTING.md` owns contribution requirements.
- `SECURITY.md` owns vulnerability reporting.
- `CHANGELOG.md` owns user-visible release history.

Maintained documents state current behavior, rules, and procedures, each with its reason. Record measurements, individual test runs, and investigation history in commit messages, pull requests, or `CHANGELOG.md` entries, so these files stay useful rather than turning into activity logs.

Do not commit credentials, Claude state, prompts, temporary transport data, diagnostic reports, metrics logs, coverage, root dependencies, or a root lockfile. Stage explicit paths and inspect every diff before committing.
