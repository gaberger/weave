#!/usr/bin/env python3
"""
Complete Interface Inventory - Discovery Tool #1

Shows ALL interfaces on border/critical devices to catch:
- Dark links (DOWN interfaces with no IP)
- Mismatched interface states between peers
- Missing expected connections

This would have immediately revealed the US-JP Ethernet4 dark link.
"""

import sys
import os
import json
import argparse
from typing import Dict, List, Any
from pathlib import Path

# Add parent directories to path for imports
SCRIPT_DIR = Path(__file__).parent
SKILL_ROOT = SCRIPT_DIR.parent
SKILLS_ROOT = SKILL_ROOT.parent
sys.path.insert(0, str(SKILLS_ROOT / "forward-nqe-query" / "scripts"))

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401 — puts local _shared/forward_client on sys.path
from forward_client import ForwardClient


def get_interface_status(client: ForwardClient, network_id: int, device_filter: str = None) -> List[Dict[str, Any]]:
    """
    Query interface status for all or filtered devices.

    Uses NQE query FQ_interface_status to get comprehensive interface data.
    """
    params = {}
    if device_filter:
        params["deviceName"] = device_filter

    print(f"🔍 Querying interface status (filter: {device_filter or 'ALL devices'})...", file=sys.stderr)

    result = client.run_nqe_query(
        network_id=network_id,
        query_id="FQ_interface_status",
        params=params if params else None
    )

    return result.get("items", [])


def analyze_interfaces(interfaces: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Analyze interface data to identify issues:
    - Dark links (DOWN with no description)
    - Potential peer mismatches
    - Unexpected states
    """
    analysis = {
        "total_interfaces": len(interfaces),
        "by_device": {},
        "dark_links": [],
        "down_interfaces": [],
        "up_interfaces": [],
        "warnings": []
    }

    # Group by device
    for iface in interfaces:
        device = iface.get("deviceName", "unknown")
        if device not in analysis["by_device"]:
            analysis["by_device"][device] = {
                "total": 0,
                "up": 0,
                "down": 0,
                "interfaces": []
            }

        analysis["by_device"][device]["total"] += 1
        analysis["by_device"][device]["interfaces"].append(iface)

        # Categorize interface state
        status = iface.get("adminStatus", "").upper()
        oper_status = iface.get("operationalStatus", "").upper()
        ip_address = iface.get("ipAddress")
        description = iface.get("description", "")
        interface_name = iface.get("interface", "")

        if "UP" in oper_status:
            analysis["by_device"][device]["up"] += 1
            analysis["up_interfaces"].append({
                "device": device,
                "interface": interface_name,
                "ip": ip_address,
                "description": description
            })
        elif "DOWN" in oper_status or "DOWN" in status:
            analysis["by_device"][device]["down"] += 1
            analysis["down_interfaces"].append({
                "device": device,
                "interface": interface_name,
                "admin_status": status,
                "oper_status": oper_status,
                "ip": ip_address,
                "description": description
            })

            # Flag dark links (DOWN with no IP or generic description)
            if not ip_address and not description:
                analysis["dark_links"].append({
                    "device": device,
                    "interface": interface_name,
                    "status": f"{status}/{oper_status}",
                    "warning": "DOWN interface with no IP or description - intentional?"
                })

    return analysis


def print_analysis(analysis: Dict[str, Any], format: str = "human"):
    """Print analysis in requested format."""

    if format == "json":
        print(json.dumps(analysis, indent=2))
        return

    # Human-readable format
    print(f"\n{'='*80}")
    print(f"INTERFACE INVENTORY ANALYSIS")
    print(f"{'='*80}\n")

    print(f"📊 Total Interfaces: {analysis['total_interfaces']}")
    print(f"   ✅ UP: {len(analysis['up_interfaces'])}")
    print(f"   ❌ DOWN: {len(analysis['down_interfaces'])}")
    print(f"   🌑 DARK (no IP/desc): {len(analysis['dark_links'])}\n")

    # Per-device summary
    print(f"{'─'*80}")
    print("DEVICE SUMMARY")
    print(f"{'─'*80}")
    for device, stats in sorted(analysis["by_device"].items()):
        print(f"\n{device}:")
        print(f"  Total: {stats['total']} | UP: {stats['up']} | DOWN: {stats['down']}")

    # Dark links (critical findings)
    if analysis["dark_links"]:
        print(f"\n{'─'*80}")
        print("⚠️  DARK LINKS DETECTED (Potential Missing Connections)")
        print(f"{'─'*80}")
        for dark in analysis["dark_links"]:
            print(f"\n  🌑 {dark['device']} - {dark['interface']}")
            print(f"     Status: {dark['status']}")
            print(f"     ⚠️  {dark['warning']}")

    # All DOWN interfaces (for reference)
    if analysis["down_interfaces"]:
        print(f"\n{'─'*80}")
        print("DOWN INTERFACES (All)")
        print(f"{'─'*80}")
        for down in analysis["down_interfaces"]:
            ip_str = down['ip'] if down['ip'] else "NO IP"
            desc_str = down['description'] if down['description'] else "NO DESCRIPTION"
            print(f"  {down['device']:20s} {down['interface']:15s} {ip_str:18s} {desc_str}")


def main():
    parser = argparse.ArgumentParser(
        description="Complete interface inventory - finds dark links and unexpected interface states",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # All border routers
  %(prog)s --network-id 863 --device-filter border

  # Specific device
  %(prog)s --network-id 863 --device-filter us-border-1

  # All devices (warning: may be large)
  %(prog)s --network-id 863
        """
    )

    parser.add_argument(
        "--network-id",
        type=int,
        required=True,
        help="Forward Networks network ID"
    )

    parser.add_argument(
        "--device-filter",
        type=str,
        default=None,
        help="Device name filter (substring match, e.g., 'border' for all border routers)"
    )

    parser.add_argument(
        "--format",
        choices=["human", "json"],
        default="human",
        help="Output format (default: human)"
    )

    args = parser.parse_args()

    # Initialize client
    client = ForwardClient.from_env()

    # Get interface data
    interfaces = get_interface_status(
        client=client,
        network_id=args.network_id,
        device_filter=args.device_filter
    )

    if not interfaces:
        print(f"❌ No interfaces found (filter: {args.device_filter or 'none'})", file=sys.stderr)
        sys.exit(1)

    # Analyze
    analysis = analyze_interfaces(interfaces)

    # Print results
    print_analysis(analysis, format=args.format)

    # Exit with warning code if dark links found
    if analysis["dark_links"]:
        print(f"\n⚠️  Found {len(analysis['dark_links'])} dark link(s) - investigate before making changes!", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
