#!/usr/bin/env python3
"""Fetch raw device config/collection text from a Forward snapshot.

Endpoint: GET /api/snapshots/{snapshotId}/files/{filename}

Filenames follow ``{device},{category}.txt`` — e.g.
``us-client-1,configuration.txt``. Build one from ``--device`` + ``--category``
(default ``configuration``), or pass ``--file-name`` verbatim.

Format handling (auto-detected, overridable with ``--format``):

  - ``cisco``  : Cisco / Arista / ASA / HP / NX-OS — indent-based stanzas
  - ``junos``  : Juniper Junos — curly-brace nested stanzas
  - ``xml``    : PAN-OS / NX-API exports — XML document, XPath extraction

Selectors:

  - ``--stanza REGEX`` works for ``cisco`` and ``junos``; extracts one or more
    blocks whose header line matches the regex.
  - ``--xpath EXPR`` works for ``xml``; accepts Python ElementTree XPath (most
    common tests like ``//entry[@name='x']`` work).

Without a selector, the full file is returned (truncated to ``--max-lines``).
"""
from __future__ import annotations

import argparse
import re
import sys
import urllib.parse
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import List

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401 — side-effect: puts forward_client on sys.path

from forward_client import ForwardClient, ForwardError, die


# ---------- format detection ----------

def detect_format(text: str) -> str:
    """Classify a config blob as cisco (indent), junos (curly), or xml."""
    stripped = text.lstrip()
    if not stripped:
        return "cisco"
    if stripped.startswith("<?xml") or stripped.startswith("<"):
        return "xml"
    # Junos signature: a line ending in ``{`` (possibly with trailing whitespace)
    # within the first 200 lines. Indent-based configs do not have that shape.
    head = "\n".join(stripped.splitlines()[:200])
    if re.search(r"^\S.*\{\s*$", head, re.MULTILINE):
        return "junos"
    return "cisco"


# ---------- Cisco / indent-based extraction ----------

def indent_of(line: str) -> int:
    """Leading-whitespace count, treating tabs as 8 columns."""
    expanded = line.expandtabs(8)
    return len(expanded) - len(expanded.lstrip())


