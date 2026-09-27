# Contributing

> **This project is mothballed after the release of v0.6.0.** Pi and Claude Code are both extremely fast-moving projects that publish breaking changes regularly, and this was a hobby project rather than a professional venture, so I have other plans for my time and my tokens. I encourage people to look for other providers, such as [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge), which is built on the Agent SDK. Please do not report further issues or submit pull requests. If Pi and Claude Code stabilize in future months, I may revisit this project. I thank my users for their kind words and wish everyone good luck with their own efforts.

Keep changes small, evidence-based, and understandable. Read [DEVELOPING.md](DEVELOPING.md) and [DESIGN.md](DESIGN.md) before modifying provider behavior.

## Before submitting a change

```bash
npm run setup:dev
npm run check
npm test
```

Default validation must not start a Claude session, perform inference, or consume subscription quota. `npm run check` may execute `claude --version` for advisory compatibility metadata. Do not run `test:paid:*` without reviewing its request cap and explicitly confirming the quota/spend warning.

New tests must protect a distinct observable behavior, failure mode, security invariant, cleanup contract, or release policy. Update the owning documentation when behavior changes; do not duplicate maintained claims across files.

Do not add runtime dependencies for functionality available from Node, Pi's documented peer modules, or a small audited standard-library implementation. Treat lockfile and dependency changes as code.

If an AI agent or LLM helped create a GitHub issue or pull request, disclose its model, harness, version, and thinking level.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Upstream Pi

This repository is independent of Pi. Do not open an issue or pull request against Pi on this project's behalf without maintainer approval and compliance with Pi's current contributor gate.
