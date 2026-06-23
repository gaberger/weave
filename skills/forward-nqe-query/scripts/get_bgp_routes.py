#!/usr/bin/env python3
"""Get all BGP-learned routes from the AFT (Abstract Forwarding Table).

This query retrieves routing table entries where the origin protocol is BGP.
Useful for BGP route leak detection, prefix validation, and routing analysis.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401 — side-effect: puts forward_client on sys.path

from forward_client import ForwardClient, ForwardError, emit_json, die


# NQE query to get BGP routes from AFT
BGP_ROUTES_QUERY = """
foreach device in network.devices
foreach networkInstance in device.networkInstances
let afts = networkInstance.afts
where isPresent(afts.ipv4Unicast)
foreach ipEntry in afts.ipv4Unicast.ipEntries
foreach nextHop in ipEntry.nextHops
where nextHop.originProtocol == OriginProtocol.BGP
select {
  Device: device.name,
  VRF: networkInstance.name,
  Prefix: ipEntry.prefix,
  Protocol: nextHop.originProtocol,
  "Next Hop IP": nextHop.ipAddress,
  "Next Hop Interface": nextHop.interfaceName,
  "Next Hop Type": nextHop.nextHopType
}
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--network-id", required=True, help="Network ID")
    parser.add_argument("--snapshot-id", help="Snapshot ID (default: latest processed)")
    parser.add_argument(
        "--device",
        help="Filter to specific device (post-query filter)",
    )
    parser.add_argument(
        "--vrf",
        help="Filter to specific VRF (post-query filter)",
    )
    parser.add_argument(
        "--prefix",
        help="Filter to prefixes containing this string (post-query filter)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=1000,
        help="Max results to return (default: 1000)",
    )
    args = parser.parse_args()

    client = ForwardClient.from_env()

    # Resolve snapshot ID
    if not args.snapshot_id:
        networks = client.get("/api/networks")
        net = next((n for n in networks if n["id"] == args.network_id), None)
        if not net:
            die(f"Network {args.network_id} not found")
        args.snapshot_id = str(net.get("latestProcessedSnapshotId", ""))
        if not args.snapshot_id:
            die(f"Network {args.network_id} has no processed snapshots")

    # Run NQE query
    body = {
        "snapshotId": args.snapshot_id,
        "query": BGP_ROUTES_QUERY.strip(),
        "options": {
            "offset": 0,
            "limit": args.limit,
            "itemFormat": "JSON",
        },
    }

    try:
        result = client.post("/api/nqe", body=body)
    except ForwardError as e:
        die(f"NQE query failed: {e}")

    items = result.get("items", [])

    # Post-query filtering
    if args.device:
        items = [r for r in items if r.get("Device") == args.device]
    if args.vrf:
        items = [r for r in items if r.get("VRF") == args.vrf]
    if args.prefix:
        items = [r for r in items if args.prefix in r.get("Prefix", "")]

    # Emit results
    emit_json({
        "snapshotId": args.snapshot_id,
        "totalRoutes": len(items),
        "routes": items,
    })


if __name__ == "__main__":
    main()
