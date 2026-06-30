#!/usr/bin/env python3
"""Hop-by-hop propagation trace of a BGP prefix from its origin to a router.

Endpoint: POST /api/networks/{networkId}/bgp-prefix-trace

Body (exactly 4 fields): {prefix,
                          router:         {device, vrf},
                          originatedFrom: {device, vrf},
                          outcome:        INSTALLED | NOT_PREFERRED | FILTERED_OUT}

`originatedFrom` is auto-resolved from bgp-prefix-search when --origin-device is
omitted (works when the prefix has a single origin; otherwise pick one).

Returns: array of propagation paths; each path is a list of hops, each hop
{device, vrf, routeSetId, asNumber, locationId, routerId, importPolicyNames?,
exportPolicyNames?} — the AS-path walk with the route-maps applied at each hop.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401

from forward_client import ForwardClient, ForwardError
from skill_io import emit_success, emit_error, ERR_API, ERR_INPUT
from _common import (
    add_scope_args,
    scope_query,
    validate_prefix,
    resolve_origin,
    OUTCOMES,
)


def main() -> int:
    p = argparse.ArgumentParser(description="Trace BGP prefix propagation to a router")
    add_scope_args(p)
    p.add_argument("--prefix", required=True, help="CIDR, e.g. 10.24.0.0/24")
    p.add_argument("--device", required=True, help="Router (receiving device) name")
    p.add_argument("--vrf", default="default", help="Router VRF (default: default)")
    p.add_argument(
        "--origin-device",
        help="Origin device; auto-resolved from search when omitted",
    )
    p.add_argument("--origin-vrf", default="default", help="Origin VRF (default: default)")
    p.add_argument(
        "--outcome",
        default="INSTALLED",
        choices=OUTCOMES,
        help="Which received advertisement to trace (default: INSTALLED)",
    )
    args = p.parse_args()

    try:
        prefix = validate_prefix(args.prefix)
    except ForwardError as e:
        emit_error(ERR_INPUT, str(e))

    try:
        client = ForwardClient.from_env()
        q = scope_query(args)
        origin = resolve_origin(
            client, args.network_id, prefix, q, args.origin_device, args.origin_vrf
        )
        body = {
            "prefix": prefix,
            "router": {"device": args.device, "vrf": args.vrf},
            "originatedFrom": origin,
            "outcome": args.outcome,
        }
        result = client.post(
            f"/api/networks/{args.network_id}/bgp-prefix-trace", body, query=q or None
        )
    except ForwardError as e:
        emit_error(ERR_API, str(e))

    # trace returns an array of propagation paths (possibly empty — a real answer)
    emit_success(
        result,
        meta={
            "network_id": args.network_id,
            "snapshot_id": args.snapshot_id,
            "prefix": prefix,
            "router": {"device": args.device, "vrf": args.vrf},
            "originated_from": origin,
            "outcome": args.outcome,
            "path_count": len(result) if isinstance(result, list) else None,
        },
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
