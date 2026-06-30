#!/usr/bin/env python3
"""List Forward security-matrix filters defined for a network."""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401 — side-effect: puts forward_client on sys.path

from forward_client import ForwardClient, ForwardError
from skill_io import emit_success, emit_error, ERR_API


def main() -> int:
    p = argparse.ArgumentParser(description="List security-matrix filters for a Forward network")
    p.add_argument("--network-id", required=True)
    p.add_argument("--name", help="Client-side filter on filter name (case-insensitive substring)")
    args = p.parse_args()

    try:
        client = ForwardClient.from_env()
        data = client.get(f"/api/networks/{args.network_id}/securityMatrixFilters")
    except ForwardError as e:
        emit_error(ERR_API, str(e))

    filters = data.get("filters") if isinstance(data, dict) else data
    if not isinstance(filters, list):
        emit_success(data, meta={"network_id": args.network_id})
        return 0

    if args.name:
        needle = args.name.lower()
        filters = [
            f for f in filters
            if isinstance(f, dict) and needle in str(f.get("name", "")).lower()
        ]

    meta = {"count": len(filters), "network_id": args.network_id}
    if args.name:
        meta["name"] = args.name
    emit_success(filters, meta=meta)
    return 0


if __name__ == "__main__":
    sys.exit(main())
