#!/usr/bin/env python3
"""Render network-data JSON as a graph (Mermaid / Graphviz DOT / interactive SVG-in-HTML).

Pure renderer — reads JSON on stdin, writes the chosen format on stdout.
Stdlib only. The HTML form ships with an inline pan/zoom SVG (no CDN, no external assets).
"""
from __future__ import annotations

import argparse
import html
import io
import json
import math
import sys
from typing import Any

# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def load_json(path: str | None) -> Any:
    if path:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    return json.load(sys.stdin)


def detect_template(data: Any) -> str:
    if isinstance(data, dict):
        if "hops" in data and ("src" in data or "dst" in data):
            return "path"
        if "peers" in data and isinstance(data["peers"], list):
            return "bgp-mesh"
        if "rows" in data and "left" in data and "right" in data:
            return "config-diff"
        if "nodes" in data and "edges" in data:
            # Inspect node shape for role/vendor → topology, else generic
            ns = data.get("nodes") or []
            if ns and isinstance(ns[0], dict) and ("vendor" in ns[0] or "role" in ns[0]):
                return "topology"
            return "generic"
    raise SystemExit(
        "error: cannot auto-detect template; pass --template "
        "(path|topology|bgp-mesh|config-diff|generic)"
    )


def _slug(s: str, used: set[str]) -> str:
    base = "".join(ch if ch.isalnum() else "_" for ch in str(s))
    if not base or base[0].isdigit():
        base = "n_" + base
    candidate = base
    i = 1
    while candidate in used:
        i += 1
        candidate = f"{base}_{i}"
    used.add(candidate)
    return candidate


VENDOR_COLORS = {
    "cisco": "#0a6e8c",
    "juniper": "#1f7a3a",
    "arista": "#8b2a90",
    "palo alto": "#a17400",
    "paloalto": "#a17400",
    "fortinet": "#a83232",
    "f5": "#1f4ea8",
}


def vendor_color(vendor: str) -> str:
    return VENDOR_COLORS.get((vendor or "").strip().lower(), "#444")


# ---------------------------------------------------------------------------
# Schema → unified internal graph
# ---------------------------------------------------------------------------
#
# Nodes:  [{"id": str, "label": str, "shape": str, "color": str, "class": str, "x"?: float, "y"?: float}]
# Edges:  [{"from": str, "to": str, "label": str, "color": str, "dashed": bool}]
# Title:  optional str
# ---------------------------------------------------------------------------


def build_path(data: dict) -> dict:
    used: set[str] = set()
    src = data.get("src") or "src"
    dst = data.get("dst") or "dst"
    nodes = []
    edges = []
    src_id = _slug("src_" + str(src), used)
    nodes.append({"id": src_id, "label": str(src), "shape": "stadium", "color": "#444", "class": "endpoint"})
    prev = src_id
    hops = data.get("hops") or []
    for i, h in enumerate(hops):
        if not isinstance(h, dict):
            continue
        device = str(h.get("device") or h.get("name") or f"hop{i}")
        outcome = (h.get("outcome") or "").strip().lower()
        drop_reason = h.get("drop_reason") or h.get("dropReason") or ""
        is_drop = outcome in ("dropped", "drop", "denied", "deny") or bool(drop_reason)
        nid = _slug(device + f"_{i}", used)
        nodes.append(
            {
                "id": nid,
                "label": device,
                "shape": "rect",
                "color": "#a83232" if is_drop else "#1f7a3a" if outcome == "delivered" else "#444",
                "class": "drop" if is_drop else ("ok" if outcome == "delivered" else "hop"),
                "tooltip": drop_reason or outcome or "",
            }
        )
        edge_label = ""
        if h.get("egress_if") or h.get("ingress_if"):
            edge_label = f"{h.get('ingress_if','')}→{h.get('egress_if','')}".strip("→")
        edges.append({"from": prev, "to": nid, "label": edge_label, "color": "#888", "dashed": False})
        prev = nid
        if is_drop:
            return {"nodes": nodes, "edges": edges, "title": f"Path: {src} → {dst} (DROPPED at {device})"}
    dst_id = _slug("dst_" + str(dst), used)
    nodes.append({"id": dst_id, "label": str(dst), "shape": "stadium", "color": "#444", "class": "endpoint"})
    edges.append({"from": prev, "to": dst_id, "label": "", "color": "#888", "dashed": False})
    return {"nodes": nodes, "edges": edges, "title": f"Path: {src} → {dst}"}