def extract_cisco_stanzas(text: str, pattern: str) -> List[str]:
    """Return all indent-based stanzas whose header line matches ``pattern``."""
    rx = _compile(pattern)
    lines = text.splitlines()
    out: List[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if rx.search(line):
            header_indent = indent_of(line)
            block = [line]
            i += 1
            while i < len(lines):
                nxt = lines[i]
                if not nxt.strip():
                    # Keep blank lines only if a deeper-indented line follows.
                    j = i + 1
                    while j < len(lines) and not lines[j].strip():
                        j += 1
                    if j < len(lines) and indent_of(lines[j]) > header_indent:
                        block.append(nxt)
                        i += 1
                        continue
                    break
                if indent_of(nxt) <= header_indent:
                    break
                block.append(nxt)
                i += 1
            while block and not block[-1].strip():
                block.pop()
            out.append("\n".join(block))
        else:
            i += 1
    return out


# ---------- Junos / curly-brace extraction ----------

def extract_junos_stanzas(text: str, pattern: str) -> List[str]:
    """Return all curly-brace stanzas whose header line matches ``pattern``.

    A header line is any line ending in ``{``. From the header, we track brace
    depth (ignoring strings naively — Junos configs don't embed braces in quoted
    values often enough to matter) until depth returns to zero.
    """
    rx = _compile(pattern)
    lines = text.splitlines()
    out: List[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.rstrip().endswith("{") and rx.search(line):
            block = [line]
            depth = 1
            i += 1
            while i < len(lines) and depth > 0:
                nxt = lines[i]
                depth += nxt.count("{") - nxt.count("}")
                block.append(nxt)
                i += 1
            out.append("\n".join(block))
        else:
            i += 1
    return out


# ---------- XML / XPath extraction ----------

def extract_xml(text: str, xpath: str) -> List[str]:
    """Return pretty-printed XML elements matching ``xpath``."""
    try:
        root = ET.fromstring(text)
    except ET.ParseError as e:
        die(f"not valid XML: {e}")

    try:
        elements = root.findall(xpath)
    except SyntaxError as e:
        die(f"invalid xpath {xpath!r}: {e}")

    out: List[str] = []
    for el in elements:
        try:
            ET.indent(el, space="  ")
        except AttributeError:
            pass  # Python < 3.9
        out.append(ET.tostring(el, encoding="unicode"))
    return out


# ---------- helpers ----------

def _compile(pattern: str) -> re.Pattern:
    try:
        return re.compile(pattern)
    except re.error as e:
        die(f"invalid regex {pattern!r}: {e}")


def main() -> int:
    p = argparse.ArgumentParser(description="Fetch a device config file from a Forward snapshot")
    p.add_argument("--snapshot-id", required=True)

    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--device", help="Device name (combined with --category)")
    src.add_argument("--file-name", help="Exact file name (e.g. 'sw1,configuration.txt')")

    p.add_argument("--category", default="configuration",
                   help="File category when using --device (default 'configuration')")
    p.add_argument("--format", choices=("auto", "cisco", "junos", "xml"), default="auto",
                   help="Override format detection")

    sel = p.add_mutually_exclusive_group()
    sel.add_argument("--stanza", metavar="REGEX",
                     help="Extract stanzas (cisco/junos) whose header matches REGEX")
    sel.add_argument("--xpath", metavar="EXPR",
                     help="Extract XML elements matching XPath (xml format)")

    p.add_argument("--max-lines", type=int, default=200,
                   help="Truncate full-file output (default 200; 0 = no truncation). "
                        "Ignored when --stanza/--xpath is set.")
    args = p.parse_args()

    file_name = args.file_name or f"{args.device},{args.category}.txt"
    url_path = (
        f"/api/snapshots/{urllib.parse.quote(args.snapshot_id, safe='')}"
        f"/files/{urllib.parse.quote(file_name, safe=',')}"
    )

    try:
        client = ForwardClient.from_env()
        text = client.get_text(url_path)
    except ForwardError as e:
        die(str(e))

    if not text:
        print(f"# empty file: {file_name}", file=sys.stderr)
        return 0

    fmt = args.format if args.format != "auto" else detect_format(text)

    # Selector validation
    if args.xpath and fmt != "xml":
        die(f"--xpath requires --format xml (detected: {fmt}); "
            f"use --stanza for cisco/junos")
    if args.stanza and fmt == "xml":
        die(f"--stanza does not work on xml; use --xpath")

    if args.stanza:
        blocks = (
            extract_junos_stanzas(text, args.stanza) if fmt == "junos"
            else extract_cisco_stanzas(text, args.stanza)
        )
        if not blocks:
            print(f"# no stanzas matched /{args.stanza}/ in {file_name} ({fmt})", file=sys.stderr)
            return 0
        sys.stdout.write("\n\n".join(blocks))
        sys.stdout.write("\n")
        return 0

    if args.xpath:
        elements = extract_xml(text, args.xpath)
        if not elements:
            print(f"# xpath {args.xpath!r} matched zero elements in {file_name}", file=sys.stderr)
            return 0
        sys.stdout.write("\n\n".join(elements))
        sys.stdout.write("\n")
        return 0

    # Full file (possibly truncated)
    lines = text.splitlines()
    total = len(lines)
    print(f"# format: {fmt}  lines: {total}  file: {file_name}", file=sys.stderr)
    if args.max_lines and total > args.max_lines:
        head = lines[: args.max_lines]
        sys.stdout.write("\n".join(head))
        sys.stdout.write(
            f"\n\n# ... truncated at --max-lines={args.max_lines}; "
            f"{total - args.max_lines} more lines. Rerun with --max-lines 0 for full.\n"
        )
    else:
        sys.stdout.write(text if text.endswith("\n") else text + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
