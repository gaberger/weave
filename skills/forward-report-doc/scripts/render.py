#!/usr/bin/env python3
"""Render a structured investigation as a Markdown or HTML report.

Pure renderer — reads document JSON on stdin, writes the chosen format on stdout.
Stdlib only. Templates prescribe section ordering; the document body comes from input.

Two output registers are supported:

  * Audit-shaped templates (incident-report, change-ticket, compliance-audit,
    drift-report) — section-ordered, finding-listed, evidence-after-prose.
  * Insight-led template (network-review) — pattern-paragraph-first, numbered
    insights with citations, themed gap-groups (gaps clustered by their root
    cause), strengths to preserve, audit detail moved to an appendix.

The renderer also resolves citation `topic` keys to URL+title pairs by reading
``shared/expertise/references.md`` (the frozen reference catalog) at startup.
"""
from __future__ import annotations

import argparse
import html
import io
import json
import os
import re
import sys
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# References catalog loader
# ---------------------------------------------------------------------------


def _candidate_catalog_paths() -> list[Path]:
    here = Path(__file__).resolve().parent
    out: list[Path] = []
    plugin_root = os.environ.get("CLAUDE_PLUGIN_ROOT")
    if plugin_root:
        out.append(Path(plugin_root) / "shared" / "expertise" / "references.md")
    out.append(here / "_shared" / "expertise" / "references.md")
    for parent in here.parents:
        out.append(parent / "shared" / "expertise" / "references.md")
    return out


_CATALOG_ROW = re.compile(r"^\|\s*`([a-z0-9_-]+)`\s*\|\s*([^|]+?)\s*\|\s*(https?://\S+)\s*\|")


def load_references() -> dict[str, dict[str, str]]:
    """Parse ``shared/expertise/references.md`` and return ``topic → {title, url}``."""
    for p in _candidate_catalog_paths():
        if p.is_file():
            text = p.read_text(encoding="utf-8")
            out: dict[str, dict[str, str]] = {}
            for line in text.splitlines():
                m = _CATALOG_ROW.match(line)
                if m:
                    topic, title, url = m.group(1), m.group(2).strip(), m.group(3).strip()
                    out[topic] = {"title": title, "url": url}
            return out
    return {}


REFERENCES = load_references()


def resolve_reference(block: dict) -> dict:
    """Return ``{title, url, why}`` for a reference block, falling back to catalog."""
    title = block.get("title")
    url = block.get("url")
    why = block.get("why") or block.get("note") or ""
    topic = block.get("topic")
    if topic and topic in REFERENCES:
        title = title or REFERENCES[topic]["title"]
        url = url or REFERENCES[topic]["url"]
    return {"title": title or "", "url": url or "", "why": why}

# ---------------------------------------------------------------------------
# Templates (section ordering)
# ---------------------------------------------------------------------------

TEMPLATES: dict[str, list[str]] = {
    "incident-report": [
        "Summary",
        "Timeline",
        "Impact",
        "Root cause",
        "Remediation",
        "Validation",
        "Lessons",
    ],
    "change-ticket": [
        "Summary",
        "Pre-state",
        "Proposed change",
        "Predicted impact",
        "Rollback plan",
        "Approvals",
    ],
    "compliance-audit": [
        "Scope",
        "Methodology",
        "Findings",
        "Evidence",
        "Remediation",
        "Re-test plan",
    ],
    "network-review": [
        "Pattern",
        "Insights",
        "Themed gaps",
        "Strengths to preserve",
        "Action plan",
        "Appendix",
    ],
    "action-plan": [
        "Goal",
        "Phases",
        "Validation gate",
        "Rollback summary",
    ],
    "drift-report": [
        "Scope",
        "Comparison axis",
        "Findings",
        "Per-device evidence",
        "Recommended actions",
    ],
    "generic": [],
}


# ---------------------------------------------------------------------------
# Section reordering
# ---------------------------------------------------------------------------


