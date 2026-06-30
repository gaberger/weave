#!/usr/bin/env python3
"""Search where a BGP prefix lives across a Forward-modeled network.

Endpoint: POST /api/networks/{networkId}/bgp-prefix-search

Returns:
  - origin:           [BgpNodeInfo]                  — device(s) that originate it
  - devicesByOutcome: {OUTCOME: [BgpNodeInfo]}       — every device that received
                                                       it, bucketed by RIB outcome
                                                       (INSTALLED / NOT_PREFERRED /
                                                       FILTERED_OUT)
BgpNodeInfo = {device, vrf, locationId, routerId}.
This is the entry point for the other three scripts.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401

from forward_client import ForwardClient, ForwardError
from skill_io import emit_success, emit_error, ERR_API, ERR_INPUT
from _common import add_scope_args, scope_query, validate_prefix, search


def main() -> int:
    p = argparse.ArgumentParser(description="Search a BGP prefix across the network")
    add_scope_args(p)
    p.add_argument("--prefix", required=True, help="CIDR, e.g. 10.24.0.0/24")
    args = p.parse_args()

    try:
        prefix = validate_prefix(args.prefix)
    except ForwardError as e:
        emit_error(ERR_INPUT, str(e))

    try:
        client = ForwardClient.from_env()
        result = search(client, args.network_id, prefix, scope_query(args))
    except ForwardError as e:
        emit_error(ERR_API, str(e))

    by_outcome = result.get("devicesByOutcome", {}) or {}
    emit_success(
        result,
        meta={
            "network_id": args.network_id,
            "snapshot_id": args.snapshot_id,
            "prefix": prefix,
            "origin_count": len(result.get("origin", []) or []),
            "received_by_outcome": {k: len(v or []) for k, v in by_outcome.items()},
        },
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
