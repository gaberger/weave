#!/usr/bin/env python3
"""Create a new check (verification) on a Forward network snapshot.

Supports all 5 check types: Existential, Isolation, Reachability, NQE, Predefined.

Pre-flight validation catches common API errors BEFORE attempting creation:
- Predefined/NQE checks cannot have custom names (API restriction)
- Snapshot must be in PROCESSED state
- Required parameters validated per check type
"""
import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401 — side-effect: puts forward_client on sys.path

from forward_client import ForwardClient, ForwardError
from skill_io import emit_error, emit_success, ERR_API, ERR_INPUT, ERR_NOT_FOUND


def validate_snapshot_state(client, snapshot_id):
    """Validate snapshot is PROCESSED and ready for checks.

    Returns: (is_ready: bool, state: str, message: str)
    """
    try:
        snapshot = client.get(f"/api/snapshots/{snapshot_id}")
    except ForwardError as e:
        # HTTP 406 means the endpoint exists but requires application/zip Accept header
        # (it's a binary download endpoint). A 406 confirms the snapshot exists and is
        # accessible — treat it as ready. A missing snapshot would return 404 instead.
        if "406" in str(e):
            return True, "PROCESSED", "Snapshot accessible (406 on binary endpoint)"
        return False, "ERROR", f"Failed to fetch snapshot: {e}"

    state = snapshot.get("state", "UNKNOWN")
    adv_state = snapshot.get("advancedReachabilityState", "UNKNOWN")

    if state != "PROCESSED":
        return False, state, f"Snapshot state is {state}, need PROCESSED (may still be collecting)"

    if adv_state not in ["PROCESSED", "NOT_REQUESTED"]:
        return False, adv_state, f"Advanced reachability state is {adv_state}, need PROCESSED"

    return True, "PROCESSED", "Snapshot ready"


def validate_check_params(args):
    """Validate check parameters before API call.

    Returns: (is_valid: bool, error_message: str or None)
    """
    check_type = args.type

    # Name rules are enforced at body-build time (see main): path-based checks
    # require --name; PARAMETERIZED NQE checks require --name (API mandate);
    # plain NQE / Predefined reject a custom name. Nothing to block here.

    # Path-based checks need at least src or dst
    if check_type in ["Existential", "Isolation", "Reachability"]:
        if not args.src_ip and not args.dst_ip:
            return False, "Path-based checks require at least --src-ip or --dst-ip"

    # NQE checks need query ID
    if check_type == "NQE":
        if not args.query_id:
            return False, "NQE checks require --query-id"

    # Predefined checks need predefined type
    if check_type == "Predefined":
        if not args.predefined_type:
            return False, "Predefined checks require --predefined-type"

    return True, None


def wait_for_snapshot_processing(client, snapshot_id, max_wait_seconds=300, poll_interval=10):
    """Wait for snapshot to reach PROCESSED state.

    Returns: (success: bool, final_state: str, message: str)
    """
    print(f"⏳ Waiting for snapshot {snapshot_id} to reach PROCESSED state...", file=sys.stderr)

    start_time = time.time()
    while time.time() - start_time < max_wait_seconds:
        is_ready, state, message = validate_snapshot_state(client, snapshot_id)

        if is_ready:
            elapsed = int(time.time() - start_time)
            print(f"✅ Snapshot ready after {elapsed}s", file=sys.stderr)
            return True, "PROCESSED", "Ready"

        if state == "ERROR":
            return False, "ERROR", message

        # Still processing
        elapsed = int(time.time() - start_time)
        print(f"   [{elapsed}s] State: {state}, waiting...", file=sys.stderr)
        time.sleep(poll_interval)

    # Timeout
    return False, state, f"Timeout after {max_wait_seconds}s (state: {state})"


def _ip_or_device_location(value):
    """Return the right location filter type for a value.

    DeviceFilter   — bare device name (no dots, not an IP)
    SubnetLocationFilter — IP address or CIDR (contains a dot)
    """
    import re
    if re.match(r'^\d+\.\d+', value):
        return {"type": "SubnetLocationFilter", "value": value}
    return {"type": "DeviceFilter", "value": value}


