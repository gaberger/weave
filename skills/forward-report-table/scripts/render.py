#!/usr/bin/env python3
"""Render network-data JSON as ANSI / Markdown / HTML / CSV tables.

Pure renderer — reads JSON on stdin, writes the chosen format on stdout.
Stdlib only.

Schemas accepted (auto-detected unless --template is given):

* List of objects:   [{"k": "v", ...}, ...]                 -> generic / device-list / stig
* Matrix object:     {"zones": [...], "cells": [[...], ...]} -> security-matrix
* Diff object:       {"left": "...", "right": "...",
                      "rows": [{"key", "left_value", "right_value"}, ...]} -> diff
"""
from __future__ import annotations

import argparse
import csv
import html
import io
import json
import os
import sys
from pathlib import Path
from typing import Any, Iterable

# --- weave skill I/O contract -------------------------------------------------
# render.py is stdlib-only, but the machine-readable `--format json` path emits
# the shared envelope so weave parses one shape for every skill. The contract
# module lives in _shared/skill_io.py; this skill ships no `_bootstrap.py`, so
# mirror that shim's search order inline (plugin root → _shared/ → source-tree
# shared/) rather than adding a new `_`-prefixed file.
_HERE = Path(__file__).resolve().parent
for _cand in (
    *([Path(os.environ["CLAUDE_PLUGIN_ROOT"]) / "shared"] if os.environ.get("CLAUDE_PLUGIN_ROOT") else []),
    _HERE / "_shared",
    *(p / "shared" for p in _HERE.parents),
):
    if (_cand / "skill_io.py").is_file():
        if str(_cand) not in sys.path:
            sys.path.insert(0, str(_cand))
        break

from skill_io import ERR_INPUT, add_format_arg, emit_error, emit_success

# ---------------------------------------------------------------------------
# Color helpers (ANSI)
# ---------------------------------------------------------------------------

ANSI = {
    "reset": "\x1b[0m",
    "bold": "\x1b[1m",
    "dim": "\x1b[2m",
    "red": "\x1b[31m",
    "green": "\x1b[32m",
    "yellow": "\x1b[33m",
    "blue": "\x1b[34m",
    "magenta": "\x1b[35m",
    "cyan": "\x1b[36m",
    "gray": "\x1b[90m",
    "bg_red": "\x1b[41m",
    "bg_green": "\x1b[42m",
    "bg_yellow": "\x1b[43m",
    "bg_gray": "\x1b[100m",
}


def colorize(text: str, *codes: str, enabled: bool = True) -> str:
    if not enabled or not codes:
        return text
    return "".join(ANSI[c] for c in codes if c in ANSI) + text + ANSI["reset"]


# ---------------------------------------------------------------------------
# Template registry
# ---------------------------------------------------------------------------


def _stig_severity_codes(value: str) -> tuple[str, ...]:
    v = (value or "").strip().lower()
    if "i" == v or "cat i" in v or v == "high":
        return ("bold", "red")
    if "ii" in v or v == "medium":
        return ("yellow",)
    if "iii" in v or v == "low":
        return ("blue",)
    return ()


def _stig_status_codes(value: str) -> tuple[str, ...]:
    v = (value or "").strip().upper()
    if v in ("FAIL", "VIOLATION", "NON_COMPLIANT"):
        return ("bold", "red")
    if v in ("PASS", "COMPLIANT", "OK"):
        return ("green",)
    if v in ("N/A", "NOT_APPLICABLE", "SKIP"):
        return ("gray",)
    return ()


def _matrix_verdict_codes(value: str) -> tuple[str, ...]:
    """Color codes for security-matrix verdicts.

    Neutral palette — distinct hues per verdict, no good/bad implication.
    Whether OPEN is the alarm or NO_ROUTE is the alarm depends on the policy
    being audited; the renderer doesn't pick a side.
    """
    v = (value or "").strip().lower().replace("-", "_")
    if v in ("open", "reachable"):
        return ("blue",)
    if v in ("no_route", "blocked", "denied"):
        return ("gray",)
    if v in ("partial", "limited"):
        return ("yellow",)
    if v in ("exempt", "n_a", "not_applicable", ""):
        return ("dim",)
    return ()


