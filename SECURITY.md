# Security policy

> **This project is mothballed after the release of v0.6.0.** Pi and Claude Code are both extremely fast-moving projects that publish breaking changes regularly, and this was a hobby project rather than a professional venture, so I have other plans for my time and my tokens. I encourage people to look for other providers, such as [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge), which is built on the Agent SDK. Please do not report further issues or submit pull requests. If Pi and Claude Code stabilize in future months, I may revisit this project. I thank my users for their kind words and wish everyone good luck with their own efforts.
>
> Vulnerability reports are no longer accepted, by email or through GitHub private vulnerability reporting; the policy below describes the project while it was maintained.

## Supported versions

Security fixes are provided for the latest released version and the current `main` branch.

## Reporting a vulnerability

Do not open a public issue. Report suspected vulnerabilities to [sineverbisnon@gmail.com](mailto:sineverbisnon@gmail.com) or through GitHub private vulnerability reporting.

Include the affected version or commit, impact, minimal reproduction, platform and relevant Pi/Claude versions, and whether credentials, prompts, private files, or subscription usage may be exposed.

Do not send credentials, Claude session files, raw private prompts, or unrelated personal data. Use synthetic fixtures whenever possible.

Reports will be validated privately and disclosure coordinated after a fix is available. No fixed response-time or bounty commitment is offered.

## Scope

In scope are unintended credential or prompt disclosure, bypass of the Claude capability boundary, invisible tool execution, unsafe private-path exposure, incomplete process or private-state cleanup, and diagnostic leakage.

Expected Pi package privileges, ordinary prompt-injection risk, upstream Claude or Pi behavior without a package boundary violation, and denial of service from trusted local executables are generally out of scope. See [DESIGN.md](DESIGN.md#security-and-privacy) for the maintained security model.