def order_sections(sections: list[dict], template: str, scaffold: bool) -> list[dict]:
    spec = TEMPLATES.get(template, [])
    if not spec:
        return sections
    by_title: dict[str, dict] = {}
    extras: list[dict] = []
    for s in sections:
        if not isinstance(s, dict):
            continue
        title = (s.get("title") or "").strip()
        key = title.lower()
        if key in (k.lower() for k in spec):
            by_title[key] = s
        else:
            extras.append(s)
    out: list[dict] = []
    for want in spec:
        s = by_title.get(want.lower())
        if s is not None:
            out.append(s)
        elif scaffold:
            out.append({"title": want, "body": f"<!-- TODO: fill in {want} -->"})
    out.extend(extras)
    return out


# ---------------------------------------------------------------------------
# Markdown renderer
# ---------------------------------------------------------------------------


def _md_metadata(meta: dict) -> str:
    if not meta:
        return ""
    out = io.StringIO()
    out.write("| | |\n|---|---|\n")
    for k, v in meta.items():
        out.write(f"| **{_md_inline(str(k))}** | {_md_inline(str(v))} |\n")
    out.write("\n")
    return out.getvalue()


def _md_inline(s: str) -> str:
    return s.replace("|", "\\|")


def _md_table(headers: list[str], rows: list[list[Any]]) -> str:
    out = io.StringIO()
    out.write("| " + " | ".join(_md_inline(str(h)) for h in headers) + " |\n")
    out.write("|" + "|".join("---" for _ in headers) + "|\n")
    for row in rows:
        out.write("| " + " | ".join(_md_inline(str(c)) for c in row) + " |\n")
    return out.getvalue()


CALLOUT_PREFIX = {"info": "ℹ️", "warning": "⚠️", "danger": "🛑", "success": "✅"}


def _md_callout(level: str, body: str) -> str:
    prefix = CALLOUT_PREFIX.get(level.lower(), "ℹ️")
    return "\n".join(f"> {prefix} {line}" for line in body.splitlines()) + "\n"


def _md_block(b: dict) -> str:
    if not isinstance(b, dict):
        return ""
    kind = (b.get("kind") or "").lower()
    cap = b.get("caption")
    out = io.StringIO()
    if cap:
        out.write(f"\n*{cap}*\n\n")
    if kind == "code":
        lang = b.get("lang") or ""
        out.write(f"```{lang}\n{b.get('body','')}\n```\n")
    elif kind == "mermaid":
        out.write(f"```mermaid\n{b.get('body','')}\n```\n")
    elif kind == "table":
        headers = b.get("headers") or []
        rows = b.get("rows") or []
        out.write(_md_table(headers, rows))
    elif kind == "callout":
        out.write(_md_callout(b.get("level", "info"), b.get("body", "")))
    elif kind == "reference":
        ref = resolve_reference(b)
        if not ref["url"] and not ref["title"]:
            return ""
        line = f"  ↳ Reference: [{ref['title']}]({ref['url']})" if ref["url"] else f"  ↳ Reference: {ref['title']}"
        if ref["why"]:
            line += f" — {ref['why']}"
        out.write(line + "\n")
    elif kind == "insight":
        # Numbered insight: claim (bold) + evidence + zero-or-more references
        n = b.get("n") or b.get("number")
        head = f"**{n}. {b.get('claim','')}**" if n is not None else f"**{b.get('claim','')}**"
        out.write(f"{head}\n\n")
        ev = b.get("evidence")
        if ev:
            out.write(str(ev).rstrip() + "\n\n")
        for r in b.get("references") or []:
            out.write(_md_block({"kind": "reference", **r}))
        out.write("\n")
    elif kind == "themed-gap":
        # A group of findings sharing a root cause: theme paragraph + table
        out.write(f"**{b.get('theme','')}**\n\n")
        if b.get("posture-decision"):
            out.write(str(b["posture-decision"]).rstrip() + "\n\n")
        gaps = b.get("gaps") or []
        if gaps:
            out.write(_md_table(["Gap", "What it actually defends against"],
                                [[g.get("name", ""), g.get("defense", "")] for g in gaps]))
        for r in b.get("references") or []:
            out.write(_md_block({"kind": "reference", **r}))
    elif kind == "phase":
        out.write(f"\n### {b.get('id','P')}: {b.get('name','Phase')}\n\n")
        if b.get("goal"):
            out.write(f"_Goal:_ {b['goal']}\n\n")
        if b.get("gating-criteria"):
            out.write(f"_Gate:_ {b['gating-criteria']}\n\n")
    elif kind == "action":
        rows = []
        for k in ("devices", "prereq", "window", "rollback", "time"):
            if b.get(k):
                rows.append([k.capitalize(), str(b[k])])
        out.write(f"\n**{b.get('id','A')} — {b.get('title','')}**")
        if b.get("severity"):
            out.write(f" _(severity: {b['severity']})_")
        if b.get("closes"):
            out.write(f" — closes {b['closes']}")
        out.write("\n\n")
        if rows:
            out.write(_md_table(["", ""], rows))
        if b.get("config"):
            out.write(f"\n_Config:_\n```{b.get('lang','')}\n{b['config']}\n```\n")
        if b.get("validate"):
            out.write(f"\n_Validate:_\n```bash\n{b['validate']}\n```\n")
        for r in b.get("references") or []:
            out.write(_md_block({"kind": "reference", **r}))
    else:
        out.write(str(b.get("body", "")) + "\n")
    return out.getvalue()


