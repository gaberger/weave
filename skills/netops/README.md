# netops pack — grounding doctrine (Ring 2)

This directory is a **pack**: the domain grounding for weave's NetOps use-case, as data loaded at
runtime by the engine (`loadPack()` in `src/composition/pack.ts`) — **not** compiled into engine
code. The foundational core (Ring 1) stays domain-agnostic; see
[`ADR-0016`](../../docs/adrs/ADR-0016-domain-agnostic-harness.md).

- `persona.md` — the pack manifest **and** the grounding prompt. Its YAML frontmatter *declares*
  what the generic engine applies when this pack is selected (`--persona netops`); the body is the
  system prompt for the **Forward NetOps agent** (catch-all + conversational default).

  ```yaml
  name: netops
  description: Forward NetOps agent — operate the network via the forward-* skills.
  bundles: [*]            # skill-dir globs to load from the vendored skills/ root
  tools: [Bash]           # capability grants the agent needs (forward-* scripts run python3)
  serveForVoice: true     # embed a peer under `weave voice` so it's one command
  voiceSummary: voice-summary.md
  ```

- `voice-summary.md` — TTS-summary prompt used under this pack (NetOps-flavored). Without a pack the
  engine uses a generic, domain-neutral summarizer from `builtin-skills.ts`.

The engine knows no specific domain — "netops" is just this directory's name. To ground weave for a
**different** domain, add a sibling `skills/<name>/persona.md` with its own frontmatter and run
`--persona <name>`. No engine change. (`--netops` / `WEAVE_NETOPS=1` survive only as a back-compat
alias for `--persona netops`.)
