#!/usr/bin/env python3
"""Best-path attributes + import/export policies for a prefix on one node.

Endpoint: POST /api/networks/{networkId}/bgp-prefix-details

Body: {prefix, node: BgpNodeInfo}  where node = {device, vrf, locationId,
routerId}. The full node is required — a bare {device, vrf} 500s server-side —
so this script resolves it from bgp-prefix-search given just --device[/--vrf].

Returns: {prefix, device, vrf,
          attributes: {localPref, med, aigpMetric, origin, addressFamily,
                       weight, preference, protocol},
          importPolicies: [...], exportPolicies: [...]}.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401

from forward_client import ForwardClient, ForwardError, emit_json, die
from _common import add_scope_args, scope_query, validate_prefix, resolve_node


def main() -> int:
    p = argparse.ArgumentParser(description="BGP prefix best-path details on a node")
    add_scope_args(p)
    p.add_argument("--prefix", required=True, help="CIDR, e.g. 10.24.0.0/24")
    p.add_argument("--device", required=True, help="Node device name")
    p.add_argument(
        "--vrf",
        help="VRF; disambiguator when the device carries the prefix in multiple VRFs",
    )
    args = p.parse_args()

    try:
        prefix = validate_prefix(args.prefix)
        client = ForwardClient.from_env()
        q = scope_query(args)
        node = resolve_node(client, args.network_id, prefix, args.device, args.vrf, q)
        result = client.post(
            f"/api/networks/{args.network_id}/bgp-prefix-details",
            {"prefix": prefix, "node": node},
            query=q or None,
        )
    except ForwardError as e:
        die(str(e))

    emit_json(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
