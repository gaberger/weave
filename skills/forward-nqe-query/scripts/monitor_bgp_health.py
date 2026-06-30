#!/usr/bin/env python3
"""Monitor BGP health by checking established sessions for route exchange anomalies.

This script runs the "BGP Established Peerings" NQE query and alerts on:
- eBGP sessions advertising 0 prefixes (outbound filtering issue)
- eBGP sessions receiving 0 prefixes (inbound filtering issue)
- Asymmetric route exchange (one direction working, other not)

Use this to detect scenario-2 style problems: BGP sessions ESTABLISHED but routes not exchanged.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401

from forward_client import ForwardClient, ForwardError
from skill_io import (
    add_format_arg,
    emit_error,
    emit_success,
    ERR_API,
    ERR_NOT_FOUND,
)

# Known query ID for "BGP Established Peerings"
BGP_ESTABLISHED_QUERY_ID = "FQ_e3d40e190d769a6221ddcc21555473cf04e1384e"


def classify_session(item, ibgp_patterns=None):
    """Classify BGP session health based on prefix counts.

    Returns: (status, severity, message)
    - status: HEALTHY, WARNING, CRITICAL
    - severity: int (0=healthy, 1=warning, 2=critical)
    - message: str (explanation)

    Args:
        item: BGP session item from NQE query
        ibgp_patterns: List of IP prefixes/patterns for iBGP detection (default: common loopback ranges)
    """
    device = item.get("Device", "?")
    peer = item.get("Peer Address", "?")
    advertised = item.get("Advertised Prefix Count", 0)
    received = item.get("Received Prefix Count", 0)

    # Default iBGP patterns: common loopback and RFC1918 ranges
    if ibgp_patterns is None:
        ibgp_patterns = [
            "1.", "2.", "3.",           # Common loopback ranges
            "10.", "172.16.", "192.168.", # RFC1918 (iBGP often uses these)
            "127.",                       # Localhost
        ]

    # Determine if this is eBGP or iBGP based on peer address
    # Heuristic: iBGP if peer IP matches known internal patterns
    # For more accuracy, use --ibgp-pattern flag or check AS numbers via API
    is_ebgp = not any(peer.startswith(pattern) for pattern in ibgp_patterns)

    # eBGP sessions
    if is_ebgp:
        if advertised == 0 and received == 0:
            return "CRITICAL", 2, f"eBGP {device} → {peer}: No routes exchanged (both directions broken)"
        elif advertised == 0 and received > 0:
            return "CRITICAL", 2, f"eBGP {device} → {peer}: Advertising 0 routes but receiving {received} (outbound filter issue)"
        elif advertised > 0 and received == 0:
            return "WARNING", 1, f"eBGP {device} → {peer}: Advertising {advertised} routes but receiving 0 (inbound filter issue)"
        else:
            return "HEALTHY", 0, f"eBGP {device} → {peer}: {advertised} advertised, {received} received"

    # iBGP sessions
    else:
        # iBGP clients (spines, route-reflector clients) may advertise 0 - this is normal
        # Only flag if BOTH directions are 0
        if advertised == 0 and received == 0:
            return "WARNING", 1, f"iBGP {device} → {peer}: No routes exchanged (check if RR client/server relationship correct)"
        else:
            return "HEALTHY", 0, f"iBGP {device} → {peer}: {advertised} advertised, {received} received"


def main():
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--network-id", required=True, help="Network ID")
    parser.add_argument("--snapshot-id", help="Snapshot ID (default: latest processed)")
    parser.add_argument(
        "--alert-level",
        choices=["HEALTHY", "WARNING", "CRITICAL"],
        default="WARNING",
        help="Minimum alert level to report (default: WARNING)"
    )
    add_format_arg(parser, choices=("human", "json", "prometheus"))
    parser.add_argument("--verbose", action="store_true", help="Show all sessions including healthy")
    parser.add_argument(
        "--ibgp-pattern",
        action="append",
        help="IP prefix for iBGP peer detection (e.g., '10.' or '1.1.1.'). Can repeat. Default: common loopback/RFC1918 ranges"
    )

    args = parser.parse_args()

    client = ForwardClient.from_env()

    # Resolve snapshot ID if not provided
    if not args.snapshot_id:
        networks = client.get("/api/networks")
        net = next((n for n in networks if n["id"] == args.network_id), None)
        if not net:
            emit_error(ERR_NOT_FOUND, f"Network {args.network_id} not found",
                       hint="list networks with forward-inventory", fmt=args.format)
        args.snapshot_id = str(net.get("latestProcessedSnapshotId", ""))
        if not args.snapshot_id:
            emit_error(ERR_NOT_FOUND,
                       f"Network {args.network_id} has no processed snapshots",
                       fmt=args.format)

    # Run BGP established peerings query
    try:
        result = client.post(
            f"/api/snapshots/{args.snapshot_id}/nqeQueries/{BGP_ESTABLISHED_QUERY_ID}/run"
        )
    except ForwardError as e:
        emit_error(ERR_API, f"Failed to run BGP query: {e}", fmt=args.format)

    items = result.get("items", [])

    # Classify all sessions (an empty population flows through as zero counts —
    # not a special case, so JSON/human/prometheus stay consistent)
    classifications = []
    ibgp_patterns = args.ibgp_pattern if hasattr(args, 'ibgp_pattern') and args.ibgp_pattern else None
    for item in items:
        status, severity, message = classify_session(item, ibgp_patterns)
        classifications.append({
            "device": item.get("Device", "?"),
            "peer": item.get("Peer Address", "?"),
            "advertised": item.get("Advertised Prefix Count", 0),
            "received": item.get("Received Prefix Count", 0),
            "duration": item.get("Session Duration", "?"),
            "status": status,
            "severity": severity,
            "message": message
        })

    # Severity counts over the FULL population — meta must describe every
    # session, not just the post-filter subset.
    critical_count = sum(1 for c in classifications if c["severity"] == 2)
    warning_count = sum(1 for c in classifications if c["severity"] == 1)
    healthy_count = sum(1 for c in classifications if c["severity"] == 0)

    # Filter by alert level (the actionable subset shown to the operator)
    severity_map = {"HEALTHY": 0, "WARNING": 1, "CRITICAL": 2}
    min_severity = severity_map[args.alert_level]

    if not args.verbose:
        classifications = [c for c in classifications if c["severity"] >= min_severity]

    # Sort by severity (critical first), then by device
    classifications.sort(key=lambda x: (-x["severity"], x["device"], x["peer"]))

    meta = {
        "network_id": args.network_id,
        "snapshot_id": args.snapshot_id,
        "total_sessions": len(items),
        "healthy": healthy_count,
        "warnings": warning_count,
        "critical": critical_count,
        "shown": len(classifications),
        "alert_level": args.alert_level,
    }

    # Output
    if args.format == "json":
        # severity lives in data/meta, not the exit code — JSON always exits 0
        # when the skill ran. (emit_success exits for us.)
        emit_success({"sessions": classifications}, meta=meta, fmt="json")

    if args.format == "prometheus":
        # Prometheus exposition format
        print("# HELP bgp_session_health BGP session health status (0=healthy, 1=warning, 2=critical)")
        print("# TYPE bgp_session_health gauge")
        for c in classifications:
            labels = f'network_id="{args.network_id}",device="{c["device"]}",peer="{c["peer"]}"'
            print(f'bgp_session_health{{{labels}}} {c["severity"]}')

        print("# HELP bgp_advertised_prefixes Number of prefixes advertised to BGP peer")
        print("# TYPE bgp_advertised_prefixes gauge")
        for c in classifications:
            labels = f'network_id="{args.network_id}",device="{c["device"]}",peer="{c["peer"]}"'
            print(f'bgp_advertised_prefixes{{{labels}}} {c["advertised"]}')

        print("# HELP bgp_received_prefixes Number of prefixes received from BGP peer")
        print("# TYPE bgp_received_prefixes gauge")
        for c in classifications:
            labels = f'network_id="{args.network_id}",device="{c["device"]}",peer="{c["peer"]}"'
            print(f'bgp_received_prefixes{{{labels}}} {c["received"]}')
        sys.exit(0)

    else:  # human format — counts reflect the full population (computed above)
        print(f"\nBGP Health Summary (Network {args.network_id}, Snapshot {args.snapshot_id})")
        print("=" * 80)
        print(f"Total Sessions: {len(items)}")
        print(f"  🔴 Critical: {critical_count}")
        print(f"  ⚠️  Warning: {warning_count}")
        print(f"  ✅ Healthy: {healthy_count}")
        print()

        if classifications:
            print("Session Details:")
            print("-" * 80)
            for c in classifications:
                icon = "🔴" if c["severity"] == 2 else "⚠️ " if c["severity"] == 1 else "✅"
                print(f"{icon} {c['status']:8s} | {c['message']}")
                print(f"            Duration: {c['duration']}")
                print()

        # Exit with appropriate code
        if critical_count > 0:
            sys.exit(2)
        elif warning_count > 0:
            sys.exit(1)
        else:
            sys.exit(0)


if __name__ == "__main__":
    main()