def render_markdown(doc: dict, template: str, title_override: str | None, scaffold: bool) -> str:
    out = io.StringIO()
    title = title_override or doc.get("title") or template.replace("-", " ").title()
    out.write(f"# {title}\n\n")
    if doc.get("summary"):
        out.write(doc["summary"].rstrip() + "\n\n")
    out.write(_md_metadata(doc.get("metadata") or {}))
    sections = order_sections(doc.get("sections") or [], template, scaffold)
    for s in sections:
        if not isinstance(s, dict):
            continue
        out.write(f"\n## {s.get('title','Section')}\n\n")
        body = s.get("body")
        if body:
            out.write(str(body).rstrip() + "\n\n")
        for blk in s.get("blocks") or []:
            out.write(_md_block(blk))
    return out.getvalue()


# ---------------------------------------------------------------------------
# HTML renderer
# ---------------------------------------------------------------------------

HTML_HEAD = """<!doctype html>
<html><head><meta charset="utf-8"><title>{title}</title>
<style>
 body{{font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:840px;margin:32px auto;padding:0 24px;color:#222}}
 h1{{font-size:24px;border-bottom:2px solid #ddd;padding-bottom:8px;margin-top:0}}
 h2{{font-size:18px;margin-top:32px;border-bottom:1px solid #eee;padding-bottom:4px}}
 h3{{font-size:15px;margin-top:18px}}
 .summary{{font-size:15px;color:#444;margin:12px 0 24px}}
 .meta{{font-size:13px;color:#444;border-collapse:collapse;margin:0 0 24px}}
 .meta td{{border:1px solid #ddd;padding:4px 10px;vertical-align:top}}
 .meta td:first-child{{background:#f6f6f6;font-weight:600}}
 pre{{background:#f6f8fa;padding:10px 14px;border-radius:6px;overflow-x:auto;font:13px/1.45 'SFMono-Regular',Consolas,Menlo,monospace}}
 code{{background:#f6f8fa;padding:1px 5px;border-radius:3px;font:13px/1.45 'SFMono-Regular',Consolas,Menlo,monospace}}
 table{{border-collapse:collapse;margin:12px 0}}
 th,td{{border:1px solid #ddd;padding:6px 10px;text-align:left;vertical-align:top}}
 th{{background:#f3f3f3}}
 .caption{{font-style:italic;color:#666;font-size:13px;margin:12px 0 4px}}
 .callout{{padding:10px 14px;border-radius:6px;margin:12px 0;border-left:4px solid #888}}
 .callout.info{{background:#eef5ff;border-color:#3b6fd6}}
 .callout.warning{{background:#fff7e0;border-color:#a17400}}
 .callout.danger{{background:#fde2e2;border-color:#a83232}}
 .callout.success{{background:#dff5e1;border-color:#1f7a3a}}
 pre.mermaid{{background:#fafafa;border:1px dashed #aaa;color:#555}}
 .insight{{margin:18px 0;padding:12px 16px;border-left:3px solid #3b6fd6;background:#f7faff}}
 .insight-claim{{font-size:15px;margin:0 0 8px;color:#1f3d77}}
 .reference{{font-size:13px;color:#555;margin:6px 0;padding-left:8px;border-left:2px solid #ccc}}
 .reference a{{color:#1f4ea8;text-decoration:none}}
 .reference a:hover{{text-decoration:underline}}
 .themed-gap{{margin:18px 0;padding:12px 16px;border:1px solid #e0e0e0;border-radius:6px;background:#fafafa}}
 .themed-gap h3{{margin-top:0;color:#444}}
 .phase{{margin-top:28px;padding:6px 10px;background:#eef5ff;border-radius:4px;color:#1f3d77}}
 .phase-goal,.phase-gate{{font-size:13px;color:#444;margin:4px 0}}
 .action{{margin:14px 0;padding:12px 16px;border:1px solid #ddd;border-radius:6px;background:#fff}}
 .action h4{{margin:0 0 8px}}
 .action-meta{{font-size:12px;color:#666;font-weight:normal}}
 .action-meta-tbl td{{font-size:13px;padding:3px 8px}}
 .action-meta-tbl td:first-child{{background:#f6f6f6;font-weight:600;width:1%;white-space:nowrap}}
 @media print{{body{{margin:0;padding:8px}}h2{{page-break-after:avoid}}pre,table{{page-break-inside:avoid}}}}
</style></head>
<body>
"""

