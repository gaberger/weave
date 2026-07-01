# ADR-0025: Outbound event surface (live push + the blackboard)

- **Status:** Accepted
- **Implementation:** Complete (v1) — `adapters/primary/sse-surface.ts`, `adapters/primary/blackboard-page.ts`, `domain/twin.ts`, `usecases/publish-twin.ts`, `weave serve` + `weave twin` (cli.ts); tests in `sse-surface.test.ts`, `domain/twin.test.ts`, `usecases/publish-twin.test.ts` (mutation-checked)
- **Date:** 2026-07-01
- **Deciders:** project owner

> **v1 shipped (2026-07-01):** SSE surface on its own port (default 8788), served by `weave serve`
> alongside the inbound gateway. Routes: `GET /` (blackboard), `GET /events` (stream w/ `Last-Event-ID`/
> `?from` replay + `?secret`/header auth), `GET /health`. Injected `weave.subscribe` + the terminal's
> `logFilter`; read-only.
>
> **Live twin on the canvas (2026-07-01):** the blackboard now renders a spatial network view (the
> "hologram") from `twin.graph` events — a hand-rolled force-directed topology folded per view. The
> `{nodes,edges,title}` payload reuses the `forward-report-graph` shape, and `weave twin`
> (`domain/twin.ts` + `usecases/publish-twin.ts`) publishes one from a file/stdin, so a Forward path
> trace or topology pipes straight to the canvas: `forward-report-graph … | weave twin`. Verified live
> and with a headless-browser render (nodes/edges draw, status colours, offset replay to a late-joining
> browser).
>
> **The hologram talks (2026-07-01):** the blackboard now speaks and listens via the browser's Web
> Speech API — `speechSynthesis` announces task outcomes (the actual `summary`, gated to fresh events
> so a full-log replay isn't read aloud), and `SpeechRecognition` (🎤 click-to-talk) turns a spoken
> command into a task. Crucially, voice **input** POSTs the declare to the **gateway** (ADR-0023, the
> write path) — NOT to this surface, which stays read-only. That cross-origin POST (page on the stream
> port → gateway on its own port) is enabled by opt-in CORS on the gateway (`cors`, on only when the
> stream is), and the page discovers the gateway's coords from a read-only `GET /config`. So the safety
> invariant holds: the outbound surface still declares nothing and holds no authority; the microphone
> is just another client of the inbound gateway. Verified end-to-end in a headless browser (config load,
> cross-origin declare → 202, task flows back onto the canvas). Full suite green (263/263).
> **Deferred, as designed:** the WebSocket control channel (approve-from-canvas), token-delta streaming,
> a richer React/three.js canvas, and server-side realtime voice (OpenAI Realtime — the Phase-2 CLI bar).

## Context

weave's substrate already carries a live event stream — `Substrate.subscribe(from, handler)`
(`src/ports/substrate.ts:26`) delivers every sealed event to an in-process handler in HLC order
(ADR-0009). But that stream never leaves the process: every current consumer just formats it to the
terminal — `weave.subscribe(head+1, e => console.log(fmt(e)))` (`src/cli.ts:932`, and the same shape
at 482/1421/2975). The only network listener, the ADR-0023 gateway, is strictly **inbound**
(POST=declare, GET=health, else 404); it has no WebSocket upgrade, no SSE, no outbound push, and
serves no HTML. `package.json` carries zero UI/realtime dependencies.

The consequence, from the Jarvis gap analysis (`docs/jarvis-gap-analysis.md`): the three lowest-scoring
capabilities — **visual blackboard (5%)**, **realtime interactivity (15%)**, and **ambient presence
(14%)** — are all blocked by *the same missing primitive*: a stateful **outbound** channel that pushes
substrate events to connected observers. They are not three problems; they are one architectural fork.

ADR-0023 gave the world the ability to *trigger* the agent (inbound). This ADR is its deliberate
mirror: it gives the world the ability to *watch* the agent — the outbound half of a live, present
assistant. The "hologram display" the owner wants is, concretely, a browser subscribed to this
surface.

## Decision

Add a second **primary (driving) adapter**: an outbound event surface, started by `weave serve`
(alongside or instead of the inbound route), that bridges `subscribe()` to connected clients over
**Server-Sent Events (SSE)**. A companion static **blackboard** — a single self-contained HTML page —
connects to it and renders the live stream: the active task graph (fan-out/join already exists,
ADR-0008/0024), progress deltas, and current twin state.

```
weave substrate ──subscribe()──▶ weave serve (SSE) ──event stream──▶ browser blackboard (live canvas)
                                       ▲                                      │
                                       └───────────── replay from offset ─────┘
```

Properties (mirroring ADR-0023's discipline):

- **Dependency-inverted, hex-clean.** The adapter imports only `node:http` and takes an **injected
  `subscribe`-shaped callback** (no use-case or substrate import — adapters may import only domain +
  ports under the strict gate, ADR-0015). Composition (cli.ts) wires the real `weave.subscribe` in,
  exactly as it wires `declareTask` into the inbound gateway's `onEvent`.
- **SSE, not WebSocket, for v1.** The traffic is one-directional (server→browser); SSE is plain HTTP,
  auto-reconnects, and needs no new dependency (`node:http` + `text/event-stream`). WebSocket is
  reserved for a later iteration if the blackboard needs to *send* (e.g. approve a gate from the
  canvas). Inbound commands stay on the ADR-0023 POST path until then.
- **Replayable from an offset.** Clients pass `Last-Event-ID` / `?from=<offset>`; the surface calls
  `subscribe(from, …)` so a reconnecting or late-joining blackboard catches up deterministically from
  the log — no missed events, consistent with the substrate's C4 read/subscribe agreement.
- **Bounded by default, same as inbound.** Binds `127.0.0.1` unless `--host` is given; an optional
  shared secret (`--secret` / `WEAVE_GATEWAY_SECRET`, reusing ADR-0023's mechanism) gates connection;
  event payloads are filtered through the existing `keepLog`/`keep` predicate so the surface emits the
  same events the terminal already shows — no new data exposure path.
- **No new runtime dependencies.** `node:http` only for the server; the blackboard is a single static
  HTML/JS file (hand-rolled canvas, same spirit as `forward-report-graph`'s self-contained SVG-in-HTML)
  served by a `GET` route. Consistent with weave's dependency-light ethos. A richer React/three.js
  canvas is an explicit later iteration, not v1.
- **Read-only.** The surface **pushes** substrate events; it holds no execution authority and declares
  no work. A connected observer can watch everything the peers do but cannot cause anything — the
  inbound gateway (ADR-0023) remains the only way to declare, still under peer grant ceilings (ADR-0004).

## Consequences

- weave gains a **live outbound presence** — the keystone that unblocks the blackboard, realtime
  streaming, and ambient/multimodal surfaces at once (gap analysis Phase 1). One build, three
  dimensions moved.
- The token-delta granularity limit stays: the SDK worker forwards whole assistant text blocks via
  `onProgress` → `task.progress` (`claude-agent-sdk-worker.ts`), so the blackboard streams block-level,
  not token-level, until that is refined. Adequate for a live task-graph view; a separate concern from
  this surface.
- A second network listener means the ADR-0023 web-surface concerns apply again: localhost-default
  bind, shared secret, and payload filtering are the first-line mitigations; production exposure sits
  behind a reverse proxy / real auth. Because the surface is read-only and reuses the existing event
  filter, its blast radius is *disclosure*, not *action*.
- `serve` grows a second responsibility (inbound declare + outbound stream). They share the process but
  are independent routes; either can be disabled by flag, and the outbound surface can run on a host
  separate from the peers (it only needs read access to the shared substrate), keeping the viewer and
  the workers independently scalable — same separation ADR-0023 established for `serve` vs `up`.
- Opens the door to the realtime-voice loop (gap analysis Phase 2): a full-duplex voice client and the
  blackboard become two clients of the same outbound surface rather than two bespoke pipelines.

## Alternatives considered

- **WebSocket from day one** — needed only when the canvas must send commands back; adds a dependency
  or a hand-rolled upgrade handshake for a v1 that is purely server→browser. Deferred, not rejected:
  the SSE surface and a later WS control channel coexist cleanly.
- **Poll a `weave report --json` endpoint from the browser** — reuses existing machinery but is laggy,
  bursty, and loses ordering; wrong for a "live hologram," the same reason ADR-0023 rejected polling
  for inbound triggers.
- **Tail the substrate file directly from a separate viewer process** — bypasses weave entirely, but
  re-implements offset/replay/filter logic outside the ports and breaks hex discipline (a viewer
  reaching into storage). The injected-`subscribe` adapter keeps the surface inside the architecture.
- **Push into an existing notification channel (ADR-0014, Slack/Telegram)** — those are fire-and-forget
  *summaries*, not a live spatial stream; complementary (alerting), not a substitute for the canvas.
