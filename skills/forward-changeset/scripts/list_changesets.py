#!/usr/bin/env python3
"""List all change-sets for a Forward network.

GET /api/networks/{networkId}/change-sets

Returns ChangeSetInfo objects — each wraps a ChangeSet record plus
modifiedDeviceCount and predictedSnapshots counts.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401

from forward_client import ForwardClient, ForwardError, emit_json, die


def main() -> int:
    p = argparse.ArgumentParser(description="List change-sets for a Forward network")
    p.add_argument("--network-id", required=True)
    p.add_argument("--json", action="store_true", help="Emit raw JSON only")
    args = p.parse_args()

    try:
        client = ForwardClient.from_env()
        result = client.get(f"/api/networks/{args.network_id}/change-sets")
    except ForwardError as e:
        die(str(e))

    if args.json:
        emit_json(result)
        return 0

    if not result:
        sys.stdout.write(f"No change-sets found on network {args.network_id}.\n")
        return 0

    sys.stdout.write(f"{len(result)} change-set(s) on network {args.network_id}:\n")
    for item in result:
        cs = item.get("changeSet", item)
        cid = cs.get("id", "?")
        name = cs.get("name", "")
        base_info = cs.get("baseInfo", {})
        snap = base_info.get("snapshotId", cs.get("snapshotId", "?"))
        mdc = item.get("modifiedDeviceCount", 0)
        ps = len(item.get("predictedSnapshots") or [])
        updated = cs.get("updatedAt", cs.get("createdAt", ""))
        sys.stdout.write(
            f"  {cid:<12}  \"{name}\"  snapshot={snap}  "
            f"modified_devices={mdc}  predicted_snapshots={ps}"
            + (f"  updated={updated}" if updated else "")
            + "\n"
        )
    sys.stdout.write("\n")
    emit_json(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