def _vendor_codes(value: str) -> tuple[str, ...]:
    v = (value or "").strip().lower()
    return {
        "cisco": ("cyan",),
        "juniper": ("green",),
        "arista": ("magenta",),
        "palo alto": ("yellow",),
        "paloalto": ("yellow",),
        "fortinet": ("red",),
        "f5": ("blue",),
    }.get(v, ())


TEMPLATES: dict[str, dict[str, Any]] = {
    "stig": {
        "kind": "rows",
        "columns": ["device", "rule", "severity", "status", "description"],
        "color": {"severity": _stig_severity_codes, "status": _stig_status_codes},
    },
    "device-list": {
        "kind": "rows",
        "columns": ["name", "vendor", "model", "os", "version", "location"],
        "color": {"vendor": _vendor_codes},
    },
    "security-matrix": {
        "kind": "matrix",
        "color": _matrix_verdict_codes,
    },
    "diff": {
        "kind": "diff",
    },
    "generic": {
        "kind": "rows",
        "columns": None,  # derived from data keys
    },
}


# ---------------------------------------------------------------------------
# Data loading + auto-detection
# ---------------------------------------------------------------------------


def load_json(path: str | None) -> Any:
    if path:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    return json.load(sys.stdin)


def detect_template(data: Any) -> str:
    if isinstance(data, dict):
        if "zones" in data and "cells" in data:
            return "security-matrix"
        if "rows" in data and "left" in data and "right" in data:
            return "diff"
    if isinstance(data, list) and data and isinstance(data[0], dict):
        keys = set(data[0].keys())
        if {"device", "rule", "severity", "status"}.issubset(keys):
            return "stig"
        if "vendor" in keys and ("name" in keys or "hostname" in keys):
            return "device-list"
    return "generic"


def normalize_rows(data: Any, fmt: str = "json") -> list[dict[str, Any]]:
    if isinstance(data, list):
        return [r for r in data if isinstance(r, dict)]
    if isinstance(data, dict) and "data" in data and isinstance(data["data"], list):
        return [r for r in data["data"] if isinstance(r, dict)]
    emit_error(ERR_INPUT, "expected a JSON array of objects, got " + type(data).__name__,
               hint='pass a list of row objects, or {"data": [...]}', fmt=fmt)


# ---------------------------------------------------------------------------
# Sort + group helpers
# ---------------------------------------------------------------------------


def apply_sort(rows: list[dict[str, Any]], key: str | None) -> list[dict[str, Any]]:
    if not key:
        return rows
    descending = key.startswith("-")
    k = key.lstrip("-")
    return sorted(rows, key=lambda r: ("" if r.get(k) is None else str(r.get(k))), reverse=descending)


def apply_group(rows: list[dict[str, Any]], key: str | None) -> list[tuple[str, list[dict[str, Any]]]]:
    if not key:
        return [("", rows)]
    buckets: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        bk = str(r.get(key, ""))
        buckets.setdefault(bk, []).append(r)
    return sorted(buckets.items(), key=lambda kv: kv[0])


def resolve_columns(template: str, rows: list[dict[str, Any]], override: str | None) -> list[str]:
    if override:
        return [c.strip() for c in override.split(",") if c.strip()]
    spec = TEMPLATES[template].get("columns")
    if spec:
        # Keep only columns present in at least one row, preserve order
        present = set()
        for r in rows:
            present.update(r.keys())
        cols = [c for c in spec if c in present]
        if cols:
            return cols
    if rows:
        seen: list[str] = []
        seen_set: set[str] = set()
        for r in rows:
            for k in r.keys():
                if k not in seen_set:
                    seen.append(k)
                    seen_set.add(k)
        return seen
    return []