def build_path_filter(args):
    """Build a PathQuery filter for Existential/Isolation/Reachability checks."""
    filters = {}

    # Build 'from' endpoint
    from_endpoint = {"location": {}, "headers": []}
    if args.src_ip:
        from_endpoint["location"] = _ip_or_device_location(args.src_ip)

    # Add packet filters for src
    packet_values = {}
    if args.src_port:
        packet_values["tp_src"] = [args.src_port]
    if packet_values:
        from_endpoint["headers"].append({"type": "PacketFilter", "values": packet_values})

    if from_endpoint["location"] or from_endpoint["headers"]:
        filters["from"] = from_endpoint

    # Build 'to' endpoint
    to_endpoint = {"location": {}, "headers": []}
    if args.dst_ip:
        to_endpoint["location"] = _ip_or_device_location(args.dst_ip)

    # Add packet filters for dst
    packet_values = {}
    if args.dst_port:
        packet_values["tp_dst"] = [args.dst_port]
    if args.ip_proto:
        # Map common names to protocol numbers
        proto_map = {"tcp": "6", "udp": "17", "icmp": "1"}
        proto_val = proto_map.get(args.ip_proto.lower(), args.ip_proto)
        packet_values["ip_proto"] = [proto_val]
    if packet_values:
        to_endpoint["headers"].append({"type": "PacketFilter", "values": packet_values})

    if to_endpoint["location"] or to_endpoint["headers"]:
        filters["to"] = to_endpoint

    # Add flowTypes filter if specified
    if args.flow_types:
        filters["flowTypes"] = args.flow_types

    return filters


def main():
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Existential check (verify connectivity)
  %(prog)s --network-id 863 --type Existential \\
    --name "US → EU connectivity" \\
    --src-ip 1.1.1.1 --dst-ip 2.2.2.1 \\
    --ip-proto tcp --dst-port 179 --priority MEDIUM

  # Isolation check (verify no connectivity)
  %(prog)s --network-id 863 --type Isolation \\
    --name "US → EU isolation" \\
    --src-ip 10.200.0.0/16 --dst-ip 10.201.0.0/16 \\
    --priority HIGH

  # NQE check (no custom name allowed)
  %(prog)s --network-id 863 --type NQE \\
    --query-id FQ_bgp_routes \\
    --params '{"deviceName":"border-1"}' \\
    --priority MEDIUM

  # Predefined check (no custom name allowed)
  %(prog)s --network-id 863 --type Predefined \\
    --predefined-type BGP_NEIGHBOR_ADJACENCY \\
    --priority MEDIUM

