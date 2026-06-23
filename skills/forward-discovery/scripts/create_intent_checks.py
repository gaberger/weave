#!/usr/bin/env python3
"""
Intent Check Creation - Discovery Tool #8

After fixing a network issue, create Forward intent checks to prevent regression.

This is the "close the loop" step:
1. Discover issue (pre-flight discovery)
2. Fix issue (validated with validate_all.py)
3. CREATE CHECKS to prevent recurrence (this tool)

Use when:
- You just fixed a route leak → Create isolation checks
- You just activated a link → Create existential check
- You just added BGP session → Create session health check
- You just changed policy → Create policy compliance check

Would have prevented:
- Route leak regression (if isolation checks existed from day 1)
- Dark link re-appearing (if existential check existed)
- Route-map removal (if policy check existed)
"""

import sys
import os
import json
import argparse
from typing import Dict, List, Any, Optional
from pathlib import Path

# Add parent directories to path for imports
SCRIPT_DIR = Path(__file__).parent
SKILL_ROOT = SCRIPT_DIR.parent
SKILLS_ROOT = SKILL_ROOT.parent
sys.path.insert(0, str(SKILLS_ROOT / "forward-intent-check" / "scripts"))
sys.path.insert(0, str(SKILLS_ROOT / "forward-nqe-query" / "scripts"))

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401 — puts local _shared/forward_client on sys.path
from forward_client import ForwardClient


# Check templates for common scenarios
CHECK_TEMPLATES = {
    "route_leak_isolation": {
        "type": "Isolation",
        "priority": "HIGH",
        "description": "Prevents route leaks between regions by verifying specific prefixes are blocked"
    },
    "bgp_session_existential": {
        "type": "Existential",
        "priority": "MEDIUM",
        "description": "Verifies BGP peering connectivity (TCP 179) between border routers"
    },
    "intra_region_existential": {
        "type": "Existential",
        "priority": "MEDIUM",
        "description": "Verifies within-region connectivity (clients can reach services)"
    },
    "link_activation_existential": {
        "type": "Existential",
        "priority": "MEDIUM",
        "description": "Verifies newly activated link provides reachability"
    }
}


def create_check(
    client: ForwardClient,
    network_id: int,
    check_type: str,
    name: str,
    src_ip: str,
    dst_ip: str,
    priority: str = "MEDIUM",
    ip_proto: str = None,
    src_port: int = None,
    dst_port: int = None,
    note: str = None,
    snapshot_id: int = None
) -> Dict[str, Any]:
    """
    Create a Forward Networks intent check.

    Args:
        check_type: "Isolation" or "Existential"
        name: Human-readable check name
        src_ip: Source IP or CIDR
        dst_ip: Destination IP or CIDR
        priority: "HIGH", "MEDIUM", or "LOW"
        ip_proto: Protocol (tcp, udp, icmp, etc.)
        src_port: Source port number
        dst_port: Destination port number
        note: Documentation/reason for check
        snapshot_id: Snapshot to evaluate against (default: latest processed)
    """
    print(f"Creating {check_type} check: {name}...", file=sys.stderr)

    check_data = {
        "networkId": network_id,
        "checkType": check_type,
        "name": name,
        "srcIp": src_ip,
        "dstIp": dst_ip,
        "priority": priority,
        "persistent": True,  # Auto-evaluate on future snapshots
    }

    if ip_proto:
        check_data["ipProto"] = ip_proto
    if src_port:
        check_data["srcPort"] = src_port
    if dst_port:
        check_data["dstPort"] = dst_port
    if note:
        check_data["note"] = note
    if snapshot_id:
        check_data["snapshotId"] = snapshot_id

    try:
        result = client.create_intent_check(check_data)
        print(f"  ✅ Created check ID: {result.get('checkId')}", file=sys.stderr)
        return result
    except Exception as e:
        print(f"  ❌ Failed to create check: {e}", file=sys.stderr)
        return {"error": str(e)}


def create_route_leak_prevention_checks(
    client: ForwardClient,
    network_id: int,
    regions: Dict[str, Dict[str, str]],
    snapshot_id: int = None
) -> List[Dict[str, Any]]:
    """
    Create comprehensive route leak prevention checks between regions.

    regions format:
    {
        "US": {"loopbacks": "1.1.1.0/24", "internal": "10.200.0.0/16"},
        "EU": {"loopbacks": "2.2.2.0/24", "internal": "10.201.0.0/16"},
        ...
    }
    """
    checks_created = []

    region_names = list(regions.keys())

    print(f"\n🛡️  Creating route leak prevention checks...", file=sys.stderr)
    print(f"   Regions: {', '.join(region_names)}", file=sys.stderr)

    # Create isolation checks: every region to every other region
    for src_region in region_names:
        for dst_region in region_names:
            if src_region == dst_region:
                continue  # Skip within-region (allowed)

            src_prefixes = regions[src_region]
            dst_prefixes = regions[dst_region]

            # Block source loopbacks from reaching destination internal
            check = create_check(
                client=client,
                network_id=network_id,
                check_type="Isolation",
                name=f"{src_region} loopbacks → {dst_region} isolation",
                src_ip=src_prefixes.get("loopbacks", ""),
                dst_ip=dst_prefixes.get("internal", ""),
                priority="HIGH",
                note=f"Prevent {src_region} loopback route leaks to {dst_region} region",
                snapshot_id=snapshot_id
            )
            checks_created.append(check)

            # Block source internal from reaching destination internal
            if src_prefixes.get("internal") and dst_prefixes.get("internal"):
                check = create_check(
                    client=client,
                    network_id=network_id,
                    check_type="Isolation",
                    name=f"{src_region} internal → {dst_region} isolation",
                    src_ip=src_prefixes["internal"],
                    dst_ip=dst_prefixes["internal"],
                    priority="HIGH",
                    note=f"Prevent {src_region} internal prefix route leaks to {dst_region}",
                    snapshot_id=snapshot_id
                )
                checks_created.append(check)

    return checks_created