# ---------------------------------------------------------------------------
# Renderers — rows
# ---------------------------------------------------------------------------


def _cell_text(row: dict[str, Any], col: str) -> str:
    v = row.get(col)
    if v is None:
        return ""
    if isinstance(v, (dict, list)):
        return json.dumps(v, separators=(",", ":"))
    return str(v)


def render_ansi_rows(rows, columns, color_rules, color_enabled, group_label):
    if not rows:
        return ""
    widths = [len(c) for c in columns]
    text_rows = []
    for r in rows:
        cells = [_cell_text(r, c) for c in columns]
        text_rows.append(cells)
        for i, t in enumerate(cells):
            widths[i] = max(widths[i], len(t))

    out = io.StringIO()
    if group_label:
        out.write(colorize(f"\n[{group_label}]\n", "bold", "cyan", enabled=color_enabled))
    sep = "  "
    header = sep.join(colorize(c.ljust(widths[i]), "bold", enabled=color_enabled) for i, c in enumerate(columns))
    out.write(header + "\n")
    out.write(sep.join("-" * w for w in widths) + "\n")
    for cells, r in zip(text_rows, rows):
        styled = []
        for i, c in enumerate(columns):
            text = cells[i].ljust(widths[i])
            codes = ()
            rule = color_rules.get(c) if color_rules else None
            if rule and color_enabled:
                codes = rule(cells[i])
            styled.append(colorize(text, *codes, enabled=color_enabled))
        out.write(sep.join(styled) + "\n")
    return out.getvalue()


def _md_escape(s: str) -> str:
    return s.replace("|", "\\|").replace("\n", " ").replace("`", "\\`")


def render_markdown_rows(rows, columns, group_label):
    if not rows:
        return ""
    out = io.StringIO()
    if group_label:
        out.write(f"\n### {group_label}\n\n")
    out.write("| " + " | ".join(columns) + " |\n")
    out.write("|" + "|".join("---" for _ in columns) + "|\n")
    for r in rows:
        out.write("| " + " | ".join(_md_escape(_cell_text(r, c)) for c in columns) + " |\n")
    return out.getvalue()


def render_csv_rows(rows, columns):
    out = io.StringIO()
    w = csv.writer(out, quoting=csv.QUOTE_MINIMAL)
    w.writerow(columns)
    for r in rows:
        w.writerow([_cell_text(r, c) for c in columns])
    return out.getvalue()


HTML_HEAD = """<!doctype html>
<html><head><meta charset="utf-8"><title>{title}</title>
<style>
 body{{font:14px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:24px;color:#222}}
 h2{{margin:24px 0 8px;font-size:16px}}
 table{{border-collapse:collapse;margin-bottom:24px}}
 th,td{{border:1px solid #ddd;padding:6px 10px;text-align:left;vertical-align:top}}
 th{{background:#f3f3f3;cursor:pointer;user-select:none}}
 th:hover{{background:#e8e8e8}}
 tr:nth-child(even) td{{background:#fafafa}}
 .sev-i,.fail{{background:#fde2e2 !important;color:#7a1f1f;font-weight:600}}
 .sev-ii{{background:#fff4d6 !important}}
 .sev-iii{{background:#dde9ff !important}}
 .pass{{color:#1f7a3a}}
 .na{{color:#888}}
 .reachable{{background:#dde9ff !important}}
 .blocked{{background:#f0f0f0 !important;color:#666}}
 .partial{{background:#fff4d6 !important}}
 .exempt{{background:#f6f6f6 !important;color:#999;font-style:italic}}
 .vendor-cisco{{color:#0a6e8c}}
 .vendor-juniper{{color:#1f7a3a}}
 .vendor-arista{{color:#8b2a90}}
 .vendor-paloalto,.vendor-palo-alto{{color:#a17400}}
 .vendor-fortinet{{color:#a83232}}
 .vendor-f5{{color:#1f4ea8}}
 .matrix td:first-child{{font-weight:600;background:#f8f8f8}}
</style>
<script>
function sortBy(t,col){{
  const tbody=t.tBodies[0];
  const rows=Array.from(tbody.rows);
  const dir=t.dataset.sortCol==col&&t.dataset.sortDir!='desc'?'desc':'asc';
  rows.sort((a,b)=>{{
    const av=a.cells[col].textContent,bv=b.cells[col].textContent;
    return (dir=='asc'?1:-1)*av.localeCompare(bv,undefined,{{numeric:true}});
  }});
  rows.forEach(r=>tbody.appendChild(r));
  t.dataset.sortCol=col;t.dataset.sortDir=dir;
}}
window.addEventListener('DOMContentLoaded',()=>{{
  document.querySelectorAll('table').forEach(t=>{{
    t.querySelectorAll('thead th').forEach((th,i)=>th.addEventListener('click',()=>sortBy(t,i)))
  }})
}});
</script>
</head><body>
<h1>{title}</h1>
"""