HTML_TAIL = "</body></html>\n"


def _h_inline(s: str) -> str:
    return html.escape(s, quote=False)


def _h_para_md(body: str) -> str:
    """Light markdown→html: paragraphs, bold, italic, inline code, fenced code, lists."""
    if not body:
        return ""
    out = io.StringIO()
    in_code = False
    code_lang = ""
    code_buf: list[str] = []
    in_list = False
    list_kind = ""
    para: list[str] = []

    def flush_para():
        nonlocal para
        if para:
            text = " ".join(para)
            text = _inline_md(text)
            out.write(f"<p>{text}</p>\n")
            para = []

    def flush_list():
        nonlocal in_list, list_kind
        if in_list:
            out.write(f"</{list_kind}>\n")
            in_list = False
            list_kind = ""

    for raw in body.splitlines():
        line = raw.rstrip()
        if line.startswith("```"):
            if not in_code:
                flush_para()
                flush_list()
                in_code = True
                code_lang = line[3:].strip()
                code_buf = []
            else:
                content = "\n".join(code_buf)
                lang_attr = f' class="language-{html.escape(code_lang)}"' if code_lang else ""
                out.write(f"<pre><code{lang_attr}>{html.escape(content)}</code></pre>\n")
                in_code = False
                code_lang = ""
                code_buf = []
            continue
        if in_code:
            code_buf.append(raw)
            continue
        if line.startswith("- ") or line.startswith("* "):
            flush_para()
            if not in_list or list_kind != "ul":
                flush_list()
                out.write("<ul>\n")
                in_list = True
                list_kind = "ul"
            out.write(f"<li>{_inline_md(line[2:])}</li>\n")
            continue
        if line[:3].isdigit() and line[2:4] == ". ":
            # rough numbered list
            flush_para()
            if not in_list or list_kind != "ol":
                flush_list()
                out.write("<ol>\n")
                in_list = True
                list_kind = "ol"
            out.write(f"<li>{_inline_md(line.split('. ',1)[1])}</li>\n")
            continue
        if not line.strip():
            flush_para()
            flush_list()
            continue
        para.append(line)
    flush_para()
    flush_list()
    if in_code:
        out.write("<pre><code>" + html.escape("\n".join(code_buf)) + "</code></pre>\n")
    return out.getvalue()


def _inline_md(s: str) -> str:
    s = html.escape(s, quote=False)
    # `code`
    out_parts = []
    in_code = False
    buf = ""
    for ch in s:
        if ch == "`":
            if in_code:
                out_parts.append(f"<code>{buf}</code>")
                buf = ""
            else:
                out_parts.append(buf)
                buf = ""
            in_code = not in_code
        else:
            buf += ch
    out_parts.append(buf)
    s = "".join(out_parts)
    # **bold**
    while "**" in s:
        s = s.replace("**", "<strong>", 1)
        if "**" in s:
            s = s.replace("**", "</strong>", 1)
        else:
            s += "</strong>"
            break
    return s


