#!/usr/bin/env python3
"""List config files collected in a Forward snapshot.

Endpoint: GET /api/snapshots/{snapshotId}/files

Forward stores raw collection output per device per category. Filenames follow
``{device},{category}.txt`` — e.g. ``us-client-1,configuration.txt`` for the
running config on an IOS/EOS device.

This script lists what's available so you know which `--device` / `--category`
combinations `get_config.py` can fetch.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401 — side-effect: puts forward_client on sys.path

from forward_client import ForwardClient, ForwardError
from skill_io import emit_success, emit_error, ERR_API


def parse_filename(fname: str) -> tuple[str, str]:
    """Forward filenames are ``{device},{category}.txt``. Return (device, category).
    Handles oddball cases (no comma, multiple dots) by falling back to the whole
    filename as the device and an empty category."""
    stem = fname.rsplit(".", 1)[0] if "." in fname else fname
    if "," in stem:
        device, _, category = stem.partition(",")
        return device, category
    return stem, ""


def main() -> int:
    p = argparse.ArgumentParser(
        description="List config files in a Forward snapshot",
    )
    p.add_argument("--snapshot-id", required=True)
    p.add_argument("--device", help="Case-insensitive substring filter on device name")
    p.add_argument(
        "--category",
        help="Filter by category (e.g. 'configuration', 'version'). "
             "Default shows all; most users want 'configuration'.",
    )
    p.add_argument("--limit", type=int, default=0,
                   help="Cap rows returned (0 = no cap)")
    args = p.parse_args()

    try:
        client = ForwardClient.from_env()
        data = client.get(f"/api/snapshots/{args.snapshot_id}/files")
    except ForwardError as e:
        emit_error(ERR_API, str(e))

    # Forward usually returns {"files": [...]} or a bare list. Handle both.
    if isinstance(data, dict):
        files = data.get("files") or data.get("items") or []
    elif isinstance(data, list):
        files = data
    else:
        emit_error(ERR_API, f"unexpected response shape: {type(data).__name__}")

    rows = []
    for f in files:
        if isinstance(f, str):
            fname, size = f, None
        elif isinstance(f, dict):
            fname = f.get("name") or f.get("fileName") or f.get("file") or ""
            size = f.get("size") or f.get("sizeBytes")
        else:
            continue
        if not fname:
            continue
        device, category = parse_filename(fname)
        if args.device and args.device.lower() not in device.lower():
            continue
        if args.category and args.category.lower() != category.lower():
            continue
        rows.append({
            "fileName": fname,
            "device": device,
            "category": category,
            "sizeBytes": size,
        })

    rows.sort(key=lambda r: (r["device"].lower(), r["category"].lower()))
    if args.limit:
        rows = rows[: args.limit]

    emit_success(
        rows,
        meta={
            "snapshot_id": args.snapshot_id,
            "count": len(rows),
            "device_filter": args.device,
            "category_filter": args.category,
        },
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
