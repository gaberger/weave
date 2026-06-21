# ADR-0014: Communication channels (email / Slack / Telegram)

- **Status:** Accepted
- **Date:** 2026-06-20
- **Deciders:** project owner
- **Tags:** channels, notifications, ports, security
- **Depends on:** [ADR-0004](ADR-0004-toolhost-capability-model.md), [ADR-0012](ADR-0012-skill-plugin-system.md)

## Context

weave needs to *communicate out* — notify a human when a target drifts, a paper is found, a
check fails. We want primitives for email, Slack, and Telegram. This is OpenClaw's
"transport-only channel plugins" idea: a thin `Channel` port with one adapter per transport,
behind a stable core.

## Decision

### 1. A `Channel` port + `Notification`

```ts
interface Notification { text: string; title?: string; level?: "info" | "warn" | "error" }
interface Channel { readonly name: string; send(n: Notification): Promise<void> }
```

### 2. HTTP-based adapters (no native deps → Bun-compilable), with an injectable sender

- **`slackChannel({webhookUrl})`** — POST `{text}` to a Slack incoming webhook.
- **`telegramChannel({token, chatId})`** — POST to `api.telegram.org/bot<token>/sendMessage`.
- **`emailChannel({apiUrl, apiKey, from, to})`** — POST to an HTTP email API
  (Resend/SendGrid-shape: `{from,to,subject,text}` + Bearer key). HTTP, not raw SMTP, to stay
  dependency-free and single-binary-friendly; raw SMTP is a follow-up.

Each adapter takes an injectable HTTP sender (defaults to `fetch`), so the request shaping is
unit-testable offline. Channels are built from config/env (`channelsFrom`): only the ones
whose creds are present are activated.

### 3. Sending is a `notify` tool — and it is `irreversible`

`notifyTool(channels)` exposes sending to skills/agents. Its effect is **`irreversible`**
(ADR-0004) — an external message can't be unsent — so it is **lease-gated**: a worker that
lost its lease won't fire duplicate alerts. This is the effect taxonomy paying off: comms are
correctly treated as the dangerous, gated class. The tool fans out to all configured channels
and reports how many succeeded (best-effort; one channel failing doesn't sink the rest).

### 4. CLI + wiring

- `weave notify "<text>" [--title T] [--to slack,telegram,email]` (creds via flags or env).
- `notify` registered at composition so any skill can send (e.g. an alerting skill, or the
  arXiv agent announcing new papers).
- `weave watch --notify <channels>` sends on drift/violation.

## Consequences

**Positive**
- Outbound comms are a clean port; new transports (Discord, PagerDuty, SMS) are new adapters.
- HTTP-only keeps the single binary native-dep-free; injectable sender makes it testable
  without network or creds.
- `irreversible` + lease gate gives correct dedup semantics for alerts under failover.

**Negative / risks**
- Email is HTTP-API only (provider-specific); raw SMTP deferred.
- Channels hold secrets (webhook URLs, tokens) — loaded only at composition from env/flags,
  never committed; never logged. A per-channel rate-limit/dedup beyond the lease gate is a
  follow-up (avoid alert storms on flapping targets).
- Best-effort fan-out can partially deliver; reported in the result, not retried (yet).

## Alternatives considered

- **A single generic webhook only.** Covers Slack but not Telegram's API shape or email;
  per-transport adapters are clearer and still tiny.
- **Raw SMTP for email.** More "real" but needs a library/native bits and complicates the
  binary; HTTP email APIs are the pragmatic first cut.
- **Make `notify` reversible/read.** Wrong — external messages are irreversible; mis-tagging
  would bypass the lease gate and risk duplicate alerts.

## Follow-ups

- Raw SMTP email adapter; Discord/PagerDuty/SMS adapters.
- Per-target alert rate-limit/dedup (flap suppression).
- An alerting skill that watches drift/violations and notifies, composing with ADR-0007/0013.
