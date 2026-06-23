#!/usr/bin/env python3
"""Unified diff of the same device's config between two Forward snapshots.

Fetches ``{device},{category}.txt`` from both snapshots and emits a
GNU-style unified diff to stdout, suitable for pasting into a code block
with the ``diff`` language tag.

Exit codes:
  0 = no differences
  1 = differences found (standard ``diff`` convention)
  2 = error (missing file, API failure, etc.)
"""
from __future__ import annotations

import argparse
import difflib
import sys
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401 — side-effect: puts forward_client on sys.path

from forward_client import ForwardClient, ForwardError


def die_code(msg: str, code: int = 2) -> None:
    sys.stderr.write(f"error: {msg}\n")
    sys.exit(code)


def fetch(client: ForwardClient, snapshot_id: str, file_name: str) -> str:
    url_path = (
        f"/api/snapshots/{urllib.parse.quote(snapshot_id, safe='')}"
        f"/files/{urllib.parse.quote(file_name, safe=',')}"
    )
    return client.get_text(url_path)


def main() -> int:
    p = argparse.ArgumentParser(
        description="Unified diff of a device's config between two Forward snapshots",
    )
    p.add_argument("--snapshot-a", required=True, help="Baseline snapshot ID (older)")
    p.add_argument("--snapshot-b", required=True, help="Compare snapshot ID (newer)")

    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--device", help="Device name (combined with --category)")
    src.add_argument("--file-name", help="Exact file name (e.g. 'sw1,configuration.txt')")

    p.add_argument("--category", default="configuration",
                   help="File category when using --device (default 'configuration')")
    p.add_argument("--context", type=int, default=3,
                   help="Unified-diff context lines (default 3)")
    p.add_argument("--stat", action="store_true",
                   help="Summary only (+<added> -<removed> lines), no diff body")
    args = p.parse_args()

    file_name = args.file_name or f"{args.device},{args.category}.txt"

    try:
        client = ForwardClient.from_env()
        text_a = fetch(client, args.snapshot_a, file_name)
        text_b = fetch(client, args.snapshot_b, file_name)
    except ForwardError as e:
        die_code(str(e))

    lines_a = text_a.splitlines(keepends=False)
    lines_b = text_b.splitlines(keepends=False)

    diff_iter = difflib.unified_diff(
        lines_a,
        lines_b,
        fromfile=f"{file_name} @ {args.snapshot_a}",
        tofile=f"{file_name} @ {args.snapshot_b}",
        n=args.context,
        lineterm="",
    )
    diff_lines = list(diff_iter)

    if not diff_lines:
        sys.stderr.write(f"# no differences in {file_name} between {args.snapshot_a} and {args.snapshot_b}\n")
        return 0

    if args.stat:
        added = sum(1 for ln in diff_lines if ln.startswith("+") and not ln.startswith("+++"))
        removed = sum(1 for ln in diff_lines if ln.startswith("-") and not ln.startswith("---"))
        sys.stdout.write(
            f"{file_name}: +{added} -{removed} lines "
            f"({args.snapshot_a} → {args.snapshot_b})\n"
        )
    else:
        sys.stdout.write("\n".join(diff_lines))
        sys.stdout.write("\n")

    return 1  # differences found


if __name__ == "__main__":
    sys.exit(main())