Notes:
  - Predefined and NQE checks cannot have custom --name (Forward API restriction)
  - Script will auto-wait if snapshot is still processing (up to 5 minutes)
  - Use --wait to control wait timeout (0 = fail immediately if not ready)
        """,
    )
    parser.add_argument("--network-id", required=True, help="Network ID")
    parser.add_argument("--snapshot-id", help="Snapshot ID (default: latest processed)")
    parser.add_argument(
        "--type",
        required=True,
        choices=["Existential", "Isolation", "Reachability", "NQE", "Predefined"],
        help="Check type",
    )
    parser.add_argument("--name", help="Check name (ignored for NQE/Predefined checks)")
    parser.add_argument("--note", help="Check note/description")
    parser.add_argument("--priority", choices=["LOW", "MEDIUM", "HIGH", "NOT_SET"], help="Priority")
    parser.add_argument("--persistent", default="true", help="Persistent (default: true)")
    parser.add_argument(
        "--wait",
        type=int,
        default=300,
        help="Max seconds to wait for snapshot processing (default: 300, 0=no wait)",
    )

    # Path-based check args
    parser.add_argument("--src-ip", help="Source IP or subnet")
    parser.add_argument("--dst-ip", help="Destination IP or subnet")
    parser.add_argument("--ip-proto", help="IP protocol (tcp, udp, icmp, or number)")
    parser.add_argument("--src-port", help="Source port or range")
    parser.add_argument("--dst-port", help="Destination port or range")

    # NQE check args
    parser.add_argument("--query-id", help="NQE query ID (for NQE checks)")

    # Predefined check args
    parser.add_argument("--predefined-type", help="Predefined check type")

    # Optional params for NQE/Predefined
    parser.add_argument("--params", help="JSON params for NQE/Predefined checks")

    # Tags (supported for all check types)
    parser.add_argument("--tags", nargs="+", metavar="TAG", help="One or more tags (e.g. --tags bank-global ldp-vpn)")

    # Flow types filter (for path-based checks)
    parser.add_argument(
        "--flow-types",
        nargs="+",
        metavar="TYPE",
        choices=["VALID", "LOOP", "POTENTIAL_LOOP", "BLACKHOLE", "DROPPED", "INADMISSIBLE", "UNREACHABLE", "IGNORED", "UNDELIVERED"],
        help="Filter by flow types (e.g. --flow-types VALID to only check valid paths)"
    )

    args = parser.parse_args()

    # Pre-flight parameter validation
    is_valid, error_msg = validate_check_params(args)
    if not is_valid:
        emit_error(ERR_INPUT, f"Parameter validation failed: {error_msg}")

    client = ForwardClient.from_env()

    # Resolve snapshot ID
    if not args.snapshot_id:
        networks = client.get("/api/networks")
        net = next((n for n in networks if n["id"] == args.network_id), None)
        if not net:
            emit_error(ERR_NOT_FOUND, f"Network {args.network_id} not found",
                       hint="list networks with forward-inventory")
        args.snapshot_id = str(net.get("latestProcessedSnapshotId", ""))
        if not args.snapshot_id:
            emit_error(ERR_NOT_FOUND, f"Network {args.network_id} has no processed snapshots")

    # Validate snapshot state
    is_ready, state, message = validate_snapshot_state(client, args.snapshot_id)

    if not is_ready:
        if args.wait > 0:
            # Try waiting for snapshot to be ready
            success, final_state, wait_message = wait_for_snapshot_processing(
                client, args.snapshot_id, max_wait_seconds=args.wait
            )
            if not success:
                emit_error(ERR_API, f"Snapshot not ready: {wait_message}")
        else:
            emit_error(ERR_API, f"Snapshot not ready: {message}",
                       hint="use --wait to auto-wait for processing")

    # Build check definition based on type
    definition = {"checkType": args.type}

    if args.type in ["Existential", "Isolation", "Reachability"]:
        filters = build_path_filter(args)
        definition["filters"] = filters
    elif args.type == "NQE":
        if not args.query_id:
            emit_error(ERR_INPUT, "--query-id is required for NQE checks")
        definition["queryId"] = args.query_id
        if args.params:
            definition["params"] = json.loads(args.params)
    elif args.type == "Predefined":
        if not args.predefined_type:
            emit_error(ERR_INPUT, "--predefined-type is required for Predefined checks")
        definition["predefinedCheckType"] = args.predefined_type
        if args.params:
            definition["params"] = json.loads(args.params)

    # Build request body
    body = {"definition": definition}

    # Name handling. Path-based checks always require a name. NQE is split:
    #   - PARAMETERIZED NQE (has params) REQUIRES a name — the API rejects creation
    #     otherwise ("'name' required for parameterized NQE checks"). The published
    #     query name is auto-prefixed, so --name becomes a suffix.
    #   - plain NQE / Predefined reject a custom name (query/type name is used).
    parameterized_nqe = args.type == "NQE" and bool(args.params)
    if args.type in ["Existential", "Isolation", "Reachability"]:
        if not args.name:
            emit_error(ERR_INPUT, f"{args.type} checks require --name")
        body["name"] = args.name
    elif parameterized_nqe:
        if not args.name:
            emit_error(ERR_INPUT,
                       "Parameterized NQE checks require --name (it becomes a suffix "
                       "after the query name).")
        body["name"] = args.name
    elif args.type in ["NQE", "Predefined"]:
        if args.name:
            print(
                f"⚠️  Note: --name ignored for non-parameterized {args.type} checks "
                f"(Forward API restriction)",
                file=sys.stderr,
            )

    # NQE checks reject 'note' and 'tags' metadata ("'note' not allowed for NQE
    # checks"); path-based and Predefined checks accept them.
    if args.note:
        if args.type == "NQE":
            print("⚠️  Note: --note ignored for NQE checks (Forward API restriction)",
                  file=sys.stderr)
        else:
            body["note"] = args.note
    if args.priority:
        body["priority"] = args.priority
    if args.tags:
        if args.type == "NQE":
            print("⚠️  Note: --tags ignored for NQE checks (Forward API restriction)",
                  file=sys.stderr)
        else:
            body["tags"] = args.tags

    path = f"/api/snapshots/{args.snapshot_id}/checks"
    query = {"persistent": args.persistent.lower() in ("true", "1", "yes")}

    try:
        result = client.post(path, body=body, query=query)
    except ForwardError as e:
        # Enhance error messages with hints
        error_str = str(e)
        if "'name' not allowed" in error_str:
            emit_error(
                ERR_API, f"Failed to create check: {e}",
                hint=f"{args.type} checks cannot have custom names (Forward API restriction)",
            )
        elif "No hosts matching" in error_str:
            emit_error(
                ERR_API, f"Failed to create check: {e}",
                hint="Check requires host aliases configured in Forward UI, or use device names instead",
            )
        else:
            emit_error(ERR_API, f"Failed to create check: {e}")

    emit_success(result, meta={
        "network_id": args.network_id,
        "snapshot_id": args.snapshot_id,
        "type": args.type,
        "check_id": result.get("id") if isinstance(result, dict) else None,
        "status": result.get("status") if isinstance(result, dict) else None,
    })


if __name__ == "__main__":
    main()
