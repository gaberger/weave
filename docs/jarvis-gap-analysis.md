# Gap Analysis — weave vs. a "Jarvis-class" AI assistant

> **Method.** An adversarial team (8 skeptics, one per capability dimension) read the repo and ADRs
> and scored current maturity with file/line evidence; a red-team pass then adversarially re-verified
> each score. Critique + RedTeam completed; this document is the **Synthesis** phase (consolidated
> gaps + phased roadmap), reconstructed from the recovered workflow `wf_a025264e` after the original
> session was interrupted.
>
> **Target (owner's words).** A Jarvis-from-Iron-Man assistant that (1) talks conversationally to the
> network **digital twin** (Forward Networks) and acts on it, (2) runs autonomous **research jobs**,
> (3) has a live spatial **visual blackboard** ("hologram display"), and (4) a low-latency **voice
> assistant** (barge-in, persona, streaming STT/TTS).

## Scorecard

Maturity = how far toward the Jarvis bar, not how good the engineering is (the plumbing is
consistently above research-grade; the gap is product surface + autonomy, not code quality).

| Dimension | Maturity | Red-team verdict |
|---|---|---|
| Digital-twin interaction | **40%** | critique only (not re-verified) |
| Voice assistant | **28%** | ✅ verified about-right |
| Trust / safety / agency | **27%** | critique only (not re-verified) |
| Proactive autonomy | **17%** | ✅ verified about-right |
| Realtime interactivity | **15%** | critique only (not re-verified) |
| Multimodal / ambient | **14%** | ✅ verified about-right |
| Memory / personalization | **13%** | ✅ verified about-right |
| Visual blackboard | **5%** | ✅ verified about-right |

**Headline:** weave is a strong *autonomous batch-research + network-twin engine* with a competent
local voice prototype. It is furthest from Jarvis on the two things that make Jarvis *feel* like
Jarvis: a **live visual surface** (5%) and **realtime, low-latency interaction** (15%). The engine is
built around a claim/lease *job substrate* — excellent for durable fan-out, structurally at odds with
sub-second conversational presence.

## The three load-bearing gaps

Everything else is downstream of these.

### 1. No live outbound surface → no blackboard, no realtime, no ambient presence
The only server is `src/adapters/primary/http-gateway.ts` — strictly **inbound** (POST=declare-task,
GET=health, else 404/405). No WebSocket, no SSE, no outbound push, serves no HTML. `package.json` has
zero UI/realtime deps. The substrate's `subscribe()` primitive exists but today only `console.log`s
events to the terminal (`src/cli.ts:932`). **This single missing capability — a stateful outbound
push channel — blocks the blackboard, realtime streaming, and ambient presence simultaneously.** It
is the highest-leverage thing to build.

### 2. Every trigger is externally supplied → no genuine autonomy
Work runs three ways (on-demand `task`, timer `loop`, inbound `serve`) but every trigger comes from a
human or external system. `LoopRunner` (`src/usecases/loop.ts`) is stateless: it re-declares the same
static goal each interval with no memory of prior ticks, no diffing, no adaptation. There is no
durable "standing goal" abstraction — `src/domain/task.ts` has no `schedule.declared` kind, and
ADR-0008 explicitly lists persisted loop definitions as *unshipped*. **Nothing in weave ever decides
on its own that something is worth doing.**

### 3. Memory is task-result memory, not user memory
Three real memory layers exist (log-compaction snapshots, the OKF knowledge graph, hybrid BM25+
embedding `recall`) — but the knowledge graph's only node types are `report | source | artifact`
(`knowledge-graph.ts:8`). There is **no identity model, no preference store, no episodic memory of
interactions**. Tellingly, `learning.question.asked/.resolved` events *are* emitted (`cli.ts:1980,
2031`) but a full grep finds **zero consumers** — the personalization signal is captured and
dead-ended. Chat injects only the last ~4 in-RAM turns; `recall` targets task output, never the user.

## Per-dimension notes

- **Digital-twin (40%, strongest).** ~20 typed `forward-*` skills spanning read (path-analysis, nqe,
  device-intel/config, inventory, security-posture, CVE, STIG) and act (predict/changeset what-if,
  ssh-provision, playbook remediation w/ approval gate). Conversational via `buildChatGoal` (last 4
  turns + network context), explicit snapshot-freshness handling, verified live on network 212984.
  *Gap to Jarvis:* interaction is turn-based text/voice, not a spatially-explorable live twin.
- **Voice (28%).** Real dispatched `weave voice`: whisper.cpp STT, `silencedetect` VAD, streaming
  `say` TTS, fuzzy wake-word, half-duplex barge-in, destructive-verb confirm gate, model tiering.
  *Gaps:* macOS-only (hard exit off-darwin), half-duplex w/ no echo cancellation, robotic default
  voice, no realtime-audio ADR, Channel port is outbound-only. This is a good *local prototype*, not
  the OpenAI-Realtime / `gpt-4o-realtime` streaming pipeline the owner described.
- **Trust/safety/agency (27%).** Well-designed *authorization skeleton*: effect taxonomy
  (read/reversible/irreversible, fail-closed), lease-gated irreversible tools, per-worker grants +
  maxEffect ceiling, dry-run-by-default write tools (`execute:true` to mutate), argv flag-smuggling/
  ProxyCommand fix, Docker sandbox (`--network none --read-only --cap-drop ALL`). *Gap:* it's
  authorization, not *trust* — no learned autonomy envelope, no "you may do X unattended" model.
- **Proactive autonomy (17%).** See gap #2.
- **Realtime (15%).** Every turn — even voice — round-trips the claim/lease job substrate: declare
  task → peer polls (50ms) → claim/lease/backoff → subprocess → settle. Streaming is coarse (whole
  text blocks via `onProgress`, not token deltas). Structurally batch, not conversational.
- **Multimodal/ambient (14%).** Exactly one non-text modality (voice), foreground REPL, one machine.
  No vision/image input anywhere, no canvas, no always-on presence.
- **Memory (13%).** See gap #3.
- **Blackboard (5%).** See gap #1. `forward-report-graph` (static SVG-in-HTML you open manually) and
  `forward-ui` (screenshots Forward's *own* product) are not a live weave-owned surface.

## Phased roadmap toward Jarvis

Ordered by leverage. Each phase is independently shippable and dogfoodable.

### Phase 1 — Give weave an outbound surface (unblocks 3 dimensions) — ✅ v1 SHIPPED 2026-07-01
The keystone. Add a stateful server that pushes. **Done (ADR-0025):**
- Added an SSE surface (`adapters/primary/sse-surface.ts`) served by `weave serve`; wired the existing
  `subscribe()` primitive to fan events out over `text/event-stream` instead of only `console.log`.
  Replayable from an offset (`Last-Event-ID`/`?from`), secret-gated, read-only, hex-clean.
- Shipped a minimal **web blackboard** (`blackboard-page.ts`): a live canvas rendering the event feed
  and the derived task grid (state folded per subject). The first "hologram." Verified live +
  mutation-proven tests; full suite green.
- **Live twin on the canvas (2026-07-01):** the blackboard now renders a force-directed network
  topology from `twin.graph` events (the `forward-report-graph` `{nodes,edges}` shape). `weave twin`
  publishes one from a file/stdin, so a Forward path trace or topology pipes straight to the hologram
  (`forward-report-graph … | weave twin`). Headless-browser render verified.
- *Next within this phase:* token-delta (not block) streaming; a WebSocket control channel so the
  canvas can act (approve a gate); auto-publish twin views from path-analysis runs.
- *Outcome (v1):* blackboard 5→~30%, realtime 15→~25%, multimodal 14→~20% — one build, three moved.

### Phase 2 — Realtime voice loop
- Introduce a realtime-audio path that bypasses the job substrate for conversational turns (OpenAI
  Realtime / `gpt-4o-realtime`, or streaming `gpt-4o-transcribe` STT). Keep the substrate for the
  *work*, not the *conversation*.
- Full-duplex w/ echo cancellation; token-delta streaming to TTS and to the blackboard; make it
  cross-platform (lift the macOS-only guard) or explicitly scope it.
- *Outcome:* voice 28→~55%, realtime →~50%.

### Phase 3 — Genuine autonomy
- Add a durable **standing-goal** abstraction (`schedule.declared` task kind; survives restart,
  claimed by the swarm — the unshipped ADR-0008 follow-up).
- Make `LoopRunner` stateful: recall prior ticks via the OKF graph, diff twin state, and *decide*
  whether to act. Wire twin drift/intent-check failures as autonomous triggers.
- *Outcome:* autonomy 17→~40%.

### Phase 4 — User memory & trust envelope
- Extend the knowledge graph with `user | preference | interaction` node types; add an episodic
  store. **Wire up the already-emitted `learning.question.*` events** — the cheapest win on the board.
- Inject `recall` of user memory into `buildChatGoal`.
- Layer a *trust* model over the authorization skeleton: a learned/declared autonomy envelope
  ("act unattended within these bounds").
- *Outcome:* memory 13→~40%, trust 27→~45%.

### Phase 5 — Twin as explorable space
- Feed live twin data into the blackboard as a navigable topology (path traces, security matrix,
  CVE/STIG overlays rendered spatially and updated live), closing the loop from "typed tool that
  returns JSON" to "hologram you point at and ask about."

---

*Provenance: recovered from adversarial workflow `wf_a025264e-daa`, session
`cd2f0f47-9136-4baa-a9f7-ab3cc133f921` (orphaned in a deleted worktree). Critique + RedTeam phases
completed with per-claim file/line verification; 5 of 8 scores were adversarially re-verified as
"about-right" before the run was interrupted. Scores for digital-twin, trust, and realtime are
critique-only (not re-verified).*
