---
name: forward-report-graph
description: Render network data as graphs / diagrams — Mermaid (default; pastes into GitHub/GitLab/Notion/Confluence/PRs), Graphviz DOT (for users who pipe to dot), or self-contained interactive HTML (vis-network, embedded inline). Use when the user asks to "draw the path", "show me the topology", "graph the BGP peerings", "visualize the failed flows", "diagram this", "give me a Mermaid diagram", "render as a graph". Reads JSON on stdin, emits graph syntax on stdout. Templates pre-configured for path traces (linear, drop-reason annotations on edges), full topology (vendor-icon nodes), BGP peer mesh (AS labels on edges), and config-diff (two-column compare). Not for tabular data (use forward-report-table) or narrative reports (use forward-report-doc).
allowed-tools: Bash(python3 *), Read
---

# Forward Report Graph

> **Read first:** `${CLAUDE_PLUGIN_ROOT}/shared/expertise/forward-as-backend.md` — the foundational framing. Renderer, not substrate query. Composes downstream of the data skills via shell pipe.

## Operate as a network engineer

Like `forward-report-table`, this is a **terminal-stage** renderer in the investigation chain. Reach for it when the answer needs spatial relationships — path traces, peer meshes, topology, drift comparisons — that lose meaning in tabular form.

- For multi-step investigations, read `${CLAUDE_PLUGIN_ROOT}/shared/expertise/investigation-workflows.md` first to plan the chain. Reach for this skill at the *render* step.

---

## Invocation

Run from the user's cwd. Do not narrate which script you're about to run.

```bash
# Path trace → Mermaid for the change ticket
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-path-analysis/scripts/search_path.py" \
    --network-id NET_xyz --dst-ip <ip> --src-ip <ip> | \
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-report-graph/scripts/render.py" \
    --template path

# BGP peer mesh → DOT, then PNG via graphviz
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-intel/scripts/get_bgp_peers.py" \
    --network-id NET_xyz | \
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-report-graph/scripts/render.py" \
    --template bgp-mesh --format dot | dot -Tpng -o bgp.png

# Topology → standalone interactive HTML (pan/zoom/click)
# Produce the topology JSON via NQE query (forward-nqe-query) or compose manually,
# then pipe to render.py:
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-report-graph/scripts/render.py" \
    --template topology --format html --output topology.html --input topology.json

# List available templates
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-report-graph/scripts/render.py" \
    --list-templates
```

Shape — reads JSON on stdin (or `--input <file>`) and writes graph syntax on stdout (or `--output <file>`). No network access, no auth, pure renderer.

| Template | Expected schema | What you get |
|---|---|---|
| `path` | `{"src": str, "dst": str, "hops": [{"device", "ingress_if", "egress_if", "outcome"\|"drop_reason"}]}` *(or path-analysis output — auto-mapped)* | Linear node chain `src → hop1 → hop2 → … → dst`. Drop hops styled red; drop-reason as edge label or final-node annotation. |
| `topology` | `{"nodes": [{"name", "vendor", "role"}], "edges": [{"from", "to", "label"?}]}` | Full graph; vendor-colored nodes, role-shaped (router=cylinder, firewall=hex, switch=rect). |
| `bgp-mesh` | `{"peers": [{"local", "local_asn", "peer", "peer_asn", "state"}]}` | Peer-to-peer graph; ASN labels on edges; Established=green, Idle/Active=red, OpenSent/Confirm=yellow. |
| `config-diff` | `{"left": str, "right": str, "rows": [{"key", "left_value", "right_value"}]}` | Two-column subgraph (left snapshot vs right); diverging keys connected by red `~` edges, additions by green `+` edges. |
| `generic` | `{"nodes": [...], "edges": [...]}` | Plain node/edge graph; no styling. |

## Output format

Never paste raw JSON. Lead with a verdict, not a dump.

- **Mermaid** — pastes directly into GitHub, GitLab, Notion, Obsidian, Confluence (with plugin), Slack canvases, VS Code preview. Wrap in fenced code block ` ```mermaid ` when embedding in Markdown.
- **DOT** — Graphviz format. Pipe to `dot -Tpng` / `dot -Tsvg` / `dot -Tpdf` for raster/vector output.
- **HTML** — single self-contained file with vis-network embedded **inline** (no CDN). Safe for air-gap environments. Opens in any browser, supports pan/zoom/drag.

Present the graph output inline (for Mermaid), or confirm the file was written and describe what it contains (for HTML/DOT). If the input JSON produced an empty graph (no nodes), state: "No graph rendered — the input contained no nodes or edges."

To inspect the rendered diagram further, ask: "Open topology.html in the browser and describe what you see."

## When to use

- "Draw the path from A to B"
- "Diagram why this flow drops"
- "Show me the BGP peer mesh on these spines"
- "Render the topology as Mermaid for the runbook"
- "Visualize what's different between these two snapshots"
- "Make me an interactive topology diagram I can pan around"

## When NOT to use

- Tabular data (STIG results, device list, security matrix as grid) → `forward-report-table`
- Narrative writeups → `forward-report-doc`
- Live screenshots from the Forward web UI → `forward-ui`

## Scripts

| Script | Purpose |
|---|---|
| `render.py` | Render network-data JSON as Mermaid, Graphviz DOT, or interactive HTML |

### render.py

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-report-graph/scripts/render.py" \
    --template path --format mermaid --direction LR

python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-report-graph/scripts/render.py" \
    --list-templates
```

| Flag | Required | Notes |
|---|---|---|
| `--format` | no | Output format: `mermaid` (default), `dot`, `html` |
| `--template` | no | One of `path`, `topology`, `bgp-mesh`, `config-diff`, `generic`. Auto-detected from input schema if omitted. |
| `--direction` | no | Layout direction: `LR` (default), `RL`, `TB`, `BT`. Applies to Mermaid and DOT only. |
| `--label-edges` | no | Force edge labels on (drop-reason / AS / metric). On by default for `path` and `bgp-mesh`. |
| `--no-label-edges` | no | Force edge labels off. Mutually exclusive with `--label-edges`. |
| `--input` | no | Read JSON from a file instead of stdin. |
| `--output` | no | Write graph output to a file instead of stdout. |
| `--list-templates` | no | Print available templates and exit. |

## Gotchas

- `--label-edges` and `--no-label-edges` are mutually exclusive; passing both causes argparse to exit with an error.
- Template auto-detection requires a recognizable top-level schema key (`hops`, `peers`, `rows`, `nodes`/`edges`). Ambiguous JSON must be paired with an explicit `--template`.
- The `topology` template expects `vendor` or `role` keys in each node object; without them auto-detection falls back to `generic` (plain, unstyled graph).
- HTML output embeds vis-network inline and produces large files (~400 KB); for air-gap use this is intentional.