def build_topology(data: dict) -> dict:
    used: set[str] = set()
    nodes = []
    id_by_name: dict[str, str] = {}
    for n in data.get("nodes") or []:
        if not isinstance(n, dict):
            continue
        name = str(n.get("name") or n.get("id") or "")
        if not name:
            continue
        nid = _slug(name, used)
        id_by_name[name] = nid
        role = (n.get("role") or "").strip().lower()
        shape = {
            "router": "cylinder",
            "firewall": "hex",
            "switch": "rect",
            "load-balancer": "circle",
            "host": "stadium",
        }.get(role, "rect")
        nodes.append(
            {
                "id": nid,
                "label": name,
                "shape": shape,
                "color": vendor_color(n.get("vendor", "")),
                "class": role or "node",
                "tooltip": f"{n.get('vendor','')} {n.get('model','')}".strip(),
            }
        )
    edges = []
    for e in data.get("edges") or []:
        if not isinstance(e, dict):
            continue
        a = id_by_name.get(str(e.get("from", "")))
        b = id_by_name.get(str(e.get("to", "")))
        if not a or not b:
            continue
        edges.append({"from": a, "to": b, "label": str(e.get("label", "")), "color": "#888", "dashed": False})
    return {"nodes": nodes, "edges": edges, "title": "Topology"}


def build_bgp_mesh(data: dict) -> dict:
    used: set[str] = set()
    by_name: dict[str, str] = {}
    nodes = []
    edges = []
    for p in data.get("peers") or []:
        if not isinstance(p, dict):
            continue
        local = str(p.get("local") or p.get("localDevice") or "")
        peer = str(p.get("peer") or p.get("peerAddress") or "")
        if not local or not peer:
            continue
        for name, asn in ((local, p.get("local_asn") or p.get("localAsn")), (peer, p.get("peer_asn") or p.get("peerAsn"))):
            if name not in by_name:
                nid = _slug(name, used)
                by_name[name] = nid
                label = f"{name}\\nAS{asn}" if asn else name
                nodes.append({"id": nid, "label": label, "shape": "rect", "color": "#1f4ea8", "class": "router"})
        state = (p.get("state") or "").strip().lower()
        color = {
            "established": "#1f7a3a",
            "active": "#a83232",
            "idle": "#a83232",
            "opensent": "#a17400",
            "openconfirm": "#a17400",
            "connect": "#a17400",
        }.get(state, "#888")
        a, b = by_name[local], by_name[peer]
        edges.append({"from": a, "to": b, "label": state or "", "color": color, "dashed": state != "established"})
    return {"nodes": nodes, "edges": edges, "title": "BGP peer mesh"}


def build_config_diff(data: dict) -> dict:
    used: set[str] = set()
    left_label = data.get("left", "left")
    right_label = data.get("right", "right")
    nodes = []
    edges = []
    rows = data.get("rows") or []
    for i, r in enumerate(rows):
        if not isinstance(r, dict):
            continue
        key = str(r.get("key", f"row{i}"))
        lv = r.get("left_value")
        rv = r.get("right_value")
        l_id = _slug(f"L_{key}", used)
        r_id = _slug(f"R_{key}", used)
        marker = "+" if lv is None else "-" if rv is None else "~" if str(lv) != str(rv) else " "
        color = {"+": "#1f7a3a", "-": "#a83232", "~": "#a17400", " ": "#888"}[marker]
        nodes.append({"id": l_id, "label": f"{key}\\n{lv if lv is not None else ''}", "shape": "rect", "color": color, "class": "diff-left"})
        nodes.append({"id": r_id, "label": f"{key}\\n{rv if rv is not None else ''}", "shape": "rect", "color": color, "class": "diff-right"})
        edges.append({"from": l_id, "to": r_id, "label": marker, "color": color, "dashed": marker != " "})
    return {"nodes": nodes, "edges": edges, "title": f"Diff: {left_label} ↔ {right_label}"}


def build_generic(data: dict) -> dict:
    used: set[str] = set()
    by_name: dict[str, str] = {}
    nodes = []
    for n in data.get("nodes") or []:
        name = str(n.get("id") or n.get("name") or "")
        if not name:
            continue
        nid = _slug(name, used)
        by_name[name] = nid
        nodes.append({"id": nid, "label": str(n.get("label") or name), "shape": "rect", "color": "#444", "class": "node"})
    edges = []
    for e in data.get("edges") or []:
        a = by_name.get(str(e.get("from", "")))
        b = by_name.get(str(e.get("to", "")))
        if not a or not b:
            continue
        edges.append({"from": a, "to": b, "label": str(e.get("label", "")), "color": "#888", "dashed": False})
    return {"nodes": nodes, "edges": edges, "title": "Graph"}