def _h_metadata(meta: dict) -> str:
    if not meta:
        return ""
    out = io.StringIO()
    out.write('<table class="meta"><tbody>\n')
    for k, v in meta.items():
        out.write(f"<tr><td>{_h_inline(str(k))}</td><td>{_h_inline(str(v))}</td></tr>\n")
    out.write("</tbody></table>\n")
    return out.getvalue()


def _h_block(b: dict) -> str:
    if not isinstance(b, dict):
        return ""
    kind = (b.get("kind") or "").lower()
    cap = b.get("caption")
    out = io.StringIO()
    if cap:
        out.write(f'<div class="caption">{_h_inline(str(cap))}</div>\n')
    if kind == "code":
        lang = b.get("lang") or ""
        cls = f' class="language-{_h_inline(lang)}"' if lang else ""
        out.write(f"<pre><code{cls}>{html.escape(b.get('body',''))}</code></pre>\n")
    elif kind == "mermaid":
        out.write(
            "<!-- mermaid: rendered by clients with mermaid support; otherwise shown as text -->\n"
            f'<pre class="mermaid">{html.escape(b.get("body",""))}</pre>\n'
        )
    elif kind == "table":
        headers = b.get("headers") or []
        rows = b.get("rows") or []
        out.write("<table><thead><tr>")
        for h in headers:
            out.write(f"<th>{_h_inline(str(h))}</th>")
        out.write("</tr></thead><tbody>\n")
        for row in rows:
            out.write("<tr>" + "".join(f"<td>{_h_inline(str(c))}</td>" for c in row) + "</tr>\n")
        out.write("</tbody></table>\n")
    elif kind == "callout":
        level = (b.get("level") or "info").lower()
        if level not in ("info", "warning", "danger", "success"):
            level = "info"
        out.write(f'<div class="callout {level}">{_h_para_md(b.get("body",""))}</div>\n')
    elif kind == "reference":
        ref = resolve_reference(b)
        if not ref["url"] and not ref["title"]:
            return ""
        title = _h_inline(ref["title"])
        link = f'<a href="{html.escape(ref["url"], quote=True)}" target="_blank" rel="noopener">{title}</a>' if ref["url"] else title
        why = f' — {_h_inline(ref["why"])}' if ref["why"] else ""
        out.write(f'<div class="reference">↳ Reference: {link}{why}</div>\n')
    elif kind == "insight":
        n = b.get("n") or b.get("number")
        head = f"{n}. {b.get('claim','')}" if n is not None else b.get("claim", "")
        out.write(f'<div class="insight"><h3 class="insight-claim">{_h_inline(head)}</h3>\n')
        ev = b.get("evidence")
        if ev:
            out.write(_h_para_md(str(ev)))
        for r in b.get("references") or []:
            out.write(_h_block({"kind": "reference", **r}))
        out.write("</div>\n")
    elif kind == "themed-gap":
        out.write('<div class="themed-gap">\n')
        out.write(f'<h3>{_h_inline(b.get("theme",""))}</h3>\n')
        if b.get("posture-decision"):
            out.write(_h_para_md(str(b["posture-decision"])))
        gaps = b.get("gaps") or []
        if gaps:
            out.write("<table><thead><tr><th>Gap</th><th>What it actually defends against</th></tr></thead><tbody>\n")
            for g in gaps:
                out.write(f"<tr><td>{_h_inline(g.get('name',''))}</td><td>{_h_inline(g.get('defense',''))}</td></tr>\n")
            out.write("</tbody></table>\n")
        for r in b.get("references") or []:
            out.write(_h_block({"kind": "reference", **r}))
        out.write("</div>\n")
    elif kind == "phase":
        out.write(f'<h3 class="phase">{_h_inline(b.get("id","P"))}: {_h_inline(b.get("name","Phase"))}</h3>\n')
        if b.get("goal"):
            out.write(f'<p class="phase-goal"><em>Goal:</em> {_h_inline(b["goal"])}</p>\n')
        if b.get("gating-criteria"):
            out.write(f'<p class="phase-gate"><em>Gate:</em> {_h_inline(b["gating-criteria"])}</p>\n')
    elif kind == "action":
        out.write('<div class="action">\n')
        head_extras = []
        if b.get("severity"):
            head_extras.append(f'severity: {_h_inline(b["severity"])}')
        if b.get("closes"):
            head_extras.append(f'closes {_h_inline(b["closes"])}')
        suffix = f' <span class="action-meta">({" · ".join(head_extras)})</span>' if head_extras else ""
        out.write(f'<h4>{_h_inline(b.get("id","A"))} — {_h_inline(b.get("title",""))}{suffix}</h4>\n')
        rows = []
        for k in ("devices", "prereq", "window", "rollback", "time"):
            if b.get(k):
                rows.append((k.capitalize(), b[k]))
        if rows:
            out.write('<table class="action-meta-tbl"><tbody>\n')
            for k, v in rows:
                out.write(f"<tr><td>{_h_inline(k)}</td><td>{_h_inline(str(v))}</td></tr>\n")
            out.write("</tbody></table>\n")
        if b.get("config"):
            lang = b.get("lang") or ""
            cls = f' class="language-{_h_inline(lang)}"' if lang else ""
            out.write(f'<div class="caption">Config</div>\n<pre><code{cls}>{html.escape(b["config"])}</code></pre>\n')
        if b.get("validate"):
            out.write(f'<div class="caption">Validate</div>\n<pre><code class="language-bash">{html.escape(b["validate"])}</code></pre>\n')
        for r in b.get("references") or []:
            out.write(_h_block({"kind": "reference", **r}))
        out.write("</div>\n")
    else:
        out.write(_h_para_md(str(b.get("body", ""))))
    return out.getvalue()


