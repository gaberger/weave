---
name: forward-report-doc
description: Render a structured investigation as a narrative report — insight-led network review, incident report, change ticket, compliance audit, drift report, or action plan. Output is Markdown or styled standalone HTML. Use when the user asks "write up this investigation", "give me a report", "draft a change ticket", "compliance writeup", "post-incident report", "drift report between snapshots". Not for raw tabular data (use forward-report-table) or diagrams (use forward-report-graph).
allowed-tools: Bash(python3 *), Read
---

# Forward Report Doc

> **Read first:** `${CLAUDE_PLUGIN_ROOT}/shared/expertise/forward-as-backend.md` — the foundational framing. Renderer, not substrate query. The brain composes the document JSON from prior skill output; this skill renders it.

## Operate as a network engineer

This is the **terminal stage** for an investigation that needs a shareable narrative — change tickets, audit submissions, post-incident reports, drift writeups. Reach for it after the data skills + table/graph renderers have produced the evidence; this skill *frames* that evidence into a document with the right structure for its destination.

- For multi-step investigations, read `${CLAUDE_PLUGIN_ROOT}/shared/expertise/investigation-workflows.md` first to plan the chain. The doc skill consumes investigation artifacts (configs, path traces, compliance results, diffs) and emits the writeup.
- For interpreting the technical content (vendor syntax, routing protocols, security baselines), the rendered text quality benefits from `${CLAUDE_PLUGIN_ROOT}/shared/expertise/config-syntax.md`.

---

## Invocation

Run from the user's cwd. Do not narrate which script you're about to run.

```bash
# Markdown for a GitHub PR
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-report-doc/scripts/render.py" \
    --template incident-report --format markdown --output postmortem.md <<EOF
{ ...document JSON... }
EOF

# Styled standalone HTML — open in browser, Cmd-P for PDF
cat investigation.json | python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-report-doc/scripts/render.py" \
    --template change-ticket --format html --output change.html

# List all templates and their default section ordering
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-report-doc/scripts/render.py" --list-templates

# Scaffold a new network-review with placeholder headers for missing sections
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-report-doc/scripts/render.py" \
    --template network-review --scaffold --format markdown --output draft.md <<EOF
{ ...partial document JSON... }
EOF
```

## Output format

Never paste raw JSON. Lead with a verdict, not a dump.

### `render.py`

```markdown
Report written to <output-file> — <N> sections, format: <markdown|html>.

If no output file was specified, the rendered content follows below.
```

If the input JSON has no sections or an empty `sections[]` array, say: "**No report sections provided.** Pass a document JSON with at least one section in `sections[]`."

To share or review the report, ask: "Open `review.html` in a browser" or "Post `postmortem.md` to the incident channel."

## When to use

- "Write up this investigation as an incident report"
- "Draft a change-management ticket for this BGP fix"
- "Compliance audit submission — STIG scan results we just ran"
- "Drift report comparing snap-1007 to snap-1008 across the edges"
- "Summary writeup for the security review meeting"

## When NOT to use

- Just the table → `forward-report-table`
- Just the diagram → `forward-report-graph`
- The user wants to see something live in the Forward web UI → `forward-ui`

## Scripts

| Script | Purpose |
|---|---|
| `render.py` | Render structured document JSON to Markdown or styled standalone HTML |

### render.py

Reads document JSON on stdin or from `--input <file>`, writes Markdown or HTML to stdout or `--output <file>`. Pure renderer — no network calls, no `.env` required.

```bash
# Render from file to HTML
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-report-doc/scripts/render.py" \
    --template network-review \
    --input "${CLAUDE_PLUGIN_ROOT}/skills/forward-report-doc/references/examples/EXAMPLE-network-review.json" \
    --format html --output review.html

# Render from file to Markdown
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-report-doc/scripts/render.py" \
    --template incident-report --format markdown --output postmortem.md \
    --input investigation.json

# Scaffold missing sections, list templates
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-report-doc/scripts/render.py" \
    --template change-ticket --scaffold --format markdown

python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-report-doc/scripts/render.py" --list-templates
```

Arguments:

| Flag | Required | Notes |
|---|---|---|
| `--format` | no | `markdown` (default) or `html` |
| `--template` | no | `incident-report`, `change-ticket`, `compliance-audit`, `network-review`, `action-plan`, `drift-report`, `generic` (default). Sets default section ordering. |
| `--title` | no | Override the report title from the input JSON |
| `--input` | no | Read document JSON from a file; defaults to stdin |
| `--output` | no | Write rendered output to a file; defaults to stdout |
| `--scaffold` | no | Emit placeholder section headers for template sections missing from the input JSON |
| `--list-templates` | no | Print available templates and their default section ordering, then exit |

## Gotchas

- **Mermaid blocks are not rendered in static HTML output.** They are emitted as `<pre class="mermaid">…</pre>` with a comment marker. For fully-rendered SVG diagrams, generate them via `forward-report-graph --format html` and embed by reference, or convert offline with `mmdc`.
- **`--scaffold` changes the output shape.** With `--scaffold`, the renderer emits placeholder headers (with comment hints) for any template section that is absent from the input JSON. Without it, missing sections are silently skipped. If the report looks incomplete, check whether `--scaffold` is the right mode.
- **The references catalog silently degrades if missing.** `render.py` loads `shared/expertise/references.md` at startup to resolve `{topic}`-keyed citations in `reference` and `insight` blocks. If the file is not found (e.g., outside the plugin directory), all topic-keyed reference URLs are dropped without error — citations become bare labels.
- **Templates prescribe section order, not content.** The template controls which sections appear and in what order; the content of each section is driven entirely by what is in the input `sections[]` array. A `network-review` template with no `Insights` key in the input will simply omit that section (or scaffold a placeholder if `--scaffold` is set).

## Shape

Reads JSON describing the report structure on stdin (or `--input <file>`), writes Markdown / HTML on stdout (or `--output <file>`). Pure renderer.

| Flag | Default | Effect |
|---|---|---|
| `--format` | `markdown` | One of `markdown`, `html` |
| `--template` | `generic` | One of `incident-report`, `change-ticket`, `compliance-audit`, `network-review`, `action-plan`, `drift-report`, `generic` |
| `--title` | *(from input)* | Override the report title |
| `--input` | stdin | Read JSON from a file |
| `--output` | stdout | Write to a file |
| `--scaffold` | off | Emit placeholder headers for template sections missing from input |
| `--list-templates` | off | Print available templates and exit |

## Input schema

The skill accepts a unified document object — Claude composes this from the data gathered earlier in the investigation. All sections are optional; missing ones are skipped:

```json
{
  "title": "BGP between core-1 and edge-3 won't come up",
  "summary": "Short one-paragraph TL;DR. What broke, what was the root cause, what was done.",
  "metadata": {
    "Author": "...", "Date": "2026-05-04", "Snapshot": "snap-1008", "Network": "DC-East", "Severity": "P2"
  },
  "sections": [
    { "title": "Timeline", "body": "Markdown prose..." },
    { "title": "Evidence",
      "blocks": [
        { "kind": "code", "lang": "cisco", "caption": "core-1 — router bgp stanza", "body": "router bgp 65001\\n neighbor 10.1.1.2 remote-as 65002" },
        { "kind": "table", "caption": "BGP peer state", "headers": ["device","peer","state"], "rows": [["core-1","10.1.1.2","Idle"]] },
        { "kind": "mermaid", "caption": "Path", "body": "flowchart LR\\n A --> B" },
        { "kind": "callout", "level": "warning", "body": "Peer-AS asymmetry confirmed." }
      ]
    },
    { "title": "Root cause", "body": "..." },
    { "title": "Remediation", "body": "...", "blocks": [ ] },
    { "title": "Validation", "body": "..." }
  ]
}
```

## Templates

Templates **don't** change the renderer — they prescribe a default section ordering and add boilerplate prompts (as comments) for sections the user typically wants to fill in. The doc structure stays driven by what's in `sections[]`.