HTML_TAIL = "</body></html>\n"


def _html_class_for(template: str, col: str, value: str) -> str:
    v = (value or "").strip().lower()
    if template == "stig":
        if col == "severity":
            if "i" == v or v == "cat i" or v == "high":
                return "sev-i"
            if "ii" in v or v == "medium":
                return "sev-ii"
            if "iii" in v or v == "low":
                return "sev-iii"
        if col == "status":
            if v in ("fail", "violation", "non_compliant"):
                return "fail"
            if v in ("pass", "compliant", "ok"):
                return "pass"
            if v in ("n/a", "not_applicable", "skip"):
                return "na"
    if template == "device-list" and col == "vendor":
        slug = v.replace(" ", "-")
        if slug:
            return f"vendor-{slug}"
    return ""


def render_html_rows(rows, columns, template, group_label):
    if not rows:
        return ""
    out = io.StringIO()
    if group_label:
        out.write(f"<h2>{html.escape(group_label)}</h2>\n")
    out.write("<table><thead><tr>")
    for c in columns:
        out.write(f"<th>{html.escape(c)}</th>")
    out.write("</tr></thead><tbody>\n")
    for r in rows:
        out.write("<tr>")
        for c in columns:
            text = _cell_text(r, c)
            cls = _html_class_for(template, c, text)
            attr = f' class="{cls}"' if cls else ""
            out.write(f"<td{attr}>{html.escape(text)}</td>")
        out.write("</tr>\n")
    out.write("</tbody></table>\n")
    return out.getvalue()


# ---------------------------------------------------------------------------
# Renderers — security matrix
# ---------------------------------------------------------------------------


def _matrix_validate(data: dict, fmt: str = "json") -> tuple[list[str], list[list[str]]]:
    zones = data.get("zones") or []
    cells = data.get("cells") or []
    if not isinstance(zones, list) or not isinstance(cells, list):
        emit_error(ERR_INPUT, "security-matrix expects {zones: [...], cells: [[...]]}", fmt=fmt)
    if len(cells) != len(zones):
        emit_error(ERR_INPUT, f"security-matrix has {len(zones)} zones but {len(cells)} rows", fmt=fmt)
    for i, row in enumerate(cells):
        if len(row) != len(zones):
            emit_error(ERR_INPUT, f"row {i} has {len(row)} cells but {len(zones)} zones expected", fmt=fmt)
    return zones, cells


def render_ansi_matrix(zones, cells, color_enabled):
    width = max(len(z) for z in zones) + 1
    cell_w = max(width, max(max(len(c) for c in row) for row in cells) + 1) if zones else 1
    out = io.StringIO()
    out.write(" " * (width + 2))
    for z in zones:
        out.write(colorize(z.center(cell_w), "bold", enabled=color_enabled))
    out.write("\n")
    for i, src in enumerate(zones):
        out.write(colorize(src.ljust(width), "bold", enabled=color_enabled) + "  ")
        for j, verdict in enumerate(cells[i]):
            codes = _matrix_verdict_codes(verdict)
            out.write(colorize(verdict.center(cell_w), *codes, enabled=color_enabled))
        out.write("\n")
    return out.getvalue()


