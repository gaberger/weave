#!/usr/bin/env python3
"""Validate BGP next-hop reachability.

Detects BGP routes where the next-hop IP is not reachable via the routing table.
This catches issues like:
- OSPF distribute-list blocking next-hop routes
- Route-maps filtering IGP advertisements
- Missing static routes to next-hops
- Next-hop in unreachable subnet

Common failure pattern (Scenario 2):
1. BGP learns routes with next-hop X.X.X.X
2. IGP (OSPF/EIGRP/ISIS) should advertise route to X.X.X.X
3. Route filter blocks the IGP advertisement
4. Next-hop is unreachable, BGP route is unusable (BLACKHOLE)
"""
import argparse
import sys
from pathlib import Path
from ipaddress import ip_address, ip_network

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401 — side-effect: puts forward_client on sys.path

from forward_client import ForwardClient, ForwardError, emit_json, die


# Query to get BGP routes with next-hops
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
  "Next Hop IP": nextHop.ipAddress,
  "Next Hop Interface": nextHop.interfaceName,
  "Next Hop Type": nextHop.nextHopType
}
"""

# Query to get all routes in routing table (any protocol)
ROUTING_TABLE_QUERY = """
foreach device in network.devices
foreach networkInstance in device.networkInstances
let afts = networkInstance.afts
where isPresent(afts.ipv4Unicast)
foreach ipEntry in afts.ipv4Unicast.ipEntries
select {
  Device: device.name,
  VRF: networkInstance.name,
  Prefix: ipEntry.prefix
}
"""


def is_ip_in_prefix(ip_str, prefix_str):
    """Check if an IP address is within a prefix."""
    try:
        ip = ip_address(ip_str)
        network = ip_network(prefix_str, strict=False)
        return ip in network
    except Exception:
        return False


def check_nexthop_reachable(nexthop_ip, routing_table, device_name, vrf_name):
    """
    Check if a next-hop IP is reachable by finding a matching route in the routing table.

    Returns: (is_reachable, matching_prefix or None)
    """
    # Filter routing table to this device/VRF
    relevant_routes = [
        r for r in routing_table
        if r.get("Device") == device_name and r.get("VRF") == vrf_name
    ]

    # Check if any prefix in the routing table covers this next-hop
    for route in relevant_routes:
        prefix = route.get("Prefix")
        if prefix and is_ip_in_prefix(nexthop_ip, prefix):
            return True, prefix

    return False, None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--network-id", required=True, help="Network ID")
    parser.add_argument("--snapshot-id", help="Snapshot ID (default: latest processed)")
    parser.add_argument(
        "--device",
        help="Filter to specific device",
    )
    parser.add_argument(
        "--vrf",
        help="Filter to specific VRF",
    )
    parser.add_argument(
        "--show-all",
        action="store_true",
        help="Show all routes (including reachable next-hops), not just problems",
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

    print("Step 1: Fetching BGP routes with next-hops...", file=sys.stderr)

    # Get BGP routes
    bgp_body = {
        "snapshotId": args.snapshot_id,
        "query": BGP_ROUTES_QUERY.strip(),
        "options": {
            "offset": 0,
            "limit": 5000,
            "itemFormat": "JSON",
        },
    }

    try:
        bgp_result = client.post("/api/nqe", body=bgp_body)
    except ForwardError as e:
        die(f"BGP routes query failed: {e}")

    bgp_routes = bgp_result.get("items", [])

    # Apply filters
    if args.device:
        bgp_routes = [r for r in bgp_routes if r.get("Device") == args.device]
    if args.vrf:
        bgp_routes = [r for r in bgp_routes if r.get("VRF") == args.vrf]

    print(f"Found {len(bgp_routes)} BGP routes", file=sys.stderr)

    print("Step 2: Fetching routing table for reachability check...", file=sys.stderr)

    # Get routing table
    rt_body = {
        "snapshotId": args.snapshot_id,
        "query": ROUTING_TABLE_QUERY.strip(),
        "options": {
            "offset": 0,
            "limit": 10000,
            "itemFormat": "JSON",
        },
    }

    try:
        rt_result = client.post("/api/nqe", body=rt_body)
    except ForwardError as e:
        die(f"Routing table query failed: {e}")

    routing_table = rt_result.get("items", [])

    print(f"Found {len(routing_table)} routing table entries", file=sys.stderr)
    print("Step 3: Validating next-hop reachability...", file=sys.stderr)

    # Validate each BGP route's next-hop
    results = []
    for route in bgp_routes:
        nexthop_ip = route.get("Next Hop IP")
        device = route.get("Device")
        vrf = route.get("VRF")

        if not nexthop_ip or nexthop_ip == "0.0.0.0":
            # Skip invalid next-hops
            continue

        is_reachable, matching_prefix = check_nexthop_reachable(
            nexthop_ip, routing_table, device, vrf
        )

        result = {
            "Device": device,
            "VRF": vrf,
            "BGP Prefix": route.get("Prefix"),
            "Next Hop IP": nexthop_ip,
            "Next Hop Interface": route.get("Next Hop Interface"),
            "Next Hop Type": route.get("Next Hop Type"),
            "Reachable": is_reachable,
            "Covering Route": matching_prefix if is_reachable else None,
            "Issue": None if is_reachable else "UNREACHABLE_NEXTHOP",
        }

        # Filter output unless --show-all
        if args.show_all or not is_reachable:
            results.append(result)

    # Count issues
    unreachable_count = len([r for r in results if not r["Reachable"]])

    print(f"\nValidation complete: {unreachable_count} unreachable next-hops found", file=sys.stderr)

    # Emit results
    output = {
        "snapshotId": args.snapshot_id,
        "totalBgpRoutes": len(bgp_routes),
        "unreachableNextHops": unreachable_count,
        "results": results,
    }

    emit_json(output)


if __name__ == "__main__":
    main()
