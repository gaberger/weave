# ADR-0018: Container sandbox — OS-level confinement behind the Worker port

- **Status:** Accepted
- **Implementation:** Complete — docker-skill-runner.ts, docker-skill-runner.test.ts, Dockerfile _(self-evaluated 2026-06-26 via weave)_
- **Date:** 2026-06-21
- **Deciders:** project owner
- **Tags:** sandbox, security, capability, isolation, docker
- **Depends on:** [ADR-0003](ADR-0003-worker-port-and-claude-sdk-adapter.md), [ADR-0004](ADR-0004-toolhost-capability-model.md), [ADR-0017](ADR-0017-self-authored-skills-and-sandbox.md)

## Context

ADR-0017 sandboxed self-authored code skills with `worker_threads`, but was explicit that a
thread is **not** a security boundary: it shares process privileges and can touch the
filesystem and network directly. The thread only confined *tool access* (via RPC). For
genuinely untrusted authored code we need OS-level confinement, and ADR-0017 §4 promised it
would arrive as a drop-in adapter behind the same `Worker` port. This ADR delivers the first
such tier: a Docker container.

## Decision

### 1. `DockerSkillRunner` — a `Worker`-port adapter

`docker-skill-runner.ts` runs a code skill in a `docker run` container and implements the
`Worker` port, so selecting worker_threads ↔ Docker is a composition wiring (`newWorker`), not
a use-case change. The RPC pattern from ADR-0017 is reused verbatim — only the **transport**
changes (a thread `MessagePort` → the container's stdio, JSON lines) and the **spawn/kill**
(thread → `docker run`/`docker rm -f`). The drive loop (tool→invoke→reply, progress, done,
timeout, abort) is kept self-contained in the adapter rather than shared with the thread runner,
because the hex rule forbids adapters importing adapters (ADR-0015 strict mode); the small
duplication is the sanctioned cost of independent adapter leaves.

### 2. Confinement flags make the grant a real capability boundary

The container runs `--network none --read-only --cap-drop ALL --security-opt no-new-privileges
--pids-limit --memory --cpus --tmpfs /tmp`. With no network and a read-only rootfs, the
container's **only** I/O path is the stdio RPC back to the parent, which invokes tools on the
caller's grant-filtered `ToolHost`. So authored code cannot reach fs/net except by asking for a
tool it is granted (ADR-0004) — the OS removes ambient authority, the RPC channel re-grants
exactly what the grant allows. This is the property worker_threads could not provide.

### 3. The image holds only the executor; the skill is mounted read-only

`sandbox/Dockerfile` bakes `sandbox/docker-skill-entry.mjs` (plain ESM — the container has no
tsx) and nothing else. The skill file is bind-mounted read-only at run time
(`-v <skill>:/skill/s.mjs:ro`), never baked in, so the image is reusable and the skill is
untrusted data. The entry builds the same tool shim and reports `done`/`error`/`progress`/`tool`
lines.

### 4. The spawn is injectable; the live test is opt-in

The runner takes an optional `spawnProcess`, so the parent-drive logic (grant-gated tool RPC,
timeout-kill) is unit-tested with a fake child and **no Docker**. A `LIVE` test
(`WEAVE_DOCKER_SANDBOX=1`) builds the image and asserts a skill that tries `fetch()` directly is
blocked by `--network none` yet can still call a granted parent tool over RPC — proving §2 end
to end. Default `npm test` stays green everywhere (the live test skips, like the LLM live tests).

## Consequences

**Positive**
- Real OS-level confinement for self-authored code, swapped in by composition with no use-case
  change — the hex bet from ADR-0017 §4 realized.
- The grant/effect model (ADR-0004) now bounds *all* authored-code authority, not just tool
  selection: net/fs are physically unavailable inside the sandbox.
- Image is reusable and skill-agnostic; skills are untrusted read-only inputs.

**Negative / risks**
- **Shared host kernel.** Docker is a strong boundary for untrusted-but-not-adversarial code,
  but a kernel exploit / container escape defeats it. For adversarial code, the next tiers —
  gVisor (`runsc`) or a Firecracker microVM (separate guest kernel) — are the same `Worker`-port
  swap (follow-up).
- **Cold start** ~0.3–1 s/skill. Mitigate with a warm container pool or move to Firecracker
  (~125 ms) when throughput matters.
- **Docker dependency** for this tier; not available in every environment, hence the opt-in test
  and the worker_threads tier remaining for keyless/dev runs.
- The RPC channel is the one trusted edge — tool input validation must live in the parent (the
  grant gates *which* tools; per-tool schema checks gate the *args*).

## Alternatives considered

- **child_process + Linux namespaces (`unshare`).** No daemon, ~30 ms, but shares the kernel and
  is fiddlier to lock down than Docker's declarative flags. Kept as a possible lightweight tier.
- **gVisor / Firecracker first.** Stronger, but heavier setup (runsc install; KVM host + kernel/
  rootfs images). Docker is the pragmatic first real-confinement step; the stronger tiers are
  drop-in swaps when the threat model demands.
- **Share an RPC module between the thread and Docker runners.** Cleaner DRY, but violates the
  strict no-adapter→adapter rule; rejected in favour of independent adapters.

## Follow-ups

- gVisor and Firecracker runners behind the same port; a warm-pool wrapper to amortise start-up.
- Per-tool argument-schema validation at the parent boundary.
- Wire a composition preset: a "learning peer" whose code skills run via `DockerSkillRunner`
  while its declarative skills run on the LLM worker.