def create_bgp_session_checks(
    client: ForwardClient,
    network_id: int,
    border_routers: Dict[str, str],
    snapshot_id: int = None
) -> List[Dict[str, Any]]:
    """
    Create existential checks for BGP session connectivity.

    border_routers format:
    {
        "us-border-1": "1.1.1.1",
        "eu-border-1": "2.2.2.1",
        ...
    }
    """
    checks_created = []

    print(f"\n🔗 Creating BGP session connectivity checks...", file=sys.stderr)

    router_names = list(border_routers.keys())

    # Create checks for every border pair (full mesh)
    for i, src_router in enumerate(router_names):
        for dst_router in router_names[i+1:]:
            src_ip = border_routers[src_router]
            dst_ip = border_routers[dst_router]

            # Bidirectional checks
            for src, dst, src_name, dst_name in [
                (src_ip, dst_ip, src_router, dst_router),
                (dst_ip, src_ip, dst_router, src_router)
            ]:
                check = create_check(
                    client=client,
                    network_id=network_id,
                    check_type="Existential",
                    name=f"{src_name} → {dst_name} BGP session",
                    src_ip=src,
                    dst_ip=dst,
                    ip_proto="tcp",
                    dst_port=179,
                    priority="MEDIUM",
                    note=f"Verify {src_name} can reach {dst_name} for eBGP peering",
                    snapshot_id=snapshot_id
                )
                checks_created.append(check)

    return checks_created


def create_intra_region_checks(
    client: ForwardClient,
    network_id: int,
    regions: Dict[str, Dict[str, str]],
    snapshot_id: int = None
) -> List[Dict[str, Any]]:
    """
    Create existential checks for within-region connectivity.

    regions format:
    {
        "US": {"clients": "10.200.1.0/24", "services": "10.200.0.0/24"},
        ...
    }
    """
    checks_created = []

    print(f"\n🏠 Creating intra-region connectivity checks...", file=sys.stderr)

    for region_name, prefixes in regions.items():
        if prefixes.get("clients") and prefixes.get("services"):
            check = create_check(
                client=client,
                network_id=network_id,
                check_type="Existential",
                name=f"{region_name} clients → services",
                src_ip=prefixes["clients"],
                dst_ip=prefixes["services"],
                priority="MEDIUM",
                note=f"Verify {region_name} internal connectivity (clients can reach services)",
                snapshot_id=snapshot_id
            )
            checks_created.append(check)

    return checks_created


def print_summary(checks: List[Dict[str, Any]]):
    """Print summary of created checks."""
    successful = [c for c in checks if not c.get("error")]
    failed = [c for c in checks if c.get("error")]

    print(f"\n{'='*80}")
    print(f"INTENT CHECK CREATION SUMMARY")
    print(f"{'='*80}\n")

    print(f"📊 Total Checks: {len(checks)}")
    print(f"   ✅ Created: {len(successful)}")
    print(f"   ❌ Failed: {len(failed)}\n")

    if successful:
        print(f"{'─'*80}")
        print("CREATED CHECKS")
        print(f"{'─'*80}\n")
        for check in successful:
            check_id = check.get("checkId", "N/A")
            check_name = check.get("name", "N/A")
            check_type = check.get("checkType", "N/A")
            print(f"  {check_type:12s} {check_id:40s} {check_name}")

    if failed:
        print(f"\n{'─'*80}")
        print("FAILED CHECKS")
        print(f"{'─'*80}\n")
        for check in failed:
            print(f"  ❌ {check.get('name', 'Unknown')}")
            print(f"     Error: {check.get('error')}")

    print(f"\n{'─'*80}")
    print("NEXT STEPS")
    print(f"{'─'*80}\n")
    print("  1. List all checks:")
    print("     python3 forward-intent-check/list_checks.py --network-id <id>")
    print("\n  2. Verify all checks pass:")
    print("     python3 forward-intent-check/list_checks.py --network-id <id> --status PASS")
    print("\n  3. Check for failures:")
    print("     python3 forward-intent-check/list_checks.py --network-id <id> --status FAIL")
    print()


