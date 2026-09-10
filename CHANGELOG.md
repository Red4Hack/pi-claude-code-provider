# Changelog

## [Unreleased]

### Fixed

- An exhausted Claude subscription window now ends the turn instead of being retried. Claude Code reports it as HTTP 429, which Pi's retry classifier reads as transient throttling, so a session or weekly limit was restarted on a backoff, spending one Claude launch per attempt against a window that could not open before its reset. Provider failures now carry the account-limit marker Pi stops on, and genuinely transient failures keep their retryable wording.
- The MCP tool-catalog readiness deadline rose from five to twenty seconds, and it now also ends on Claude's own validated initialization record or on a failure Claude already reported. An ordinary slow Claude Code start was failing requests that were about to succeed, and the report named the deadline rather than the answer Claude had already given.
- A readiness timeout reports its deadline in seconds. Pi classifies a failed turn by matching HTTP status substrings in its text, so the previous `5000ms` read as a retryable `500` and restarted a request that needed a fix.
- A tool call whose streamed input never closes its JSON now reports the evidence — how many bytes arrived and that the input ended mid-JSON, which is what a response truncated at its output-token limit looks like — instead of a bare `Claude emitted invalid arguments for tool <name>`. Model-authored tool input is never included in the message.
- A turn Claude Code continued past its output cap is no longer reported as truncated. Claude Code caps a response at `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, reports `max_tokens` on that message, then continues and finishes the turn under a different stop reason; the mapper kept the first stop reason it saw and reported `length` for a completed answer. Pi discards a compaction summary that stopped at its cap and pays for another one, so a finished summary was thrown away on every compaction once the requested budget was small enough to be hit. The terminal result envelope now states how the turn ended, and a turn that really did end at its cap still reports `length`. Captured from a real Claude Code run.
- Compaction no longer fails and re-runs at full token cost. Pi treats its requested `maxTokens` as the budget for the answer and adds the thinking budget to the response ceiling, because thinking is output too; this transport was passing the request through as the total ceiling, so reasoning ate the summary's room and the summary was cut off. Pi discards a summary that stopped at its token cap and pays for another one, which turned every compaction into a repeated charge. A requested cap now budgets the answer and reasoning is added on top of it, exactly as `adjustMaxTokensForThinking` does in pi-ai.
- A request whose prompt fits is no longer rejected for lack of an output reserve. The budget guard reserved the model's full output maximum, so on a 200K window it refused any prompt above roughly 136K estimated tokens while tens of thousands of tokens were still free — and each refusal made Pi compact. The ceiling is now clamped to the room the window actually has left, and only a prompt that leaves no room for a reply is refused before launch.
- Stale-state recovery terminates an abandoned Claude process group whose Pi process is gone, rather than leaving it running and its private directory in place. An abruptly killed Pi previously left a detached Claude process and its proposal bridge alive indefinitely. The group is signalled only when the live process still proves it owns that private directory, so a reused process identifier is never signalled; the proof reads `/proc` on Linux, and other platforms leave an unproven process alone exactly as before. `/pi-claude-code-provider-doctor` reports how many were reclaimed.

### Added

- `npm run capture:claude-protocol`, which records the JSONL protocol real Claude Code emits for a request built by `providerArgs`. Claude Code accepts an alternate endpoint, API-key authentication, and per-alias model overrides, so the capture costs no subscription quota; `captured-protocol.test.js` replays whichever capture is present and skips when there is none, keeping the artifact a local, untracked check rather than a committed fixture. The technique is what surfaced the capped-then-continued stop reason above. It captures only — the provider still refuses that configuration, and a capture says nothing about Anthropic model behaviour.
- `npm run test:local`, a free live lane that runs real Pi against the real provider transport with a local llama.cpp model standing in for Claude Code. It covers preflight, the proposal-bridge handshake, a tool round trip, and private-state cleanup without spending subscription quota, and asserts against the provider's own metrics rather than the model's prose. It is explicitly not a compatibility gate: no Claude Code runs in it, so only the paid stages can move the verified baseline. The stand-in itself is covered hermetically against a stub endpoint, so `npm test` stays offline.

### Changed

- Linux is verified on `x64` across distributions rather than for WSL2 Ubuntu alone, so a native Linux install no longer raises a startup platform advisory. WSL2 Ubuntu is `linux/x64`, and nothing in this package takes a different code path on another distribution or kernel — the same reasoning already applied to macOS architectures.
- A streaming tool-input preview stops being re-parsed past 64 KiB. Re-parsing every delta is quadratic in the size of the input, which a large file write reaches; the complete input is still parsed exactly once when the block closes.
- The pre-launch token estimate is calibrated rather than assumed. Measured against a real session transcript by comparing this transport's serialized bytes with Claude's own reported prompt counters over the same messages, dense agent history tokenizes at 2.12 bytes per token; the previous 3-byte ratio, described as conservative, under-counted such a transcript by about a fifth, so the guard did not bound what it claimed to. The ratio is now 2.4 bytes per token with the existing 10% margin.
- Protocol activity postpones the idle deadline through a timestamp read by one long-lived timer, instead of clearing and recreating a timer for every record.

## [0.2.0] - 2026-09-05

### Removed

- **Breaking.** Removed the `default` model alias. It sent no `--model` flag, so the served model was chosen by Claude Code account state that varies between accounts — observed as Sonnet on one and Opus on another — and never reflected the model selected in the user's own Claude Code settings, which this provider does not load. Pi reports an unknown model for a saved `pi --model pi-claude-code-provider/default` or profile entry.

### Added

- `/pi-claude-code-provider-doctor` and the diagnostic report name the model each alias resolves to, without consuming subscription quota. Values that cannot be read report `unavailable` and never affect model selection.
- Minimum supported Pi and Claude Code versions in `README.md`, reported by the doctor. They are advisory: an older installation is not blocked and may still run.
- `PI_CLAUDE_CODE_PROVIDER_ACKNOWLEDGED_PLATFORM` suppresses one named platform's startup advisory without changing its verification status ([#3](https://github.com/chem/pi-claude-code-provider/pull/3)).
- `npm run capture:claude-surface`, which captures `claude --help` verbatim for the capability tests.

### Changed

- The verified baseline advances to Pi 0.85.1 and Claude Code 2.1.261, and CI installs the Pi version the baseline names.
- macOS is recognized as verified on both architectures, with community-reported live coverage recorded in `DEVELOPING.md` ([#2](https://github.com/chem/pi-claude-code-provider/pull/2)). It no longer raises a startup platform advisory.
- The paid model matrix asserts model families instead of dated model ids, so upstream model refreshes no longer fail it.
- `DESIGN.md` records what Claude Code adds to the model's view that this package cannot remove, the effect of dropping the user's Claude Code setting sources, and why the prompt-cache setting is pinned.

### Fixed

- Preflight no longer decides whether the provider can run by scraping `claude --help` for `--system-prompt-file`, which is documented but absent from the help screen. A minimum supported version covers it instead.
- npm Pi installations whose CLI lives in `dist/bundle/cli.js` resolve by locating the owning package rather than assuming its depth ([#2](https://github.com/chem/pi-claude-code-provider/pull/2)).
- Paid validation is isolated from personal Pi settings, extensions, skills, and context files without moving user files ([#2](https://github.com/chem/pi-claude-code-provider/pull/2)).

## [0.1.4] - 2026-08-23

### Fixed

- Restore prompt-cache reuse broken by Claude Code 2.1.233's undocumented, changing token reminder. The provider now applies the maintainer-recommended `totalTokensReminder: "off"` setting; the cache gate verifies reuse across fresh processes.
- Honor Pi's per-request output limit, including compact 2,048-token branch-summary requests, while clamping it to the model maximum and reserving the same amount in context checks.
- Fail clearly on sanitized MCP initialization errors, malformed provider-hook payloads, near-match CLI options, oversized in-flight bridge requests, and process-tree termination failures. Cleanup errors now preserve the original failure, settle promptly, and retain the owned marker when process liveness is unknown.

### Changed

- Simplify transport guidance and child configuration, report bridge launches as structured argument vectors, and share Claude protocol/runtime helpers across provider, search, diagnostics, and tests.
- Update the verified baseline to Pi 0.84.2 and Claude Code 2.1.241.

## [0.1.3] - 2026-08-20

### Fixed

- Launch the proposal bridge through Pi's actual host runtime. Standalone Pi builds now use their embedded Bun runtime with a neutral pinned `bunfig.toml`, fixing tool proposals and preventing working-directory preload configuration.

### Added

- Add a real bridge handshake to the doctor and diagnostic report.
- Add npm and standalone bridge live gates, selectable with `PI_CLAUDE_CODE_PROVIDER_PI_BIN`.

### Changed

- Include dates in rate-limit reset notices.
- Add resolved bridge and bounded stderr context to MCP startup failures.
- Diagnose standalone Pi as a supported runtime but unsupported development host.
- Verify Pi 0.84.2, Claude Code 2.1.237, and standalone Pi on Linux x64.

## [0.1.2] - 2026-08-09

### Fixed

- Report a rate limit only when one constrains the request. A rejected overage no longer overrides a healthy plan window, so a subscription with usage credits disabled at the account level no longer warns on every request, and the reported window name and utilization are preserved.
- Report each distinct rate-limit notice once per session rather than once per Claude process, which this transport starts for every tool round-trip.

## [0.1.1] - 2026-08-08

### Added

- Add `PI_CLAUDE_CODE_PROVIDER_MCP_READY_TIMEOUT_MS` to override the five-second MCP tool-catalog readiness timeout.

### Changed

- Verify the existing `opus` alias resolves to Claude Opus 5, retain its safe 200K Pro context limit, and update the verified baseline to Pi 0.84.1 and Claude Code 2.1.226.
- Improve provider and web-search rate-limit notifications with whole-percent utilization, reset times, and overage status.
- Align with Pi's provider lifecycle: stream partial responses as `pending` and invoke and await `after_provider_response` observers before publishing content.

### Fixed

- Improve web-search cancellation and cleanup: do not launch Claude for a pre-cancelled request, and recover stale private output left by abrupt exits.
- Tolerate newer Claude Code result, stop-reason, and advisory rate-limit envelopes while preserving useful error diagnostics.

## [0.1.0] - 2026-07-19

Initial public release.
