"""Shared helper for device-intel entity wrappers.

Resolves a catalog path hint to a queryId, runs the NQE query, and optionally
filters rows by device name client-side.
"""
from __future__ import annotations

import argparse
import sys
import urllib.parse
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401 — side-effect: puts forward_client on sys.path

from forward_client import ForwardClient, ForwardError, resolve_query_id, emit_json, die


def add_common_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--network-id", required=True)
    parser.add_argument("--snapshot-id", help="Snapshot ID (defaults to latest processed)")
    parser.add_argument("--device-name", help="Client-side filter: keep only rows with this device name")
    parser.add_argument("--limit", type=int, default=1000,
                        help="Server-side row limit (default 1000; 0 = no limit)")


def run_entity(script_file: str, path_hint: str, args: argparse.Namespace) -> int:
    try:
        entry = resolve_query_id(script_file, path_hint)
        client = ForwardClient.from_env()
    except ForwardError as e:
        die(str(e))

    body: dict[str, Any] = {"queryId": entry["queryId"]}
    if args.limit:
        body["queryOptions"] = {"limit": args.limit}

    qs = {"networkId": args.network_id}
    if args.snapshot_id:
        qs["snapshotId"] = args.snapshot_id
    path = "/api/nqe?" + urllib.parse.urlencode(qs)

    try:
        result = client.post(path, body)
    except ForwardError as e:
        die(str(e))

    # Client-side device filter
    if args.device_name and isinstance(result, dict):
        items = result.get("items")
        if isinstance(items, list):
            needle = args.device_name.lower()
            filtered = [
                row for row in items
                if _row_matches_device(row, needle)
            ]
            result = {**result, "items": filtered, "filteredBy": {"deviceName": args.device_name}}

    # Tag the output with the catalog entry we resolved
    if isinstance(result, dict):
        result = {**result, "_catalog": {"path": entry["path"], "queryId": entry["queryId"]}}

    emit_json(result)
    return 0


def _row_matches_device(row: Any, needle: str) -> bool:
    if not isinstance(row, dict):
        return False
    for key in ("deviceName", "device", "hostname", "host", "name"):
        v = row.get(key)
        if isinstance(v, str) and needle in v.lower():
            return True
    return False