def main():
    parser = argparse.ArgumentParser(
        description="Create Forward Networks intent checks to prevent issue regression",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Quick start - comprehensive route leak prevention
  %(prog)s --network-id 863 --preset route-leak-prevention --config regions.json

  # BGP session connectivity checks
  %(prog)s --network-id 863 --preset bgp-sessions --config border-routers.json

  # Custom check
  %(prog)s --network-id 863 --type Isolation --name "US→EU isolation" \\
    --src-ip 10.200.0.0/16 --dst-ip 10.201.0.0/16 --priority HIGH

Presets:
  route-leak-prevention: Creates isolation checks between regions
  bgp-sessions: Creates existential checks for BGP peering
  intra-region: Creates existential checks for within-region connectivity

Config file format (JSON):
  For route-leak-prevention:
  {
    "US": {"loopbacks": "1.1.1.0/24", "internal": "10.200.0.0/16"},
    "EU": {"loopbacks": "2.2.2.0/24", "internal": "10.201.0.0/16"}
  }

  For bgp-sessions:
  {
    "us-border-1": "1.1.1.1",
    "eu-border-1": "2.2.2.1"
  }

Why this matters:
  Intent checks are Forward's continuous monitoring system. They re-evaluate on
  EVERY snapshot, alerting when policy violations occur. Creating checks after
  fixing an issue prevents regression.

Integration with forward-discovery:
  1. Run preflight_check.py (discover issue)
  2. Fix issue
  3. Run validate_all.py (verify fix)
  4. Run THIS TOOL (prevent regression)
        """
    )

    parser.add_argument(
        "--network-id",
        type=int,
        required=True,
        help="Forward Networks network ID"
    )

    parser.add_argument(
        "--snapshot-id",
        type=int,
        help="Snapshot ID to evaluate against (default: latest processed)"
    )

    parser.add_argument(
        "--preset",
        choices=["route-leak-prevention", "bgp-sessions", "intra-region"],
        help="Use preset check template"
    )

    parser.add_argument(
        "--config",
        type=str,
        help="JSON config file for preset (regions, border routers, etc.)"
    )

    # Single check creation
    parser.add_argument(
        "--type",
        choices=["Isolation", "Existential"],
        help="Check type (required for single check creation)"
    )

    parser.add_argument(
        "--name",
        type=str,
        help="Check name (required for single check creation)"
    )

    parser.add_argument(
        "--src-ip",
        type=str,
        help="Source IP or CIDR"
    )

    parser.add_argument(
        "--dst-ip",
        type=str,
        help="Destination IP or CIDR"
    )

    parser.add_argument(
        "--priority",
        choices=["HIGH", "MEDIUM", "LOW"],
        default="MEDIUM",
        help="Check priority (default: MEDIUM)"
    )

    parser.add_argument(
        "--ip-proto",
        type=str,
        help="IP protocol (tcp, udp, icmp, etc.)"
    )

    parser.add_argument(
        "--src-port",
        type=int,
        help="Source port number"
    )

    parser.add_argument(
        "--dst-port",
        type=int,
        help="Destination port number"
    )

    parser.add_argument(
        "--note",
        type=str,
        help="Documentation/reason for check"
    )

    args = parser.parse_args()

    # Initialize client
    client = ForwardClient.from_env()

    checks_created = []

    # Preset mode
    if args.preset:
        if not args.config:
            print("❌ --config required when using --preset", file=sys.stderr)
            sys.exit(1)

        config_path = Path(args.config)
        if not config_path.exists():
            print(f"❌ Config file not found: {config_path}", file=sys.stderr)
            sys.exit(1)

        with open(config_path) as f:
            config = json.load(f)

        if args.preset == "route-leak-prevention":
            checks_created = create_route_leak_prevention_checks(
                client, args.network_id, config, args.snapshot_id
            )

        elif args.preset == "bgp-sessions":
            checks_created = create_bgp_session_checks(
                client, args.network_id, config, args.snapshot_id
            )

        elif args.preset == "intra-region":
            checks_created = create_intra_region_checks(
                client, args.network_id, config, args.snapshot_id
            )

    # Single check mode
    elif args.type and args.name and args.src_ip and args.dst_ip:
        check = create_check(
            client=client,
            network_id=args.network_id,
            check_type=args.type,
            name=args.name,
            src_ip=args.src_ip,
            dst_ip=args.dst_ip,
            priority=args.priority,
            ip_proto=args.ip_proto,
            src_port=args.src_port,
            dst_port=args.dst_port,
            note=args.note,
            snapshot_id=args.snapshot_id
        )
        checks_created = [check]

    else:
        print("❌ Must provide either --preset + --config OR (--type + --name + --src-ip + --dst-ip)", file=sys.stderr)
        print("   Run with --help for examples", file=sys.stderr)
        sys.exit(1)

    # Print summary
    print_summary(checks_created)

    # Exit with error if any failed
    failed_count = sum(1 for c in checks_created if c.get("error"))
    sys.exit(1 if failed_count > 0 else 0)


if __name__ == "__main__":
    main()
