# Developing

## Setup

An **npm-installed** global Pi is required. Runtime imports and test types resolve from the active `pi` executable, and only the npm layout exposes those packages: the standalone tar.gz build compiles them into a single binary. A standalone Pi is a supported *runtime target*, not a supported development host, and `npm run check` says so by name if the `pi` on `PATH` is the compiled build.

```bash
npm run setup:dev
npm run check
npm test
```

Do not run `npm install` at the repository root. The package has no installed dependencies and must not contain root `node_modules` or a root lockfile. `setup:dev` installs the isolated, locked `tooling/` package containing the TypeScript parser/compiler and Node declarations used by source-policy checks and typechecking. Its ignored `node_modules/` is generated development state, not published runtime code. Pi loads the TypeScript extension directly; there is no runtime build.

When npm and standalone Pi installations coexist, development uses whichever `pi` resolves first on `PATH`. Put the npm installation's bin directory first for `npm run check` and `npm test`; verify it with `command -v pi` on POSIX or `where pi` on Windows. Keep the development host npm-based, and use `PI_CLAUDE_CODE_PROVIDER_PI_BIN` only to select a standalone executable for the live bridge lane. The resolver recognizes both `dist/cli.js` and `dist/bundle/cli.js` npm layouts and checks package identities. Resolving a newer layout does not establish version compatibility: if that installation's exported modules have missing dependencies, use an isolated npm installation of the verified Pi version rather than modifying the global install.

To load a local checkout:

```bash
pi install /absolute/path/to/pi-claude-code-provider
```

## Architecture

| Change area | Owning modules | Focused validation |
| --- | --- | --- |
| Extension startup and session lifetime | `extensions/pi-claude-code-provider.ts` | `extension.test.js` |
| Authentication, CLI, and compatibility | `src/auth.ts`, `src/claude-args.ts`, `src/compatibility.ts` | `auth.test.js`, `claude-args.test.js`, `compatibility.test.js` |
| Transcript and provider lifecycle | `src/context-serializer.ts`, `src/provider.ts`, `src/stream-events.ts`, `src/claude-protocol.ts` | `context-serializer.test.js`, `provider.test.js`, `stream-events.test.js` |
| Runtime launch, process trees, and private state | `src/host-runtime.ts`, `src/process-utils.ts`, `src/runtime-directories.ts` | `process-utils.test.js`, `runtime-directories.test.js` |
| Failure classification and bounded capture | `src/errors.ts`, `src/text.ts` | `errors.test.js`, `text.test.js` |
| Local-model live lane | `test/support/local-claude.js`, `scripts/local-test.js` | `local-claude.test.js` |
| Captured Claude Code protocol | `scripts/capture-claude-protocol.js` | `captured-protocol.test.js` |
| Visible web search | `src/web-search.ts` | `web-search.test.js` |
| Diagnostics and metrics | `src/diagnostics.ts`, `src/doctor.ts`, `src/metrics.ts` | `metrics-doctor.test.js` |
| Proposal-only MCP bridge | `bridge/mcp-proposal-server.js` | `mcp-bridge.test.js` |

Pi remains authoritative for prepared context, branches, compaction, active tools, execution, provider handoff, and cancellation. Read the matching Pi checkout's contributor and provider documentation before changing those boundaries. Pi imports remain optional `*` peer dependencies and are not bundled.

## Compatibility baseline

`src/compatibility.ts` owns Pi/Claude version, platform, and model-resolution values; `.github/workflows/ci.yml` owns the Node CI matrix and the Pi version CI installs. These three move together in the release commit, and the release gate then runs against exactly that commit; nothing is published unless it passes. Never advance them in a commit no gate will run against, and never advance them to a version the gate did not exercise.

`MINIMUM_VERSIONS` in the same file is a separate frozen constant, stated in `README.md` and reported by the doctor, and is deliberately not derived from `VERIFIED_VERSIONS`. The baseline rises whenever a gate passes; the minimum moves only by an explicit decision to change what is supported. Deriving one from the other would drop support for working installs as a side effect of a baseline bump. Assert nothing about their relative order. They coincide today because the gate validates the versions the minimum names, and they will diverge again the next time the baseline advances and the minimum deliberately does not.

| Component | Verified baseline |
| --- | --- |
| Pi | 0.85.1, npm distribution; standalone tar.gz bridge live-verified on Linux x64 |
| Claude Code | 2.1.261 |
| Node.js | 24.16.0 on WSL2 and Apple Silicon macOS CI; 22.23.1 on Windows |
| Platform | Linux x64, gated on WSL2 Ubuntu; native Windows x64; Apple Silicon macOS 26.5 (arm64) |

