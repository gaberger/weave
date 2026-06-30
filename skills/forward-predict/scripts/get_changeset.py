#!/usr/bin/env python3
"""Fetch a Forward change-set (the sandbox holding Predict overrides).

Returns the change-set summary record:
  - id, name, networkId, snapshotId

Note: this Forward server only exposes view=summary, which returns minimal
metadata. Fields like deviceToChanges, addedAdvertisements, and hasConfig
are not available via the REST API on this instance.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401

from forward_client import ForwardClient, ForwardError
from skill_io import emit_error, emit_success, ERR_API


def main() -> int:
    p = argparse.ArgumentParser(description="Get a Forward change-set")
    p.add_argument("--network-id", required=True)
    p.add_argument("--changeset-id", required=True, help="e.g. CHG-7")
    args = p.parse_args()

    try:
        client = ForwardClient.from_env()
        result = client.get(
            f"/api/networks/{args.network_id}/change-sets/{args.changeset_id}",
            query={"view": "summary"},
        )
    except ForwardError as e:
        emit_error(ERR_API, str(e))

    emit_success(
        result,
        meta={"network_id": args.network_id, "changeset_id": args.changeset_id},
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