BUILDERS = {
    "path": build_path,
    "topology": build_topology,
    "bgp-mesh": build_bgp_mesh,
    "config-diff": build_config_diff,
    "generic": build_generic,
}


# ---------------------------------------------------------------------------
# Mermaid renderer
# ---------------------------------------------------------------------------


def _mermaid_node(n: dict) -> str:
    lbl = n["label"].replace("\\n", "<br/>").replace('"', "&quot;")
    shape = n.get("shape", "rect")
    open_, close = {
        "rect": ("[", "]"),
        "stadium": ("([", "])"),
        "cylinder": ("[(", ")]"),
        "circle": ("((", "))"),
        "hex": ("{{", "}}"),
    }.get(shape, ("[", "]"))
    return f'{n["id"]}{open_}"{lbl}"{close}'


def render_mermaid(g: dict, direction: str, label_edges: bool) -> str:
    out = io.StringIO()
    out.write(f"flowchart {direction}\n")
    if g.get("title"):
        out.write(f'  %% {g["title"]}\n')
    seen_nodes: set[str] = set()
    for n in g["nodes"]:
        out.write("  " + _mermaid_node(n) + "\n")
        seen_nodes.add(n["id"])
    for e in g["edges"]:
        arrow = "-.->" if e.get("dashed") else "-->"
        if label_edges and e.get("label"):
            lbl = str(e["label"]).replace("|", "/").replace('"', "'")
            out.write(f'  {e["from"]} {arrow}|{lbl}| {e["to"]}\n')
        else:
            out.write(f'  {e["from"]} {arrow} {e["to"]}\n')
    # classDefs (Mermaid styling)
    out.write("  classDef drop fill:#fde2e2,stroke:#a83232,color:#7a1f1f,font-weight:bold\n")
    out.write("  classDef ok fill:#dff5e1,stroke:#1f7a3a\n")
    out.write("  classDef endpoint fill:#eef,stroke:#444\n")
    for n in g["nodes"]:
        if n.get("class") in ("drop", "ok", "endpoint"):
            out.write(f'  class {n["id"]} {n["class"]}\n')
    return out.getvalue()


# ---------------------------------------------------------------------------
# DOT renderer
# ---------------------------------------------------------------------------


def render_dot(g: dict, direction: str, label_edges: bool) -> str:
    rankdir = {"LR": "LR", "RL": "RL", "TB": "TB", "BT": "BT"}.get(direction, "LR")
    shape_map = {
        "rect": "box",
        "stadium": "box",
        "cylinder": "cylinder",
        "circle": "circle",
        "hex": "hexagon",
    }
    out = io.StringIO()
    out.write("digraph G {\n")
    if g.get("title"):
        out.write(f'  label="{g["title"]}"; labelloc=t;\n')
    out.write(f"  rankdir={rankdir};\n")
    out.write('  node [fontname="Helvetica",style="filled",fillcolor="#f8f8f8"];\n')
    out.write('  edge [fontname="Helvetica"];\n')
    for n in g["nodes"]:
        lbl = n["label"].replace("\\n", "\\n").replace('"', '\\"')
        shape = shape_map.get(n.get("shape", "rect"), "box")
        color = n.get("color", "#444")
        out.write(f'  {n["id"]} [label="{lbl}",shape={shape},color="{color}"];\n')
    for e in g["edges"]:
        attrs = [f'color="{e.get("color","#888")}"']
        if e.get("dashed"):
            attrs.append('style="dashed"')
        if label_edges and e.get("label"):
            esc = str(e["label"]).replace('"', '\\"')
            attrs.append(f'label="{esc}"')
        out.write(f'  {e["from"]} -> {e["to"]} [{",".join(attrs)}];\n')
    out.write("}\n")
    return out.getvalue()


# ---------------------------------------------------------------------------
# HTML/SVG renderer (self-contained, no CDN, with pan/zoom)
# ---------------------------------------------------------------------------


def _layout_path(g: dict) -> None:
    n = len(g["nodes"])
    for i, node in enumerate(g["nodes"]):
        node["x"] = 80 + i * 180
        node["y"] = 200


def _layout_bgp_mesh(g: dict) -> None:
    n = max(1, len(g["nodes"]))
    cx, cy, r = 400, 300, 220
    for i, node in enumerate(g["nodes"]):
        a = 2 * math.pi * i / n
        node["x"] = cx + r * math.cos(a)
        node["y"] = cy + r * math.sin(a)


