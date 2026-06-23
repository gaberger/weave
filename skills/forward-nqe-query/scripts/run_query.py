#!/usr/bin/env python3
"""Run an NQE query against a Forward network snapshot.

Endpoint: POST /api/nqe?networkId=<id>&snapshotId=<id>
Body (by ID):     {"queryId": "FQ_...", "parameters": {...}, "queryOptions": {...}}
Body (by string): {"query": "...",       "parameters": {...}, "queryOptions": {...}}
"""
import argparse
import json
import sys
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401 — side-effect: puts forward_client on sys.path

from forward_client import ForwardClient, ForwardError, emit_json, die


def parse_param(raw: str) -> tuple:
    if "=" not in raw:
        die(f"--param must be KEY=VALUE, got: {raw}")
    k, _, v = raw.partition("=")
    # Try to coerce common types
    if v.lower() in ("true", "false"):
        return k, v.lower() == "true"
    try:
        return k, int(v)
    except ValueError:
        pass
    try:
        return k, float(v)
    except ValueError:
        pass
    return k, v


def main() -> int:
    p = argparse.ArgumentParser(description="Run a Forward NQE query")
    p.add_argument("--network-id", required=True)
    p.add_argument("--snapshot-id", help="Snapshot ID (defaults to latest processed)")
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--query-id", help="Catalog query ID (e.g. FQ_abc123)")
    src.add_argument("--query", help="Raw NQE query string")
    src.add_argument("--query-file", help="Path to a file containing the NQE query")
    p.add_argument("--param", action="append", default=[],
                   help="Query parameter KEY=VALUE (repeatable)")
    p.add_argument("--params-json", help="Alternative: pass all params as a JSON object")
    p.add_argument("--limit", type=int, default=1000,
                   help="Row limit (default 1000; set 0 for no limit)")
    p.add_argument("--offset", type=int, default=0)
    p.add_argument("--format", choices=["JSON", "CSV"],
                   help="NQE output format (server-side)")
    args = p.parse_args()

    body: dict = {}
    if args.query_id:
        body["queryId"] = args.query_id
    elif args.query:
        body["query"] = args.query
    else:
        try:
            body["query"] = Path(args.query_file).read_text()
        except OSError as e:
            die(f"cannot read --query-file {args.query_file}: {e}")

    # Parameters
    parameters: dict = {}
    if args.params_json:
        try:
            parameters = json.loads(args.params_json)
        except json.JSONDecodeError as e:
            die(f"--params-json is not valid JSON: {e}")
    for raw in args.param:
        k, v = parse_param(raw)
        parameters[k] = v
    if parameters:
        body["parameters"] = parameters

    # Query options
    opts: dict = {}
    if args.limit:
        opts["limit"] = args.limit
    if args.offset:
        opts["offset"] = args.offset
    if args.format:
        opts["format"] = args.format
    if opts:
        body["queryOptions"] = opts

    # Build URL query string
    qs = {"networkId": args.network_id}
    if args.snapshot_id:
        qs["snapshotId"] = args.snapshot_id
    path = "/api/nqe?" + urllib.parse.urlencode(qs)

    try:
        client = ForwardClient.from_env()
        result = client.post(path, body)
    except ForwardError as e:
        die(str(e))

    emit_json(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
