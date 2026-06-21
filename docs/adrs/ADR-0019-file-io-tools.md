# ADR-0019: File-I/O tools (read_file / edit_file) — the missing self-maintenance primitive

- **Status:** Accepted
- **Date:** 2026-06-21
- **Deciders:** project owner
- **Tags:** tools, capability, self-maintenance, skills
- **Depends on:** [ADR-0004](ADR-0004-toolhost-capability-model.md), [ADR-0012](ADR-0012-skill-plugin-system.md), [ADR-0016](ADR-0016-domain-agnostic-harness.md), [ADR-0017](ADR-0017-self-authored-skills-and-sandbox.md)

## Context

weave's generic tools were `http_fetch`, `spawn_task`, `notify`, and `write_skill` — and
`write_skill` writes **only** into the skills dir. So a skill could reach the network and
enqueue work but could not **read or edit a repo file**. That blocked an entire, obvious class
of self-maintenance use-cases the harness is otherwise built for: an ADR auditor reconciling
`docs/adrs/` with the code, a changelog updater, a doc-drift fixer. The `adr-auditor` skill
(ADR-0016-style declarative plugin) was authored but un-runnable because the tools it named did
not exist — the gap surfaced when the ADR-status audit had to be done by hand instead of by the
loop meant to do it.

## Decision

Two generic, root-confined tools (`fs-tools.ts`):

- **`read_file`** — effect `read`. Returns a UTF-8 file's content (size-capped), path resolved
  under a configured `root`; a path escaping `root` is refused (traversal guard).
- **`edit_file`** — effect `irreversible` (it mutates a tracked file), so the grant ceiling
  (ADR-0004) decides which peers may write. Literal `oldText → newText` replacement (`all?` for
  every occurrence); **fails with no write if `oldText` is absent**, so an edit is precise and a
  re-run after success is a clean miss, not a corruption.

Both are registered in the CLI composition scoped to `process.cwd()`; `write_skill` is now
registered there too (it was defined but unwired). A skill reaches them only if its grant
allowlists them and clears the effect ceiling — `read_file` needs `read`, `edit_file`/
`write_skill` need `irreversible`. The `adr-auditor` plugin's grant (`read_file, edit_file,
notify`) is now satisfiable, so `weave loop --skill adr-auditor --interval <dur>` runs the audit
weave authored this ADR set for.

## Consequences

**Positive**
- Self-maintenance use-cases (ADR audit, doc-drift, changelog) are now expressible as plain
  skills — no harness code, consistent with ADR-0016.
- The capability stays bounded by the existing model: file *reads* and file *writes* are
  separately gated by the effect ceiling, scoped to a root, no new trust machinery.
- Closes the dogfooding gap: the ADR auditor is a runnable weave loop, not a hand-run script.

**Negative / risks**
- `read_file` scoped to the repo root can read any tracked file (incl. secrets a repo
  shouldn't hold); tighten the `root` per peer/skill if that matters. `edit_file` can corrupt
  files if a skill is careless — mitigated by precise literal-match-or-fail semantics and the
  irreversible-grant gate, and recoverable via git.
- For *untrusted* self-authored code skills, `edit_file` should run inside the sandbox
  (ADR-0018) so writes are confined to mounted paths; declarative skills run in-process and are
  bounded only by the grant + root.

## Alternatives considered

- **A broad `exec`/shell tool.** Far larger attack surface; rejected — narrow read/edit tools
  cover the self-maintenance cases with a fraction of the risk.
- **Bake an ADR-status updater into the harness.** The ADR-0016 anti-pattern (domain logic in
  core). The capability is a generic tool; the policy is a skill.
- **Extend `write_skill` to write anywhere.** Conflates "author a plugin" with "edit a repo
  file" and loses the skills-dir scoping; two intent-specific tools are clearer.

## Follow-ups

- Per-skill `root` scoping (e.g. an auditor granted only `docs/`).
- ~~a `list_dir`/glob tool~~ → added as `grep` (root-confined regex scan, effect `read`), the
  enumeration primitive the ADR auditor needs to find `ADR-NNNN` citation danglers across code.
- Run `edit_file` through the container sandbox (ADR-0018) for untrusted code skills.