def render_html(doc: dict, template: str, title_override: str | None, scaffold: bool) -> str:
    out = io.StringIO()
    title = title_override or doc.get("title") or template.replace("-", " ").title()
    out.write(HTML_HEAD.format(title=_h_inline(title)))
    out.write(f"<h1>{_h_inline(title)}</h1>\n")
    if doc.get("summary"):
        out.write(f'<div class="summary">{_h_para_md(doc["summary"])}</div>\n')
    out.write(_h_metadata(doc.get("metadata") or {}))
    sections = order_sections(doc.get("sections") or [], template, scaffold)
    for s in sections:
        if not isinstance(s, dict):
            continue
        out.write(f"<h2>{_h_inline(s.get('title','Section'))}</h2>\n")
        body = s.get("body")
        if body:
            out.write(_h_para_md(str(body)))
        for blk in s.get("blocks") or []:
            out.write(_h_block(blk))
    out.write(HTML_TAIL)
    return out.getvalue()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    p = argparse.ArgumentParser(description="Render a structured investigation as a report.")
    p.add_argument("--format", choices=["markdown", "html"], default="markdown")
    p.add_argument("--template", choices=list(TEMPLATES.keys()), default="generic")
    p.add_argument("--title", default=None)
    p.add_argument("--input", default=None)
    p.add_argument("--output", default=None)
    p.add_argument("--scaffold", action="store_true", help="Emit placeholder sections from the template if missing")
    p.add_argument("--list-templates", action="store_true")
    args = p.parse_args()

    if args.list_templates:
        for name, order in TEMPLATES.items():
            print(f"{name:18s} {order}")
        return 0

    if args.input:
        with open(args.input, "r", encoding="utf-8") as fh:
            doc = json.load(fh)
    else:
        doc = json.load(sys.stdin)

    if not isinstance(doc, dict):
        raise SystemExit("error: expected a JSON object document")

    if args.format == "markdown":
        payload = render_markdown(doc, args.template, args.title, args.scaffold)
    else:
        payload = render_html(doc, args.template, args.title, args.scaffold)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as fh:
            fh.write(payload)
    else:
        sys.stdout.write(payload)
    return 0


if __name__ == "__main__":
    sys.exit(main())
