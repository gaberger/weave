#!/usr/bin/env python3
"""Regex-search across every device config in a Forward snapshot.

Workflow:
  1. ``GET /api/snapshots/{id}/files`` to enumerate files
  2. Filter to ``{category}.txt`` (default ``configuration``), optionally
     narrowed to a device-name substring
  3. Fetch each file and scan for ``--pattern`` matches with configurable
     context lines

Emits JSON to stdout:

    {
      "snapshotId": "...",
      "pattern": "...",
      "category": "configuration",
      "devicesSearched": 12,
      "devicesWithMatches": 4,
      "matchCount": 17,
      "matches": [
        {"device": "sw1", "line": 142, "match": "...", "context": ["...", "..."]}
      ]
    }

Warns to stderr before fetching if the device count exceeds ``--warn-at``
(default 20). Each fetch is a separate API call — large snapshots (hundreds
of devices) can take minutes.
"""
from __future__ import annotations

import argparse
import re
import sys
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401 — side-effect: puts forward_client on sys.path

from forward_client import ForwardClient, ForwardError, emit_json, die


def main() -> int:
    p = argparse.ArgumentParser(description="Regex-search all device configs in a snapshot")
    p.add_argument("--snapshot-id", required=True)
    p.add_argument("--pattern", required=True, help="Python regex (not grep syntax)")
    p.add_argument("--device", help="Substring filter on device name (case-insensitive)")
    p.add_argument("--category", default="configuration",
                   help="File category (default 'configuration')")
    p.add_argument("--context", type=int, default=0,
                   help="Lines of context before and after each match (default 0)")
    p.add_argument("--ignore-case", action="store_true",
                   help="Case-insensitive match")
    p.add_argument("--max-matches-per-device", type=int, default=20,
                   help="Cap matches reported per device (default 20; 0 = no cap)")
    p.add_argument("--warn-at", type=int, default=20,
                   help="Emit stderr warning if device count > this (default 20)")
    args = p.parse_args()

    try:
        rx = re.compile(args.pattern, re.IGNORECASE if args.ignore_case else 0)
    except re.error as e:
        die(f"invalid --pattern regex: {e}")

    try:
        client = ForwardClient.from_env()
        listing = client.get(f"/api/snapshots/{args.snapshot_id}/files")
    except ForwardError as e:
        die(str(e))

    files_raw = (
        listing.get("files") or listing.get("items") or []
    ) if isinstance(listing, dict) else (
        listing if isinstance(listing, list) else []
    )

    targets: list[tuple[str, str]] = []  # (device, file_name)
    cat_suffix = f",{args.category}.txt"
    for f in files_raw:
        fname = f if isinstance(f, str) else (
            f.get("name") or f.get("fileName") or f.get("file") or ""
        ) if isinstance(f, dict) else ""
        if not fname or not fname.endswith(cat_suffix):
            continue
        device = fname[: -len(cat_suffix)]
        if args.device and args.device.lower() not in device.lower():
            continue
        targets.append((device, fname))

    if not targets:
        die(f"no {args.category} files matched (device filter: {args.device or 'none'})")

    if len(targets) > args.warn_at:
        sys.stderr.write(
            f"note: searching {len(targets)} devices — this is {len(targets)} API calls, "
            f"expect several minutes for large snapshots.\n"
        )

    matches: list[dict] = []
    devices_with_matches = 0

    for idx, (device, fname) in enumerate(targets, start=1):
        sys.stderr.write(f"[{idx}/{len(targets)}] {device}\n")
        url_path = (
            f"/api/snapshots/{urllib.parse.quote(args.snapshot_id, safe='')}"
            f"/files/{urllib.parse.quote(fname, safe=',')}"
        )
        try:
            text = client.get_text(url_path)
        except ForwardError as e:
            sys.stderr.write(f"  error fetching {device}: {e}\n")
            continue
        if not text:
            continue

        lines = text.splitlines()
        per_device = 0
        for lineno, line in enumerate(lines, start=1):
            m = rx.search(line)
            if not m:
                continue
            if args.max_matches_per_device and per_device >= args.max_matches_per_device:
                break
            ctx_start = max(0, lineno - 1 - args.context)
            ctx_end = min(len(lines), lineno + args.context)
            matches.append({
                "device": device,
                "line": lineno,
                "match": m.group(0),
                "text": line,
                "context": lines[ctx_start:ctx_end] if args.context else [],
            })
            per_device += 1
        if per_device:
            devices_with_matches += 1

    emit_json({
        "snapshotId": args.snapshot_id,
        "pattern": args.pattern,
        "category": args.category,
        "devicesSearched": len(targets),
        "devicesWithMatches": devices_with_matches,
        "matchCount": len(matches),
        "matches": matches,
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