Pi's distribution is part of the baseline, not an implementation detail: the npm build runs on Node and the standalone tar.gz build is a compiled Bun binary, and `process.execPath` means something different on each. `src/host-runtime.ts` owns that difference in one place (`scriptLaunch`), which sets `BUN_BE_BUN=1` so a compiled Pi binary runs the proposal bridge instead of its own embedded entry point, and pins `--config=` to a neutral `bunfig.toml` in the private request directory. Pi compiles with `--no-compile-autoload-bunfig`, but that protects Pi's own entry point only and does not survive `BUN_BE_BUN`; without the pin, a `bunfig.toml` in the bridge's working directory preloads code into it. Only the joined `--config=` form works, as Bun ignores a space-separated one and then consumes the script path. The mechanism is not Linux-specific: Pi builds all six standalone targets from one `bun build --compile` invocation, and `BUN_BE_BUN` is part of the embedded Bun runtime on each. Record a standalone baseline only after `npm run test:paid:bridge-standalone` passes against that exact build.

Apple Silicon macOS passes the [deterministic GitHub Actions matrix](.github/workflows/ci.yml) and has community-reported live coverage for the release stages described below. `platformStatus` treats `darwin` as verified across architectures rather than `arm64` alone: the report is accepted as a macOS report, and nothing here takes a different code path on an Intel Mac. Linux is treated the same way across distributions: the gate runs on `linux/x64`, which is exactly what WSL2 Ubuntu is, and no distribution or kernel selects a different code path here. Architecture still decides verification, because it decides which Claude Code build is installed at all. Other platforms and versions continue with advisory warnings, while protocol and isolation mismatches fail closed. Supported effort values are `low`, `medium`, `high`, `xhigh`, and `max`; Pi `off` and `minimal` are hidden.

### macOS live validation

Community-reported, not maintainer-gated. A contributor ran the release stages on 2026-09-05 against macOS 26.5/arm64, Claude Code 2.1.260, Node 25.9.0, and Pi 0.84.2. Those versions are the reporter's, not this project's baseline, and are recorded here rather than in the table above so the baseline keeps stating only what a maintainer gate covered. Reported passing:

- Text, tools, images, isolation, recovery, Unicode, history, and web search.
- Prompt-cache reuse of 99.3% and 99.0% on subsequent turns.
- Tool bridge round trips through both npm Pi and the macOS arm64 standalone build.
- All 20 blocking model/effort combinations of the time. The reporter's `default` served Opus 5 at all five effort levels, while this project's served Sonnet 5 — the divergence that led to removing that alias.

The model matrix passes with personal skills left in place. Fable remains outside the blocking matrix. This report covers Pi 0.84.2 and does not extend to the 0.85.1 baseline above, which a maintainer gate carries; a maintainer reproduction on macOS would supersede this section.

### Captured Claude Code surface

`test/support/captured/claude-<version>-help.txt` is `claude --help` captured byte-for-byte, currently from **2.1.261**. `validateClaudeCapabilities` decides whether the provider registers at all, so it is tested against help the CLI really emits rather than a hand-written list; the previous synthetic fixture spelled `--system-prompt-file` as its own row, which real help has never done, and a special case had to be added to production preflight to compensate.

Recapture with `npm run capture:claude-surface`, then point `CAPTURED_CLAUDE_VERSION` in `test/support/claude-fixture.js` at the new file and review the diff. Re-pin deliberately, as part of moving the verified baseline — the diff on a CLI upgrade is the point of committing the artifact.

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

`npm run check` enforces dependency and import policy, Markdown links and versions, source boundaries, JavaScript syntax, and strict TypeScript. `npm test` runs deterministic tests. Neither command performs Claude inference or consumes subscription quota; `check` may run `claude --version` for advisory metadata.

### Free live lane

`npm run test:local` runs real Pi against the real provider transport with a local llama.cpp model standing in for Claude Code, so the lane costs nothing. `test/support/local-claude.js` implements the headless surface this package depends on — `--version`, `auth status`, the captured `--help`, the ordered JSONL protocol, a real `initialize` plus `tools/list` handshake against the proposal bridge, and the 143 exit of a correlated tool handoff — and takes its content from an OpenAI-compatible endpoint. It defaults to `openbmb/MiniCPM5-2B-GGUF:Q4_K_M` at `http://127.0.0.1:8080`; point it at another host with `--base-url` or `PI_CLAUDE_LOCAL_BASE_URL`, choose another model with `--model` or `PI_CLAUDE_LOCAL_MODEL`, and pass `--text-only` to skip the tool round trip. The lane refuses to start when the server does not serve the named model, so a missing server fails in seconds instead of mid-run.

