# ADR-0016: weave is a domain-agnostic harness; use-cases are skills

- **Status:** Accepted
- **Date:** 2026-06-20
- **Deciders:** project owner
- **Tags:** architecture, harness, skills, foundational
- **Supersedes (domain parts of):** ADR-0011 (network interrogation), ADR-0013 (context reducer); reframes ADR-0008 (arXiv example)

## Context

The harness had grown domain-specific: network-interrogation (`http_probe`, `ProbeWorker`,
drift, `weave watch`/`summary`) and arXiv research (`arxiv` skills, an Atom parser) lived in
the *core*. That's the classic harness failure mode: baking business logic into the framework.
A harness should ship **capabilities** (generic tools) and a way to define use-cases
**loosely** — a prompt + a tool grant the LLM reasons over — not hardcoded `run()` workflows.

## Decision

### 1. The core is domain-agnostic

weave core = coordination (substrate, peers, claim/lease, compaction, loop) + the skill system
+ **generic tools** (`http_fetch`, `spawn_task`, `notify`) + the Claude worker. **No domain
logic.** Removed from core: `domain/interrogation`, `domain/arxiv`, `domain/context`,
`http-probe-tool`, `probe-worker`, `network-state-tool`, the arXiv skills/tools, and the
`watch`/`summary` CLI verbs.

### 2. Use-cases are skills — code OR declarative

A use-case is a `Skill` (ADR-0012), loaded from `.weave/skills/`:
- **Code skill** (`.js`/`.ts`): full control when you want determinism.
- **Declarative agent skill** (`.md`/`.json`): `name` + `description` + `match` keywords +
  `tools` allowlist + a **prompt** (the business logic). An LLM runs it over the granted tools
  — this is the "loosely-defined use-case" path (`makeAgentSkill` + `loadAgentSkills`).

The network monitor and the arXiv researcher now ship as **example declarative plugins**
(`examples/plugins/net-monitor.md`, `researcher.md`) — prompts + `http_fetch`/`notify`/
`spawn_task`, no harness code.

### 3. Per-skill tool grants

A declarative skill declares its `tools` allowlist; `restrictTools` exposes only those to the
agent, so a plugin can't reach beyond its grant (composes with ADR-0004 effects/lease gate).

## Consequences

**Positive**
- The harness is reusable for *any* domain; what it "does" is plugins, not forks.
- Compaction/snapshot became generic (settled subjects only; no findings); `currentHolder`/
  `isSettled` unchanged. `weave doctor` stays strict (58 files, down from 67).
- Adding a use-case is a file in `.weave/skills/` — the Pi/OpenClaw "drop-in" model, realized.

**Negative / risks**
- Declarative use-cases need an LLM (a key) and are non-deterministic / token-costly vs the
  old hardcoded pipelines; for determinism, write a code skill. Both are supported.
- The deterministic probe/arXiv pipelines (and their per-tick efficiency) are gone from core;
  re-create as code-skill plugins if needed.
- Prompt-driven routing (`match` keywords) is coarser than typed dispatch; explicit
  `--skill <name>` is the escape hatch.

## Alternatives considered

- **Keep domain features in core, behind flags.** Rejected — that's the anti-pattern; the
  harness stays domain-specific and bloats per use-case.
- **Only code skills.** Loses the "loosely-defined, no-code" use-case the plugin model is for.

## Follow-ups

- A small set of curated example plugins (research, monitor, triage) under `examples/plugins/`.
- Optional: a deterministic `http`/scrape code-skill template for users who want pipelines.

## Amendment (2026-06-26): the three-ring model + Forward isolation

Restating the decision concretely after the engine/workspace split. weave is **three rings**, and
the domain coupling lives strictly in the outer two:

```
RING 1 — Foundational core (generic, domain-FREE)
  src/domain · src/ports · src/usecases · substrate
  peers, lease-claim, compaction, knowledge graph. Runs ANY use-case.
RING 2 — Adaptation layer (skills + persona; where a domain lives)
  skills/forward-*  (vendored NetOps pack → Forward Networks API)
  skills/netops/    (persona.md, voice-summary.md — grounding doctrine as DATA)
  loaded only under --netops / --persona netops; CLAUDE_PLUGIN_ROOT → engine root
RING 3 — Workspace (per-network data; the weave home)
  ~/.weave/networks/<id>/ : weave.db · reports · memory · nqe · remediations
```

**The core is provably Forward-free.** The only `forward` token in `src/domain` is graph
*forward-edges*; the only real coupling baked into engine code was the NetOps persona prompt in
`composition/builtin-skills.ts`. That doctrine is now **pack data**; `builtin-skills.ts` ships only
the generic `echo`, `claude`, and `personaAgentSkill` machinery plus a domain-neutral voice prompt.

**Packs make the coupling declarative, not hardcoded.** A *pack* is a directory `skills/<name>/`
whose `persona.md` frontmatter *declares* what the generic engine should apply when it is selected
(`--persona <name>`):

| Frontmatter key | Engine applies it as |
|---|---|
| `bundles: [globs]` | which vendored `skills/*` to load (name-glob filtered) |
| `tools: [Bash]` | capability grants for the pack's agent (effect-gated, ADR-0004) |
| `serveForVoice` | embed a peer under `weave voice` |
| `voiceSummary` | TTS-summary prompt override |
| body | the agent's grounding system prompt |

`loadPack()` (`composition/pack.ts`) parses it; `selectedPack(args)` is the single resolver. The
engine no longer contains the literal `"netops"` except in **one** back-compat line mapping the
legacy `--netops` flag / `WEAVE_NETOPS` to `--persona netops`. No special-cases for Bash grants,
skill loading, voice-serve, or persona resolution remain.

Consequence: **a new domain = a new `skills/<name>/persona.md`** — no engine recompile, no edit to
Ring 1. NetOps is "inherently coupled to Forward" only as a *property of the shipped pack*, not of
weave.

Related: the workspace/home model (`~/.weave`, `weave networks`, the engine-repo guard) keeps Ring 3
out of the engine repo so a worker's file tools can never reach framework source.
