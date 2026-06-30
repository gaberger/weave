---
name: forward-report-table
description: Render network data as tables — ANSI-color terminal tables, GitHub-flavored Markdown, standalone HTML (sortable), or CSV. Use when the user asks "show me a table of …", "format this as a grid", "render the security matrix", "color-code the violations", "give me a Markdown table I can paste", "export to CSV". Reads JSON on stdin and emits the chosen format on stdout. Not for graph/topology rendering (use forward-report-graph) or narrative reports (use forward-report-doc).
allowed-tools: Bash(python3 *), Read
---

# Forward Report Table

> **Read first:** `${CLAUDE_PLUGIN_ROOT}/shared/expertise/forward-as-backend.md` — the foundational framing. This is a *renderer*, not a substrate query — it consumes the JSON returned by the data skills. Forward provides the data; the brain (you) decides the shape and format.

## Operate as a network engineer

This is a **terminal-stage** skill — it renders artifacts from the data the other Forward skills already gathered. The investigation chain (`investigation-workflows.md`) typically ends here when the user wants something to paste into a PR, runbook, ticket, or audit submission.

- For multi-step investigations, read `${CLAUDE_PLUGIN_ROOT}/shared/expertise/investigation-workflows.md` first to plan the chain. Reach for this skill at the *render* step, after the data skills have run.

---

## Invocation

Run from the user's cwd. Do not narrate which script you're about to run.

The skill is a pure renderer — chain it after a data skill via shell pipe:

```bash
# STIG scan → grouped colored table
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-compliance-check/scripts/stig_sweep.py" \
    --network-id <id> --vendor cisco | \
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-report-table/scripts/render.py" \
    --template stig --group-by severity --sort device

# Device list as Markdown for a runbook
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-inventory/scripts/list_devices.py" \
    --network-id <id> | \
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-report-table/scripts/render.py" \
    --template device-list --format markdown --sort name

# Security matrix as a self-contained sortable HTML page
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-security-posture/scripts/get_matrix.py" \
    --network-id <id> --snapshot-id <id> | \
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-report-table/scripts/render.py" \
    --template security-matrix --format html --output matrix.html

# Generic table from arbitrary NQE results, columns hand-picked
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/run_query.py" \
    --network-id <id> --snapshot-id <id> --query-id <q> | \
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-report-table/scripts/render.py" \
    --columns device,interface,status,description --sort device --format markdown
```

When the user pastes JSON directly:

```bash
echo '<json>' | python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-report-table/scripts/render.py" --template generic
```

## Output format

Never paste raw JSON. Lead with a verdict, not a dump.

### render.py

Present the rendered output inline. For terminal/markdown output, cap display at ~20 rows; if the table exceeds that, note: `(showing 20 of <N> rows; use --sort or --group-by to prioritize)`

If the input JSON array is empty, emit: `No rows to display.`

Format-specific presentation guidance:
- **ANSI** — present color output directly in the terminal response.
- **Markdown** — paste the fenced table verbatim.
- **HTML** — note the output file path; offer to show a preview.
- **CSV** — state the row count and offer to display the first few rows.
- **JSON** — the machine contract, not for pasting. Emits the standard envelope on stdout: `{"ok":true,"schema":1,"data":<rows>,"meta":{"count","columns","template"}}`. For `security-matrix` `data` is `{"zones","cells"}`; for `diff` `data` is the diff rows and `meta` carries `left`/`right`. Errors emit `{"ok":false,"schema":1,"error":{"code","message","hint?"}}` (code `INPUT` for malformed/empty/unreadable input). The `--output` flag is not applied to `json` — the envelope always goes to stdout.

To export as a self-contained sortable HTML page, ask: "Render this as sortable HTML and save to report.html."

## When to use

- "Show me a table of devices in the network"
- "Render the STIG results, group by severity, sort by device"
- "Give me the security matrix as a colored grid"
- "Markdown table of the BGP peers"
- "Side-by-side diff of these two configs in HTML"
- "Export the path-analysis results as CSV"

## When NOT to use

- Topology / path / BGP-mesh diagrams → `forward-report-graph`
- Narrative writeups (incident reports, change tickets, audit docs) → `forward-report-doc`
- Live screenshot from the Forward web UI → `forward-ui`
- Fetching the data itself → `forward-inventory` / `forward-nqe-query` / etc.

## Scripts

| Script | Purpose |
|---|---|
| `render.py` | Render JSON network data as ANSI, Markdown, HTML, or CSV tables |

### render.py

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-report-table/scripts/render.py" \
    --template stig --format markdown --sort device --group-by severity

python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-report-table/scripts/render.py" \
    --template generic --columns device,status --format html --output out.html

python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-report-table/scripts/render.py" \
    --list-templates
```

| Flag | Required | Notes |
|---|---|---|
| `--format` | no | One of `ansi` (default), `markdown`, `html`, `csv`, `json` |
| `--template` | no | One of `stig`, `security-matrix`, `device-list`, `diff`, `generic`; auto-picked by schema if omitted |
| `--columns` | no | Comma-separated column names; overrides template default (useful with `generic`) |
| `--sort` | no | Column name to sort by; prefix `-` for descending (e.g. `--sort -severity`) |
| `--group-by` | no | Column name; emits one sub-table per group — Markdown and HTML only |
| `--color` | no | Force ANSI color on (mutually exclusive with `--no-color`) |
| `--no-color` | no | Force ANSI color off (mutually exclusive with `--color`) |
| `--input` | no | Read JSON from a file instead of stdin |
| `--output` | no | Write rendered output to a file instead of stdout |
| `--list-templates` | no | Print available templates and exit |

**Templates and expected schemas:**

| Template | Expected schema | Visual treatment |
|---|---|---|
| `stig` | `[{"device": str, "rule": str, "severity": "Cat I\|II\|III", "status": "PASS\|FAIL\|N/A", ...}]` | Severity-colored cells (red/yellow/blue), grouped by rule when `--group-by rule` |
| `security-matrix` | `{"zones": [...], "cells": [[verdict, ...], ...]}` where verdict is `reachable\|blocked\|exempt\|partial` | Color-coded cell grid (red=reachable when shouldn't be, green=blocked, gray=exempt, yellow=partial) |
| `device-list` | `[{"name": str, "vendor": str, "model": str, "os": str, ...}]` | Vendor-colored row prefix; sortable by name/vendor/model in HTML |
| `diff` | `{"left": str, "right": str, "rows": [{"key": str, "left_value": str\|null, "right_value": str\|null}]}` | Side-by-side; `+`/`-`/`~` markers; ANSI green/red |
| `generic` | `[{...}]` | Auto-detect columns from keys; equal-weight rendering |

## Gotchas

- `--group-by` is silently ignored for `csv` and `ansi` formats — grouping only applies to `markdown` and `html`.
- `--sort` column prefix `-` means descending (e.g. `--sort -violationRowCount`); the column name must appear in the template's or `--columns` list.
- ANSI color auto-disables when stdout is not a TTY — piping to a file or another process strips color even without `--no-color`.
- `--color` and `--no-color` are mutually exclusive; passing both causes argparse to error.
- HTML output uses vanilla JS for column-click sort, which may be stripped by some email clients; share the `.html` file directly rather than pasting into email body.
- CSV output is always UTF-8, RFC 4180 quoted; grouping is ignored and a single header row is emitted.
