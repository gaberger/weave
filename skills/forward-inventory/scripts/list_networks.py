#!/usr/bin/env python3
"""List Forward Networks networks."""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401 — side-effect: puts forward_client on sys.path

from forward_client import ForwardClient, ForwardError, emit_json, die


def main() -> int:
    p = argparse.ArgumentParser(description="List Forward networks")
    p.add_argument("--name", help="Filter by exact name (uses /api/networks?name=)")
    args = p.parse_args()

    try:
        client = ForwardClient.from_env()
        if args.name:
            data = client.get("/api/networks", query={"name": args.name})
        else:
            data = client.get("/api/networks")
    except ForwardError as e:
        die(str(e))

    emit_json(data)
    return 0


if __name__ == "__main__":
    sys.exit(main())
