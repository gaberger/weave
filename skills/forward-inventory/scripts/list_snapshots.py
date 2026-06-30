#!/usr/bin/env python3
"""List snapshots for a Forward network."""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401 — side-effect: puts forward_client on sys.path

from forward_client import ForwardClient, ForwardError, AuthError, NotFoundError
from skill_io import emit_success, emit_error, ERR_API, ERR_AUTH, ERR_NOT_FOUND


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
    except AuthError as e:
        emit_error(ERR_AUTH, str(e), hint="check FORWARD_API_KEY / FORWARD_API_SECRET in .env")
    except NotFoundError as e:
        emit_error(ERR_NOT_FOUND, str(e), hint=f"verify network {args.network_id} with list_networks.py")
    except ForwardError as e:
        emit_error(ERR_API, str(e))

    # --latest returns a single snapshot object; emit it as-is (the answer).
    if args.latest:
        emit_success(data, meta={"network_id": args.network_id, "latest": True})

    # Otherwise the answer is the snapshots list; meta carries counts + echoed filters.
    snapshots = data.get("snapshots") if isinstance(data, dict) else data

    # --note: find snapshots by their note/annotation (case-insensitive substring).
    if args.note and isinstance(snapshots, list):
        needle = args.note.lower()
        snapshots = [s for s in snapshots if needle in str(s.get("note", "")).lower()]

    meta = {"network_id": args.network_id}
    if isinstance(snapshots, list):
        meta["count"] = len(snapshots)
    if args.note:
        meta["note_filter"] = args.note

    emit_success(snapshots, meta=meta)
    return 0


if __name__ == "__main__":
    sys.exit(main())