def render_markdown_matrix(zones, cells):
    out = io.StringIO()
    out.write("| src \\ dst | " + " | ".join(zones) + " |\n")
    out.write("|" + "---|" * (len(zones) + 1) + "\n")
    for i, src in enumerate(zones):
        row = " | ".join(_md_escape(cells[i][j]) for j in range(len(zones)))
        out.write(f"| **{_md_escape(src)}** | {row} |\n")
    return out.getvalue()


def render_csv_matrix(zones, cells):
    out = io.StringIO()
    w = csv.writer(out, quoting=csv.QUOTE_MINIMAL)
    w.writerow(["src \\ dst"] + zones)
    for i, src in enumerate(zones):
        w.writerow([src] + cells[i])
    return out.getvalue()


def render_html_matrix(zones, cells):
    out = io.StringIO()
    out.write('<table class="matrix"><thead><tr><th>src \\ dst</th>')
    for z in zones:
        out.write(f"<th>{html.escape(z)}</th>")
    out.write("</tr></thead><tbody>\n")
    cls_map = {
        "open": "reachable", "reachable": "reachable",
        "no_route": "blocked", "blocked": "blocked", "denied": "blocked",
        "partial": "partial", "limited": "partial",
        "exempt": "exempt", "n_a": "exempt", "not_applicable": "exempt",
    }
    for i, src in enumerate(zones):
        out.write(f"<tr><td>{html.escape(src)}</td>")
        for j in range(len(zones)):
            v = cells[i][j]
            key = (v or "").strip().lower().replace("-", "_")
            cls = cls_map.get(key, "")
            attr = f' class="{cls}"' if cls else ""
            out.write(f"<td{attr}>{html.escape(v)}</td>")
        out.write("</tr>\n")
    out.write("</tbody></table>\n")
    return out.getvalue()


# ---------------------------------------------------------------------------
# Renderers — diff
# ---------------------------------------------------------------------------


def _diff_marker(left: Any, right: Any) -> str:
    if left is None:
        return "+"
    if right is None:
        return "-"
    if str(left) != str(right):
        return "~"
    return " "


def render_ansi_diff(data, color_enabled):
    left_label = data.get("left", "left")
    right_label = data.get("right", "right")
    rows = data.get("rows", [])
    if not rows:
        return ""
    keys = [str(r.get("key", "")) for r in rows]
    lefts = ["" if r.get("left_value") is None else str(r.get("left_value")) for r in rows]
    rights = ["" if r.get("right_value") is None else str(r.get("right_value")) for r in rows]
    kw = max([len(k) for k in keys] + [len("key")])
    lw = max([len(s) for s in lefts] + [len(left_label)])
    rw = max([len(s) for s in rights] + [len(right_label)])
    out = io.StringIO()
    header = (
        "  "
        + colorize("key".ljust(kw), "bold", enabled=color_enabled)
        + "  "
        + colorize(left_label.ljust(lw), "bold", enabled=color_enabled)
        + "  "
        + colorize(right_label.ljust(rw), "bold", enabled=color_enabled)
    )
    out.write(header + "\n")
    out.write("  " + "-" * kw + "  " + "-" * lw + "  " + "-" * rw + "\n")
    for r, k, l, rt in zip(rows, keys, lefts, rights):
        m = _diff_marker(r.get("left_value"), r.get("right_value"))
        codes = {"+": ("green",), "-": ("red",), "~": ("yellow",), " ": ()}[m]
        prefix = colorize(m + " ", *codes, enabled=color_enabled)
        out.write(prefix + k.ljust(kw) + "  " + l.ljust(lw) + "  " + rt.ljust(rw) + "\n")
    return out.getvalue()


