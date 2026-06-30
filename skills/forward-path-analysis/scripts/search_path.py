#!/usr/bin/env python3
"""Single-flow path search against a Forward network.

Endpoint: GET /api/networks/{networkId}/paths?dstIp=...&srcIp=...&intent=...

Pass --snapshot-id for a real snapshot or --changeset-id for a Predict change-set.
The two are mutually exclusive: predicted snapshots (the IDs under a change-set's
predictedSnapshots[]) are NOT accepted by ?snapshotId= — they must be addressed via
?changeSetId=. Forward returns 404 with a null message body if you mix them up.
"""
import argparse
import sys
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401 — side-effect: puts forward_client on sys.path

from forward_client import ForwardClient, ForwardError, AuthError, NotFoundError
from skill_io import emit_success, emit_error, ERR_API, ERR_AUTH, ERR_INPUT, ERR_NOT_FOUND


PROTO_ALIAS = {
    "tcp": 6,
    "udp": 17,
    "icmp": 1,
    "icmpv6": 58,
    "sctp": 132,
}
INTENT_VALID = {"PREFER_DELIVERED", "PREFER_VIOLATIONS", "VIOLATIONS_ONLY"}


def main() -> int:
    p = argparse.ArgumentParser(description="Forward path search (single flow)")
    p.add_argument("--network-id", required=True)
    p.add_argument("--dst-ip", required=True, help="Destination IP or subnet")
    p.add_argument("--src-ip", help="Source IP")
    p.add_argument("--from", dest="from_", help="Source device or location name")
    p.add_argument("--ip-proto", help="tcp | udp | icmp | <protocol number>")
    p.add_argument("--src-port", help="Source port (string; supports ranges)")
    p.add_argument("--dst-port", help="Destination port (string; supports ranges)")
    p.add_argument("--intent", choices=sorted(INTENT_VALID),
                   help="Path intent (see references/path-intents.md)")
    p.add_argument("--snapshot-id", help="Snapshot ID (defaults to latest processed)")
    p.add_argument("--changeset-id", help="Change-set ID (for Predict what-if scenarios)")
    p.add_argument("--max-seconds", type=int, default=30,
                   help="Server-side search budget in seconds (default 30)")
    p.add_argument("--max-candidates", type=int)
    p.add_argument("--max-results", type=int, default=20,
                   help="Max returned paths (default 20)")
    p.add_argument("--max-return-path-results", type=int)
    p.add_argument("--include-network-functions", action="store_true")
    args = p.parse_args()

    # Build query params in server's expected shape
    qs: dict = {"dstIp": args.dst_ip}
    if args.src_ip:
        qs["srcIp"] = args.src_ip
    if args.from_:
        qs["from"] = args.from_
    if args.intent:
        qs["intent"] = args.intent
    if args.ip_proto is not None:
        proto_raw = args.ip_proto.lower()
        if proto_raw in PROTO_ALIAS:
            qs["ipProto"] = PROTO_ALIAS[proto_raw]
        else:
            try:
                qs["ipProto"] = int(proto_raw)
            except ValueError:
                emit_error(ERR_INPUT,
                           f"invalid --ip-proto {args.ip_proto}: use tcp|udp|icmp or a number")
    if args.src_port:
        qs["srcPort"] = args.src_port
    if args.dst_port:
        qs["dstPort"] = args.dst_port
    if args.include_network_functions:
        qs["includeNetworkFunctions"] = "true"
    if args.max_candidates:
        qs["maxCandidates"] = args.max_candidates
    if args.max_results:
        qs["maxResults"] = args.max_results
    if args.max_return_path_results:
        qs["maxReturnPathResults"] = args.max_return_path_results
    if args.max_seconds:
        qs["maxSeconds"] = args.max_seconds
    if args.snapshot_id:
        qs["snapshotId"] = args.snapshot_id
    if args.changeset_id:
        qs["changeSetId"] = args.changeset_id

    path = f"/api/networks/{args.network_id}/paths?" + urllib.parse.urlencode(qs)

    try:
        client = ForwardClient.from_env()
        # Increase client-side timeout past server budget to avoid premature cutoff
        client.timeout = max(client.timeout, args.max_seconds + 30)
        result = client.get(path)
    except AuthError as e:
        emit_error(ERR_AUTH, str(e))
    except NotFoundError as e:
        emit_error(ERR_NOT_FOUND, str(e))
    except ForwardError as e:
        emit_error(ERR_API, str(e))

    meta = {
        "network_id": args.network_id,
        "src_ip": args.src_ip,
        "dst_ip": args.dst_ip,
    }
    if args.from_:
        meta["from"] = args.from_
    if args.intent:
        meta["intent"] = args.intent
    if args.snapshot_id:
        meta["snapshot_id"] = args.snapshot_id
    if args.changeset_id:
        meta["changeset_id"] = args.changeset_id

    emit_success(result, meta=meta)
    return 0


if __name__ == "__main__":
    sys.exit(main())
