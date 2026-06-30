#!/usr/bin/env python3
"""Bulk path search — run many path queries in one API call.

Endpoint: POST /api/networks/{networkId}/paths-bulk[?snapshotId=...]

Input file is a JSON object:
    {
      "queries": [
        {"srcIp": "10.1.2.3", "dstIp": "10.5.0.10", "ipProto": 6, "dstPort": "443"},
        ...
      ],
      "intent": "PREFER_VIOLATIONS",
      "maxSeconds": 60,
      "maxResults": 20
    }

Each element of "queries" may contain any field accepted by the single-flow
path search (srcIp, dstIp, ipProto, srcPort, dstPort, intent, ...). Top-level
fields apply as shared defaults.
"""
import argparse
import json
import sys
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401 — side-effect: puts forward_client on sys.path

from forward_client import ForwardClient, ForwardError, AuthError, NotFoundError
from skill_io import emit_success, emit_error, ERR_API, ERR_AUTH, ERR_INPUT, ERR_NOT_FOUND


def main() -> int:
    p = argparse.ArgumentParser(description="Forward bulk path search")
    p.add_argument("--network-id", required=True)
    p.add_argument("--queries-file", required=True,
                   help="JSON file with {queries: [...], intent, maxSeconds, ...}")
    p.add_argument("--snapshot-id", help="Snapshot ID (defaults to latest processed)")
    p.add_argument("--warn-at", type=int, default=10,
                   help="Emit stderr warning if query count exceeds this (default 10)")
    args = p.parse_args()

    try:
        body = json.loads(Path(args.queries_file).read_text())
    except OSError as e:
        emit_error(ERR_INPUT, f"cannot read --queries-file {args.queries_file}: {e}")
    except json.JSONDecodeError as e:
        emit_error(ERR_INPUT, f"--queries-file is not valid JSON: {e}")

    queries = body.get("queries")
    if not isinstance(queries, list) or not queries:
        emit_error(ERR_INPUT, "queries-file must contain a non-empty 'queries' array")

    if len(queries) > args.warn_at:
        sys.stderr.write(
            f"note: {len(queries)} queries — this may take several minutes. "
            f"Consider splitting or tightening maxSeconds.\n"
        )

    path = f"/api/networks/{args.network_id}/paths-bulk"
    if args.snapshot_id and args.snapshot_id != "latest":
        path += "?" + urllib.parse.urlencode({"snapshotId": args.snapshot_id})

    try:
        client = ForwardClient.from_env()
        # Give the client a generous timeout — bulk can run for a long time
        budget = int(body.get("maxSeconds") or 60)
        client.timeout = max(client.timeout, budget * max(1, len(queries)) + 30)
        result = client.post(path, body)
    except AuthError as e:
        emit_error(ERR_AUTH, str(e))
    except NotFoundError as e:
        emit_error(ERR_NOT_FOUND, str(e))
    except ForwardError as e:
        emit_error(ERR_API, str(e))

    meta = {
        "network_id": args.network_id,
        "query_count": len(queries),
    }
    if args.snapshot_id:
        meta["snapshot_id"] = args.snapshot_id

    emit_success(result, meta=meta)
    return 0


if __name__ == "__main__":
    sys.exit(main())