def render_markdown_diff(data):
    left_label = data.get("left", "left")
    right_label = data.get("right", "right")
    rows = data.get("rows", [])
    out = io.StringIO()
    out.write(f"| Δ | key | {left_label} | {right_label} |\n")
    out.write("|---|---|---|---|\n")
    for r in rows:
        m = _diff_marker(r.get("left_value"), r.get("right_value"))
        l = "" if r.get("left_value") is None else str(r.get("left_value"))
        rt = "" if r.get("right_value") is None else str(r.get("right_value"))
        out.write(f"| `{m}` | {_md_escape(str(r.get('key','')))} | {_md_escape(l)} | {_md_escape(rt)} |\n")
    return out.getvalue()


def render_csv_diff(data):
    out = io.StringIO()
    w = csv.writer(out, quoting=csv.QUOTE_MINIMAL)
    w.writerow(["delta", "key", data.get("left", "left"), data.get("right", "right")])
    for r in data.get("rows", []):
        l = "" if r.get("left_value") is None else str(r.get("left_value"))
        rt = "" if r.get("right_value") is None else str(r.get("right_value"))
        w.writerow([_diff_marker(r.get("left_value"), r.get("right_value")), str(r.get("key", "")), l, rt])
    return out.getvalue()


def render_html_diff(data):
    left_label = data.get("left", "left")
    right_label = data.get("right", "right")
    rows = data.get("rows", [])
    out = io.StringIO()
    out.write("<table><thead><tr><th>Δ</th><th>key</th>")
    out.write(f"<th>{html.escape(left_label)}</th><th>{html.escape(right_label)}</th></tr></thead><tbody>\n")
    for r in rows:
        m = _diff_marker(r.get("left_value"), r.get("right_value"))
        cls = {"+": "pass", "-": "fail", "~": "sev-ii", " ": ""}[m]
        l = "" if r.get("left_value") is None else str(r.get("left_value"))
        rt = "" if r.get("right_value") is None else str(r.get("right_value"))
        attr = f' class="{cls}"' if cls else ""
        out.write(
            f'<tr{attr}><td>{html.escape(m)}</td><td>{html.escape(str(r.get("key","")))}</td>'
            f"<td>{html.escape(l)}</td><td>{html.escape(rt)}</td></tr>\n"
        )
    out.write("</tbody></table>\n")
    return out.getvalue()


# ---------------------------------------------------------------------------
# Main dispatch
# ---------------------------------------------------------------------------


