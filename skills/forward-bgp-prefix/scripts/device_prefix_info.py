#!/usr/bin/env python3
"""Per-device received-advertisement view for a BGP prefix.

Endpoint: GET /api/networks/{networkId}/devices/{deviceName}
            ?view=bgp-prefix-info&prefix={cidr}

Returns, for the named device:
  {device, vendor, model,
   vrfs: [{vrf,
           recvAdvertisements: [{nexthop, outcome, originatedFrom:{device,vrf}}],
           moreSpecificInstalledRoutes: [cidr, ...]}]}

This is the per-device counterpart of search's devicesByOutcome: it shows every
advertisement the device received for the prefix and which one won.
"""
import argparse
import sys
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401

from forward_client import ForwardClient, ForwardError
from skill_io import emit_success, emit_error, ERR_API, ERR_INPUT
from _common import add_scope_args, scope_query, validate_prefix


def main() -> int:
    p = argparse.ArgumentParser(description="Device BGP-prefix-info view")
    add_scope_args(p)
    p.add_argument("--device", required=True, help="Device name, e.g. tok-br-ce")
    p.add_argument("--prefix", required=True, help="CIDR, e.g. 10.24.0.0/24")
    args = p.parse_args()

    try:
        prefix = validate_prefix(args.prefix)
    except ForwardError as e:
        emit_error(ERR_INPUT, str(e))

    try:
        client = ForwardClient.from_env()
        q = scope_query(args)
        q["view"] = "bgp-prefix-info"
        q["prefix"] = prefix
        device = urllib.parse.quote(args.device, safe="")
        result = client.get(f"/api/networks/{args.network_id}/devices/{device}", query=q)
    except ForwardError as e:
        emit_error(ERR_API, str(e))

    emit_success(
        result,
        meta={
            "network_id": args.network_id,
            "snapshot_id": args.snapshot_id,
            "device": args.device,
            "prefix": prefix,
        },
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