| Template | Default section ordering | Use when |
|---|---|---|
| `network-review` (preferred for analysis) | Pattern · Insights · Themed gaps · Strengths to preserve · Action plan · Appendix | The user asks "review / explain / analyze X." Insight-led shape: name the pattern first, follow with numbered insights + citations, group findings by shared root cause, push audit-style detail to the appendix. |
| `action-plan` (project plan only) | Goal · Phases · Validation gate · Rollback summary | The user asks "give me a project plan / export the plan / just the remediation steps." Phase + action block kinds carry the work; no insights, no themed gaps, no appendix. Same source JSON shape as a `network-review` action plan, rendered standalone. |
| `incident-report` | Summary · Timeline · Impact · Root cause · Remediation · Validation · Lessons | Production incident postmortem |
| `change-ticket` | Summary · Pre-state · Proposed change · Predicted impact · Rollback plan · Approvals | CAB / change-management submission |
| `compliance-audit` | Scope · Methodology · Findings · Evidence · Remediation · Re-test plan | STIG / CIS / SOC2 submission |
| `drift-report` | Scope · Comparison axis · Findings · Per-device evidence · Recommended actions | Snapshot-to-snapshot or device-vs-template drift |
| `generic` | Whatever sections are passed | Anything that doesn't fit the others |

If a section listed in the template ordering isn't present in the input, the renderer either skips it (default) or emits a placeholder header with a comment hint when `--scaffold` is passed.

### Choosing the register

- **`network-review` (insight-led)** — *the default for analysis-shaped asks*. Lead with one paragraph that names the *pattern* (e.g. "policy layer is strong; control-plane hardening is weak — that asymmetry is the story"), follow with **numbered insights** (each a non-obvious observation backed by a citation), group findings into **themed gaps** that share a posture decision rather than listing them independently, end with **strengths to preserve** and a finding-detail **appendix**. This is what an experienced reviewer produces; the audit shape is what a checklist-bot produces.
- **Audit-shaped templates** (incident-report, change-ticket, compliance-audit, drift-report) — when the destination demands a specific structure (compliance submission, CAB ticket, postmortem doc).

## Block kinds

- `code` — fenced code block. `lang` becomes the code-fence language tag (cisco/junos/xml/json/etc.). `caption` rendered as a small italic line above the block.
- `table` — Markdown / HTML table. Pairs naturally with output from `forward-report-table`.
- `mermaid` — fenced as ```mermaid in Markdown; rendered inline in HTML if the env supports it (GitHub does; Confluence with mermaid-plugin does; static HTML output from this skill includes a comment marker for clients that lazy-render).
- `callout` — admonition box. Levels: `info`, `warning`, `danger`, `success`.
- `reference` — citation. `{topic}` resolves against `shared/expertise/references.md` (frozen catalog) for the canonical title+URL; or pass explicit `{title, url}` to override. Optional `{why}` adds a one-line note. Renders as `↳ Reference: [title](url) — why` in Markdown / a footnoted link in HTML / a dimmed `↳ ...` line in ANSI.
- `insight` — numbered claim with evidence and zero-or-more inline references. Schema: `{kind:"insight", n: 1, claim: "…", evidence: "…", references: [{topic:"…"}, ...]}`. Used inside the `Insights` section of `network-review`.
- `themed-gap` — group of findings that share a posture decision. Schema: `{kind:"themed-gap", theme:"…", "posture-decision":"the single underlying choice", gaps:[{name, defense}], references:[…]}`. Used inside the `Themed gaps` section of `network-review`.
- `phase` — section header for an action-plan phase. Schema: `{kind:"phase", id:"P1", name:"…", goal:"…", "gating-criteria":"…"}`.
- `action` — single action card with `{id, title, severity, closes, devices, prereq, window, rollback, time, config, lang, validate, references}`. Used when an investigation closes with a multi-step remediation plan.

## Worked example

`references/examples/EXAMPLE-network-review.json` is a complete `network-review` document JSON for a three-region BGP topology. Render it with:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-report-doc/scripts/render.py" \
    --template network-review \
    --input "${CLAUDE_PLUGIN_ROOT}/skills/forward-report-doc/references/examples/EXAMPLE-network-review.json" \
    --format html --output review.html
```

Use it as a shape template when composing your own — copy the structure (pattern paragraph, three numbered insights with `topic`-keyed references, one themed-gap card grouping four findings under a single posture decision, action plan with phases + per-action cards, appendix with cross-references to actions).

`references/examples/EXAMPLE-action-plan.json` is a standalone `action-plan` document:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-report-doc/scripts/render.py" \
    --template action-plan \
    --input "${CLAUDE_PLUGIN_ROOT}/skills/forward-report-doc/references/examples/EXAMPLE-action-plan.json" \
    --format markdown --output plan.md
```