def main() -> int:
    p = argparse.ArgumentParser(description="Render network-data JSON as a table.")
    add_format_arg(p, choices=("ansi", "markdown", "html", "csv", "json"), default="ansi")
    p.add_argument("--template", choices=list(TEMPLATES.keys()), default=None)
    p.add_argument("--columns", default=None, help="Comma-separated column names (overrides template default)")
    p.add_argument("--sort", default=None, help="Sort by column; prefix - for descending")
    p.add_argument("--group-by", default=None, help="Group rows by column (markdown/html only)")
    p.add_argument("--input", default=None, help="Read JSON from file instead of stdin")
    p.add_argument("--output", default=None, help="Write to file instead of stdout")
    color_grp = p.add_mutually_exclusive_group()
    color_grp.add_argument("--color", action="store_true", help="Force ANSI color on")
    color_grp.add_argument("--no-color", action="store_true", help="Force ANSI color off")
    p.add_argument("--list-templates", action="store_true")
    args = p.parse_args()

    if args.list_templates:
        for name, spec in TEMPLATES.items():
            cols = spec.get("columns") or "(auto)"
            print(f"{name:18s} kind={spec['kind']:8s} columns={cols}")
        return 0

    try:
        data = load_json(args.input)
    except FileNotFoundError:
        emit_error(ERR_INPUT, f"input file not found: {args.input}", fmt=args.format)
    except (json.JSONDecodeError, ValueError) as e:
        emit_error(ERR_INPUT, f"could not parse JSON input: {e}", fmt=args.format)
    template = args.template or detect_template(data)
    spec = TEMPLATES[template]

    # Templates that need a JSON OBJECT (not a list) — fail with a clear shape hint instead of an
    # uncaught AttributeError when handed row data.
    if spec["kind"] in ("matrix", "diff") and not isinstance(data, dict):
        want = ("{\"zones\": [...], \"cells\": [[...]]}" if spec["kind"] == "matrix"
                else "{\"left\": \"...\", \"right\": \"...\", \"rows\": [...]}")
        emit_error(ERR_INPUT,
                   f"the '{template}' template expects a JSON object {want}, not an array — "
                   f"for plain row data use the default/device-list/stig template instead",
                   fmt=args.format)

    if args.format == "ansi":
        color_enabled = (sys.stdout.isatty() and not args.no_color) or args.color
    else:
        color_enabled = False

    out_buf = io.StringIO()

    if spec["kind"] == "matrix":
        zones, cells = _matrix_validate(data, fmt=args.format)
        if args.format == "json":
            # JSON path: emit the matrix structure in the shared envelope so
            # weave consumes one shape; human formats keep the rendered grid.
            emit_success(
                {"zones": zones, "cells": cells},
                meta={"count": len(zones), "template": template},
                fmt="json",
            )
        if args.format == "ansi":
            out_buf.write(render_ansi_matrix(zones, cells, color_enabled))
        elif args.format == "markdown":
            out_buf.write(render_markdown_matrix(zones, cells))
        elif args.format == "csv":
            out_buf.write(render_csv_matrix(zones, cells))
        elif args.format == "html":
            out_buf.write(HTML_HEAD.format(title="Security Matrix"))
            out_buf.write(render_html_matrix(zones, cells))
            out_buf.write(HTML_TAIL)

    elif spec["kind"] == "diff":
        if args.format == "json":
            # JSON path: the diff rows are the payload; left/right labels in meta.
            diff_rows = data.get("rows", [])
            emit_success(
                diff_rows,
                meta={
                    "count": len(diff_rows),
                    "left": data.get("left", "left"),
                    "right": data.get("right", "right"),
                    "template": template,
                },
                fmt="json",
            )
        if args.format == "ansi":
            out_buf.write(render_ansi_diff(data, color_enabled))
        elif args.format == "markdown":
            out_buf.write(render_markdown_diff(data))
        elif args.format == "csv":
            out_buf.write(render_csv_diff(data))
        elif args.format == "html":
            out_buf.write(HTML_HEAD.format(title="Diff"))
            out_buf.write(render_html_diff(data))
            out_buf.write(HTML_TAIL)

    else:  # rows
        rows = normalize_rows(data, fmt=args.format)
        rows = apply_sort(rows, args.sort)
        columns = resolve_columns(template, rows, args.columns)
        if args.format == "json":
            # JSON path: rows are the payload; table shape lives in meta.
            emit_success(
                rows,
                meta={"count": len(rows), "columns": columns, "template": template},
                fmt="json",
            )
        groups = apply_group(rows, args.group_by)
        color_rules = spec.get("color") or {}

        if args.format == "ansi":
            for label, sub in groups:
                out_buf.write(render_ansi_rows(sub, columns, color_rules, color_enabled, label))
        elif args.format == "markdown":
            for label, sub in groups:
                out_buf.write(render_markdown_rows(sub, columns, label))
        elif args.format == "csv":
            # CSV ignores grouping (single header)
            out_buf.write(render_csv_rows(rows, columns))
        elif args.format == "html":
            out_buf.write(HTML_HEAD.format(title=template.title()))
            for label, sub in groups:
                out_buf.write(render_html_rows(sub, columns, template, label))
            out_buf.write(HTML_TAIL)

    payload = out_buf.getvalue()
    if args.output:
        with open(args.output, "w", encoding="utf-8") as fh:
            fh.write(payload)
    else:
        sys.stdout.write(payload)
    return 0


if __name__ == "__main__":
    sys.exit(main())