def _layout_topology(g: dict) -> None:
    # Group by class (role); each row gets a band
    rows: dict[str, list[dict]] = {}
    for n in g["nodes"]:
        rows.setdefault(n.get("class", "node"), []).append(n)
    role_order = ["firewall", "router", "switch", "load-balancer", "host", "node"]
    ordered = [(r, rows[r]) for r in role_order if r in rows] + [(r, ns) for r, ns in rows.items() if r not in role_order]
    for ri, (_, ns) in enumerate(ordered):
        for ci, n in enumerate(ns):
            n["x"] = 80 + ci * 180
            n["y"] = 80 + ri * 140


def _layout_config_diff(g: dict) -> None:
    lefts = [n for n in g["nodes"] if n.get("class") == "diff-left"]
    rights = [n for n in g["nodes"] if n.get("class") == "diff-right"]
    for i, n in enumerate(lefts):
        n["x"] = 100
        n["y"] = 60 + i * 70
    for i, n in enumerate(rights):
        n["x"] = 500
        n["y"] = 60 + i * 70


def _layout_generic(g: dict) -> None:
    # Simple grid
    cols = max(1, math.ceil(math.sqrt(len(g["nodes"]))))
    for i, n in enumerate(g["nodes"]):
        n["x"] = 80 + (i % cols) * 180
        n["y"] = 80 + (i // cols) * 140


LAYOUTS = {
    "path": _layout_path,
    "topology": _layout_topology,
    "bgp-mesh": _layout_bgp_mesh,
    "config-diff": _layout_config_diff,
    "generic": _layout_generic,
}


HTML_TEMPLATE = """<!doctype html>
<html><head><meta charset="utf-8"><title>{title}</title>
<style>
 html,body{{margin:0;padding:0;height:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#fafafa}}
 #wrap{{position:fixed;inset:0;display:flex;flex-direction:column}}
 header{{padding:8px 16px;background:#fff;border-bottom:1px solid #ddd;display:flex;align-items:center;gap:12px}}
 header h1{{font-size:14px;margin:0;font-weight:600}}
 header .hint{{color:#888;font-size:12px}}
 #svgwrap{{flex:1;overflow:hidden;cursor:grab}}
 #svgwrap.dragging{{cursor:grabbing}}
 svg{{width:100%;height:100%;display:block}}
 .node rect,.node ellipse,.node polygon,.node path{{fill:#fff;stroke-width:2px}}
 .node text{{font-size:12px;text-anchor:middle;dominant-baseline:central;fill:#222;pointer-events:none}}
 .edge{{fill:none;stroke-width:1.6px}}
 .edge-label{{font-size:11px;fill:#444;text-anchor:middle}}
 .arrowhead{{fill:#888}}
</style></head>
<body><div id="wrap">
<header><h1>{title}</h1><span class="hint">drag to pan · wheel to zoom</span></header>
<div id="svgwrap">{svg}</div>
</div>
<script>
(function(){{
 const wrap=document.getElementById('svgwrap');
 const svg=wrap.querySelector('svg');
 const g=svg.querySelector('g.viewport');
 let scale=1,tx=0,ty=0,dragging=false,sx=0,sy=0;
 function apply(){{g.setAttribute('transform','translate('+tx+','+ty+') scale('+scale+')');}}
 wrap.addEventListener('mousedown',e=>{{dragging=true;wrap.classList.add('dragging');sx=e.clientX-tx;sy=e.clientY-ty;}});
 window.addEventListener('mouseup',()=>{{dragging=false;wrap.classList.remove('dragging');}});
 window.addEventListener('mousemove',e=>{{if(!dragging)return;tx=e.clientX-sx;ty=e.clientY-sy;apply();}});
 wrap.addEventListener('wheel',e=>{{e.preventDefault();const f=e.deltaY<0?1.1:1/1.1;const r=svg.getBoundingClientRect();const mx=e.clientX-r.left,my=e.clientY-r.top;tx=mx-(mx-tx)*f;ty=my-(my-ty)*f;scale*=f;apply();}},{{passive:false}});
}})();
</script></body></html>
"""


def _shape_svg(n: dict, width: int = 140, height: int = 50) -> str:
    x, y = n["x"], n["y"]
    color = n.get("color", "#444")
    shape = n.get("shape", "rect")
    if shape == "stadium":
        return f'<rect x="{x-width/2}" y="{y-height/2}" width="{width}" height="{height}" rx="{height/2}" ry="{height/2}" stroke="{color}"/>'
    if shape == "cylinder":
        return (
            f'<path d="M{x-width/2},{y-height/2+8} '
            f"C{x-width/2},{y-height/2-4} {x+width/2},{y-height/2-4} {x+width/2},{y-height/2+8} "
            f"L{x+width/2},{y+height/2-8} "
            f"C{x+width/2},{y+height/2+4} {x-width/2},{y+height/2+4} {x-width/2},{y+height/2-8} "
            f'Z" stroke="{color}"/>'
        )
    if shape == "circle":
        r = max(width, height) / 2
        return f'<ellipse cx="{x}" cy="{y}" rx="{r}" ry="{r}" stroke="{color}"/>'
    if shape == "hex":
        w, h = width / 2, height / 2
        pts = f"{x-w+12},{y-h} {x+w-12},{y-h} {x+w},{y} {x+w-12},{y+h} {x-w+12},{y+h} {x-w},{y}"
        return f'<polygon points="{pts}" stroke="{color}"/>'
    # rect
    return f'<rect x="{x-width/2}" y="{y-height/2}" width="{width}" height="{height}" stroke="{color}"/>'


def _multiline_text(n: dict) -> str:
    lines = n["label"].split("\\n")
    out = []
    base = n["y"] - (len(lines) - 1) * 7
    for i, line in enumerate(lines):
        out.append(f'<text x="{n["x"]}" y="{base + i*14}">{html.escape(line)}</text>')
    return "".join(out)


def render_html(g: dict, title: str, label_edges: bool) -> str:
    parts = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid meet">']
    parts.append(
        '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">'
        '<path class="arrowhead" d="M0,0 L10,5 L0,10 z"/></marker></defs>'
    )
    parts.append('<g class="viewport">')
    # edges first (so nodes overlay)
    pos = {n["id"]: (n["x"], n["y"]) for n in g["nodes"]}
    for e in g["edges"]:
        a = pos.get(e["from"])
        b = pos.get(e["to"])
        if not a or not b:
            continue
        x1, y1 = a
        x2, y2 = b
        dash = ' stroke-dasharray="4,3"' if e.get("dashed") else ""
        color = e.get("color", "#888")
        parts.append(
            f'<line class="edge" x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color}"{dash} marker-end="url(#arrow)"/>'
        )
        if label_edges and e.get("label"):
            parts.append(
                f'<text class="edge-label" x="{(x1+x2)/2}" y="{(y1+y2)/2 - 6}">{html.escape(str(e["label"]))}</text>'
            )
    for n in g["nodes"]:
        parts.append('<g class="node">')
        parts.append(_shape_svg(n))
        parts.append(_multiline_text(n))
        parts.append("</g>")
    parts.append("</g></svg>")
    svg = "".join(parts)
    return HTML_TEMPLATE.format(title=html.escape(title), svg=svg)


# ---------------------------------------------------------------------------
# Main dispatch
# ---------------------------------------------------------------------------


def main() -> int:
    p = argparse.ArgumentParser(description="Render network-data JSON as a graph.")
    p.add_argument("--format", choices=["mermaid", "dot", "html"], default="mermaid")
    p.add_argument("--template", choices=list(BUILDERS.keys()), default=None)
    p.add_argument("--direction", choices=["LR", "RL", "TB", "BT"], default="LR")
    edge_grp = p.add_mutually_exclusive_group()
    edge_grp.add_argument("--label-edges", action="store_true")
    edge_grp.add_argument("--no-label-edges", action="store_true")
    p.add_argument("--input", default=None)
    p.add_argument("--output", default=None)
    p.add_argument("--list-templates", action="store_true")
    args = p.parse_args()

    if args.list_templates:
        for name in BUILDERS:
            print(name)
        return 0

    data = load_json(args.input)
    template = args.template or detect_template(data)
    g = BUILDERS[template](data)

    if args.label_edges:
        label_edges = True
    elif args.no_label_edges:
        label_edges = False
    else:
        label_edges = template in ("path", "bgp-mesh")

    if args.format == "mermaid":
        payload = render_mermaid(g, args.direction, label_edges)
    elif args.format == "dot":
        payload = render_dot(g, args.direction, label_edges)
    else:  # html
        LAYOUTS[template](g)
        payload = render_html(g, g.get("title", "Graph"), label_edges)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as fh:
            fh.write(payload)
    else:
        sys.stdout.write(payload)
    return 0


if __name__ == "__main__":
    sys.exit(main())