Every deadline in the lane comes from one knob, `--timeout-ms` (or `PI_CLAUDE_LOCAL_TIMEOUT_MS`), defaulting to an hour: Pi's supervisor, the provider's idle and total timeouts, and the stand-in's own HTTP deadline. The provider's production defaults assume Claude Code's latency, and a small model on modest hardware can spend minutes on prompt processing before its first token while the stand-in answers in one piece — so without raising them an honest slow answer is reported as a hung process. The lane asserts against the provider's own metrics log, not the model's prose, so a small model's wording cannot make it flaky.

This lane is not a compatibility gate and never substitutes for one. It says this package's transport, bridge, tool handoff, and cleanup hold; it says nothing about what Claude Code actually emits, because no Claude Code ran. Only the paid stages below can move the verified baseline. `local-claude.test.js` covers the stand-in itself hermetically, against a stub endpoint, so `npm test` stays offline and fast.

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
| `npm run test:paid:fable` | 1 |
| `npm run test:paid:opus` | 1 |
| `npm run test:paid:matrix` | 15 |
| `npm run test:paid:release` | 52 |

`PI_CLAUDE_CODE_PROVIDER_PI_BIN` selects which Pi executable the live scripts launch; without it they launch the npm-hosted CLI entry. This is deliberately separate from package resolution, so one npm-hosted development host can drive both distributions. `bridge-standalone` refuses to start unless that variable is set; point it at an extracted tar.gz `pi`.

Both bridge lanes are required, and `test:paid:release` runs both. A `--no-tools` turn passes even when the proposal bridge never starts, so only a turn that actually round-trips a tool distinguishes a working bridge from a broken one. `/pi-claude-code-provider-doctor` performs the same handshake without consuming quota.

The release suite covers text, tool, image, isolation, recovery, Unicode, history, web search, cache reuse, both bridge lanes, the gated aliases, and the supported effort matrix. Fable is technically selectable, but validating it on Pro consumes separate paid credits rather than the included subscription allocation, so it is deliberately excluded from the release matrix; the blocking Sonnet and Opus cases already exercise the shared transport. `npm run test:paid:fable` remains an opt-in one-launch case for a maintainer who separately authorizes that spend. Successful RPC harnesses close stdin so Pi can run session shutdown and flush metrics before exit.

The model matrix asserts the family an alias serves, not a dated model id, so an upstream model refresh cannot fail the gate while an alias serving the wrong family still does. Every entry also checks context/output capabilities, cleanup, and the absence of leaked private directories. Pro's `opus` entry retains the conservative 200K context limit.

Each request serializes the complete current transcript. Cache-hit percentage is `cacheRead / (input + cacheRead + cacheWrite) * 100`; cache writes seed later reuse and are not hits. Preserve append-stable history blocks and sorted tool catalogs when changing serialization. Claude Code 2.1.233 introduced a changing `<total_tokens>` reminder that broke reuse across fresh print-mode processes; the provider pins `totalTokensReminder: "off"` following [bcherny's maintainer guidance](https://github.com/anthropics/claude-code/issues/81259#issuecomment-5311888970). The setting is otherwise undocumented, so do not remove it without a replacement cache probe and new upstream guidance.

## Platform and compatibility work

Windows cleanup must remain rooted at the exact retained child PID. Never replace it with `/IM`, name-based PowerShell termination, or global process enumeration. Automatic stale-directory recovery stays disabled on Windows; inspect Node's temporary root and package markers before removing confirmed stale state.

`streamSimple` owns both halves of Pi's provider request contract: apply the `onPayload` replacement before launching Claude, and invoke `onResponse` once initialization validates, before publishing content. Dropping either silently disables the matching Pi extension event for this provider.

When updating Claude compatibility:

1. Compare the required CLI flags, initialization fields, stream records, and exact tool inventory.
2. Cover readiness, invalid or oversized JSONL, timeouts, aborts, error exits, and descendant cleanup deterministically.
3. Run guarded live, cache, and model gates only with explicit quota authorization.
4. Update machine-readable and written baselines only after the gates pass.

When updating Pi compatibility, read the current package, extension, provider, session, and compaction contracts, then test a clean Git or packed installation on both the npm and standalone distributions.

## Release procedure

1. Confirm the worktree is clean and the npm name and metadata are correct.
2. Promote `[Unreleased]` in `CHANGELOG.md` to a dated version entry.
3. Run `npm run release:check` and inspect `npm pack --dry-run`.
4. Install the tarball in a fresh temporary directory and list its models with Pi.
5. If runtime code changed, run the explicitly authorized paid release gate.
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

Do not commit credentials, Claude state, prompts, temporary transport data, diagnostic reports, metrics logs, coverage, root dependencies, or a root lockfile. Stage explicit paths and inspect every diff before committing.
