# ADR-0011: Recurring network interrogation

- **Status:** Superseded by 0016
- **Date:** 2026-06-20
- **Deciders:** project owner
- **Tags:** interrogation, tools, scheduler, usecase
- **Depends on:** [ADR-0004](ADR-0004-toolhost-capability-model.md), [ADR-0005](ADR-0005-peer-loop-usecase.md)

## Context

The goal: have weave **interrogate networks on a loop** — a peer swarm that repeatedly
queries network targets and records findings. This maps cleanly onto the existing model
(peers, claim-once, durable log); the new parts are *how* a worker interrogates and *how*
the loop is driven.

## Decision

### 1. Interrogation is a `read`-effect ToolHost tool

A worker interrogates by calling a tool. Interrogation is **read-only**, so the tool's
effect is `read` (ADR-0004) — no lease gate needed, safe to run on any peer. The first
adapter is **`http_probe`**: an HTTP request to a target returning status, latency, and
health. This deliberately covers the Forward Networks REST API and most modern
controller/NOS REST endpoints — the broadest single entry point. SSH/CLI, SNMP, and
ping/traceroute are **sibling tool adapters** added later behind the same shape; the
`ProbeWorker` and loop don't change when they arrive.

### 2. A deterministic `ProbeWorker` (no LLM in the hot loop)

Interrogation is mechanical, so the default worker is deterministic: read the target +
expectations from the task spec, call `http_probe`, evaluate assertions, and return a
finding. (A Claude worker that *reasons* over findings is a separate, optional layer — you
don't want an LLM call per probe tick.) Task semantics:

- The **task completes** whenever the interrogation ran (we successfully interrogated).
- The **finding** (healthy / assertion-violated / unreachable) is recorded in the
  `task.completed` payload + an artifact — so the durable log becomes a **time series of
  findings**. `failed` is reserved for the interrogation itself erroring.

### 3. The loop = a scheduler that re-declares interrogation tasks

`weave watch <target…> --interval <dur>` opens the substrate, runs a peer whose worker is
`ProbeWorker`, and **re-declares a probe task per target every interval**. Peers claim and
run them, so:

- interrogation **scales across a swarm** (start more `watch`/`up` peers → more throughput),
- it's **durable** (the SQLite log persists every sweep's findings across restarts),
- each tick is a distinct task id (claim-once per tick); the target is in the payload so
  findings can be grouped/diffed by target.

Interval first; **continuous** and **cron** cadences are config variants of the same
scheduler. `--once` runs a single sweep.

### 4. Outputs: record + assert now, drift next

- **Record:** every finding lands in the durable log (done by §2).
- **Assert:** `--expect <status>` flags violations in the finding.
- **Drift:** diffing a finding against the same target's previous finding needs history
  access; it's the immediate follow-up (a small projection over the log, like
  `currentHolder`), not in this MVP.

## Consequences

**Positive**
- Reuses the whole proven core (peers, claim-once, durable log, ports) — interrogation is
  just a `read` tool + a deterministic worker + a re-declare timer.
- Read-only ⇒ no lease-gate complexity; safe to fan out widely.
- The log is automatically a queryable history of network state over time.

**Negative / risks**
- **Network egress is a capability.** `http_probe` can hit arbitrary URLs (SSRF-ish);
  acceptable because it's an explicitly granted, read-only interrogation tool, but a real
  deployment should constrain targets via the grant/allowlist.
- **Live-device protocols (SSH/SNMP) need creds + libraries** and are not in this MVP;
  they're future tool adapters.
- **Unbounded finding history** — the log grows per tick; compaction ties to the future
  `Memory` port. Fine at demo/early scale.

## Alternatives considered

- **An LLM worker per probe.** Rejected as default — slow and costly per tick; reserved
  as an optional analysis layer over recorded findings.
- **A bespoke poller outside weave.** Rejected — loses claim-once, durability, swarm
  scaling, and the unified audit log we get by modelling interrogation as weave tasks.
- **One long-lived task that loops internally.** Rejected — breaks claim-once/lease
  semantics and crash recovery; re-declaring discrete tasks keeps each tick durable and
  reclaimable.

## Follow-ups

- **Drift** projection + `weave findings`/alert view.
- SSH/SNMP/ping tool adapters; per-target grant allowlists.
- Optional Claude analysis layer over recorded findings.
- `continuous` / `cron` cadences.
