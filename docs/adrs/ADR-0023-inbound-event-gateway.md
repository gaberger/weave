# ADR-0023: Inbound event gateway (reactive triggers)

- **Status:** Accepted
- **Implementation:** Complete — adapters/primary/http-gateway.ts, `weave serve` (cli.ts)
- **Date:** 2026-06-27
- **Deciders:** project owner

## Context

weave declares work two ways today: the **CLI** (`weave task`, on demand) and **loops** (ADR-0008,
on a time schedule). Both are *outbound-initiated* — weave decides when to act. For an autonomous
agent that acts *on your behalf*, the missing half is **reacting to the world**: a GitHub webhook, an
inbound message, a CI failure, any external system that wants to wake the agent. Until now there was
no inbound surface at all — by design (no listener = nothing to attack/secure). MCP (ADR-0003 §6
extension) gave agents the ability to *act on* services (outbound integrations); this ADR gives the
world the ability to *trigger* the agent (inbound integrations).

## Decision

Add a **primary (driving) adapter**: a minimal HTTP gateway, started by `weave serve`, that turns an
inbound `POST` into a `task.declared` on the substrate — the same use-case the CLI drives. A running
`weave up` peer then claims and runs it as usual. The gateway is the bridge from "external event" to
"weave task"; everything downstream (claiming, skills, MCP, notify) is unchanged.

```
external event ──POST──▶ weave serve ──declareTask──▶ weave ──claim──▶ peer ──act (MCP)──▶ notify
```

Properties:

- **Dependency-inverted, hex-clean.** The adapter imports only `node:http` and takes an injected
  `onEvent` callback (no use-case or substrate import — adapters may import only domain + ports under
  the strict gate, ADR-0015). Composition (cli.ts) wires `declareTask` into `onEvent`.
- **Bounded by default.** Binds `127.0.0.1` unless `--host` is given; an optional shared secret
  (`--secret` / `WEAVE_GATEWAY_SECRET`, checked against the `X-Weave-Secret` header) gates declaration;
  request bodies are size-capped. A `GET` health route never declares.
- **No new dependencies.** `node:http` only — consistent with weave's dependency-light ethos.
- **Maps event → goal** simply: a JSON body's `goal`/`skill` fields, else the raw body as the goal;
  `--skill` pins routing. Richer mapping (per-route templates, HMAC signatures) is a later iteration.

## Consequences

- weave becomes **reactive**, not just scheduled/on-demand — the inbound half of "autonomous agent."
- It now has a network listener, so it carries the usual web-surface concerns: the localhost-default
  bind, the shared secret, and the body cap are the first-line mitigations; production exposure should
  sit behind a reverse proxy / real auth. The gateway declares work but holds **no execution
  authority** itself — a declared task still runs under a peer's grant ceiling (ADR-0004), so a rogue
  POST can at most enqueue a task the peers were already allowed to run.
- `serve` is opt-in and separate from `up`: you can run the gateway and the peers in different
  processes/hosts (it just appends to the shared substrate), keeping the listener and the workers
  independently scalable and restartable.

## Alternatives considered

- **Polling skills** (loop + `http_fetch`) — works today but laggy and burns quota; fine for "check
  every N", wrong for "react now."
- **Bake the listener into `up`** — couples the network surface to every worker process; keeping
  `serve` separate lets you run zero or many gateways independent of the peer fleet.
