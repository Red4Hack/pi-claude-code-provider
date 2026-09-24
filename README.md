# pi-claude-code-provider

A [Pi](https://pi.dev) package that creates a provider for Claude family models from a subscription-authenticated Claude Code installation by launching Anthropic's installed `claude` executable in documented non-interactive print mode. Pi remains fully in charge of the session: branching, compaction, and history behave like any other Pi provider, and every tool runs visibly in Pi — the Claude process can propose tool calls but never execute anything on its own. The goal is simple: the convenience of your Claude subscription in Pi, with the fewest possible surprises.

This package never imitates private OAuth traffic, does not use the Agents SDK, and does not modify Claude's internal session files. It never reads Claude credentials or uses an Anthropic API key.

This project was developed using frontier AI models under human guidance. Almost all of the docs and code were written by machines except for this introductory material. The project may be over-engineered in some respects; that's fine. If you enjoy this package, please star it on github.

## Requirements

- [Pi](https://pi.dev) 0.86.1 or newer, installed from npm or a standalone build
- Claude Code 2.1.281 or newer
- Claude Code logged in to an eligible Pro, Max, Team, or Enterprise claude.ai subscription
- Node.js 22.19 or newer only when Pi itself is installed from npm; the standalone build needs no separate Node installation

These are minimum versions; see the [compatibility baseline](DEVELOPING.md#compatibility-baseline) for tested versions and platforms. The doctor warns about older versions and unverified platforms.

The provider requires first-party subscription authentication. API keys and routing through Bedrock, Vertex, or Foundry are unsupported. If `claude` is not on `PATH`, set `PI_CLAUDE_CODE_PROVIDER_PATH` to its executable path.

## Install

```bash
pi install npm:pi-claude-code-provider
```

To install directly from GitHub's default branch:

```bash
pi install git:github.com/chem/pi-claude-code-provider
```

Add `-l` for a project-local installation. Pi loads project packages only after the project is trusted; use `pi config` to enable or disable the extension.

## Use

Open `/model` and choose `sonnet`, `fable`, `opus`, or `haiku` under `pi-claude-code-provider`.

To select one directly:

```text
/model pi-claude-code-provider/sonnet
```

From the command line, use `pi --model pi-claude-code-provider/sonnet`.

Sonnet, Fable, and Opus support Pi thinking levels from `low` through `max`. Haiku uses Claude Code's default thinking, even when Pi shows thinking as off. Sonnet, Fable, and Opus have a 1M context window on every plan, including Pro; Haiku has 200K.

Fable availability and billing vary by subscription tier; see Anthropic's [Fable plan policy](https://support.claude.com/en/articles/15424964-claude-fable-5-on-your-plan).

To see which model served a response, inspect `responseModel` in Pi's JSON output.

After installation or an upstream update, run:

```text
/pi-claude-code-provider-doctor
```

The doctor checks versions, model aliases, and the tool bridge without consuming subscription quota. It also reports recent prompt-cache reuse and context-window mismatches.

Run `/pi-claude-code-provider-doctor report` for a content-free diagnostic report. Inspect it before sharing it.

The `pi_claude_code_provider_web_search` tool uses Claude's WebSearch and WebFetch. It always uses Sonnet at medium effort, regardless of the selected model, and has a three-minute limit. If unavailable, check Pi's tool filters and whether another extension owns the name.

## Subscription usage

Provider and web-search requests consume Claude subscription capacity; canceling a running request may still consume it. Optional usage credits may incur additional spend after plan limits. The package reports token counts when available, but shows zero monetary cost because it cannot determine subscription billing.

This project uses Anthropic's documented [`claude --print` interface](https://code.claude.com/docs/en/cli-reference). Anthropic explains [subscription limits for third-party usage](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) and [usage credits](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan).

Pi shows Claude's rate-limit warnings and reset times when available.

## Compatibility limitation

Claude Code's public headless protocol cannot accept arbitrary past assistant messages or tool results. The provider therefore sends Pi's current history on every request. Pi still owns branching, compaction, and tool execution, but this transport uses more context than Anthropic's Messages API. See [DESIGN.md](DESIGN.md#compatibility-and-performance) for caching and performance details.

Images remain available throughout the current Pi context. Each request allows up to 20 images, subject to size limits; [DESIGN.md](DESIGN.md#request-and-transcript-transport) describes their transport.

## Configuration

| Variable | Purpose |
| --- | --- |
| `PI_CLAUDE_CODE_PROVIDER_ACKNOWLEDGED_PLATFORM` | Hide the startup advisory for one exact platform/architecture (for example `linux/arm64`). The doctor still reports its verification status. |
| `PI_CLAUDE_CODE_PROVIDER_BORROW_SOLE_DIRECTORY` | `on` lets a tool-bearing side request without a cwd declaration borrow the sole registered session's directory. Off by default because that directory may be wrong. |
| `PI_CLAUDE_CODE_PROVIDER_PATH` | Override the `claude` executable path. |
| `PI_CLAUDE_CODE_PROVIDER_METRICS_LOG` | Append content-free request and search metrics as JSONL. |
| `PI_CLAUDE_CODE_PROVIDER_IDLE_TIMEOUT_MS` | Override the five-minute protocol-idle timeout for provider requests, in positive milliseconds. |
| `PI_CLAUDE_CODE_PROVIDER_TOTAL_TIMEOUT_MS` | Override the 30-minute total timeout for provider requests, in positive milliseconds. |
| `PI_CLAUDE_CODE_PROVIDER_MCP_READY_TIMEOUT_MS` | Override the five-second tool bridge readiness timeout, in positive milliseconds. |
| `PI_CLAUDE_CODE_PROVIDER_THINKING_DISPLAY` | `summarized` (default), `omitted` (hide thinking text), or `off` (disable the display request if Claude Code rejects it). |
| `PI_CLAUDE_CODE_PROVIDER_TRANSCRIPT_BREAKPOINT` | `on` (default) or `off`. Turn it off only if Claude Code rejects excess cache breakpoints; this disables the provider's prompt caching. |

Metrics exclude prompts, messages, queries, output, credentials, stderr, and temporary paths. On POSIX, the log is mode 0600; Windows uses the selected location's ACL.

Claude receives an allowlisted environment, including `CLAUDE_CONFIG_DIR` for a relocated configuration and `NODE_EXTRA_CA_CERTS` for a proxy's CA bundle.

## Security and troubleshooting

Pi packages run with your permissions; review the source before installation. Claude runs in Pi's session working directory and can read some project files at startup. Its proposed file and shell actions run as visible Pi tools. The provider suppresses user and project Claude customizations, but administrator-managed settings, hooks, and MCP policy can still run. See [DESIGN.md](DESIGN.md#what-claude-code-adds-on-its-own) for startup behavior and [SECURITY.md](SECURITY.md) for vulnerability reporting.

Tool-bearing side requests need a registered Pi session or a working-directory declaration in the system prompt. That declaration is caller-controlled; see [DESIGN.md](DESIGN.md#process-and-storage-lifecycle) for routing details.

### Troubleshooting

- **Provider missing or unavailable:** run `/pi-claude-code-provider-doctor`, correct the problem it reports, then run `/reload`.
- **Authentication or subscription failure:** run `claude auth status` and sign in with an eligible subscription. For rate-limit or billing errors, check your subscription limits and usage-credit settings. Logins through `CLAUDE_CODE_OAUTH_TOKEN` are unsupported.
- **Tools fail or requests report `mcp_startup`:** run the doctor to check the tool bridge handshake.
- **A request keeps failing:** run `/pi-claude-code-provider-doctor report` and inspect the report before sharing it. Include the exact error and steps to reproduce when [opening an issue](https://github.com/chem/pi-claude-code-provider/issues).

## Development and license

See [DEVELOPING.md](DEVELOPING.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [DESIGN.md](DESIGN.md). Licensed under MIT.
