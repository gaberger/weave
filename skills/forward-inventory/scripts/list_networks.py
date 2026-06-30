#!/usr/bin/env python3
"""List Forward Networks networks."""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401 — side-effect: puts forward_client on sys.path

from forward_client import ForwardClient, ForwardError, AuthError, NotFoundError
from skill_io import emit_success, emit_error, ERR_API, ERR_AUTH, ERR_NOT_FOUND


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
    except AuthError as e:
        emit_error(ERR_AUTH, str(e), hint="check FORWARD_API_KEY / FORWARD_API_SECRET in .env")
    except NotFoundError as e:
        emit_error(ERR_NOT_FOUND, str(e))
    except ForwardError as e:
        emit_error(ERR_API, str(e))

    meta = {"count": len(data)} if isinstance(data, list) else {}
    if args.name:
        meta["name"] = args.name
    emit_success(data, meta=meta)
    return 0


if __name__ == "__main__":
    sys.exit(main())
