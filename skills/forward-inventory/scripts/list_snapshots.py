#!/usr/bin/env python3
"""List snapshots for a Forward network."""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401 — side-effect: puts forward_client on sys.path

from forward_client import ForwardClient, ForwardError, emit_json, die


def main() -> int:
    p = argparse.ArgumentParser(description="List snapshots for a Forward network")
    p.add_argument("--network-id", required=True, help="Network ID (from list_networks.py)")
    p.add_argument(
        "--latest",
        action="store_true",
        help="Return only the latest processed snapshot",
    )
    p.add_argument(
        "--note",
        help="Filter to snapshots whose note contains this text (case-insensitive)",
    )
    args = p.parse_args()

    try:
        client = ForwardClient.from_env()
        if args.latest:
            data = client.get(f"/api/networks/{args.network_id}/snapshots/latestProcessed")
        else:
            data = client.get(f"/api/networks/{args.network_id}/snapshots")
    except ForwardError as e:
        die(str(e))

    # --note: find snapshots by their note/annotation (case-insensitive substring).
    if args.note and isinstance(data, dict) and isinstance(data.get("snapshots"), list):
        needle = args.note.lower()
        matches = [s for s in data["snapshots"] if needle in str(s.get("note", "")).lower()]
        data = {**{k: v for k, v in data.items() if k != "snapshots"}, "snapshots": matches,
                "noteFilter": args.note, "matchCount": len(matches)}

    emit_json(data)
    return 0


if __name__ == "__main__":
    sys.exit(main())
