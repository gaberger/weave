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

from forward_client import (
    ForwardClient,
    ForwardError,
    AuthError,
    NotFoundError,
    resolve_query_id,
)
from skill_io import (
    emit_error,
    emit_success,
    ERR_API,
    ERR_AUTH,
    ERR_NOT_FOUND,
)


def add_common_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--network-id", required=True)
    parser.add_argument("--snapshot-id", help="Snapshot ID (defaults to latest processed)")
    parser.add_argument("--device-name", help="Client-side filter: keep only rows with this device name")
    parser.add_argument("--limit", type=int, default=1000,
                        help="Server-side row limit (default 1000; 0 = no limit)")


def run_entity(script_file: str, path_hint: str, args: argparse.Namespace) -> int:
    # Catalog resolution and credential load are distinct failure modes: an
    # unresolvable path hint is a missing resource, missing creds is auth.
    try:
        entry = resolve_query_id(script_file, path_hint)
    except ForwardError as e:
        emit_error(ERR_NOT_FOUND, str(e),
                   hint="search the catalog with forward-nqe-query")

    try:
        client = ForwardClient.from_env()
    except ForwardError as e:
        emit_error(ERR_AUTH, str(e),
                   hint="set FORWARD_API_BASE_URL / FORWARD_API_KEY / FORWARD_API_SECRET (or a .env)")

    body: dict[str, Any] = {"queryId": entry["queryId"]}
    if args.limit:
        body["queryOptions"] = {"limit": args.limit}

    qs = {"networkId": args.network_id}
    if args.snapshot_id:
        qs["snapshotId"] = args.snapshot_id
    path = "/api/nqe?" + urllib.parse.urlencode(qs)

    try:
        result = client.post(path, body)
    except NotFoundError as e:
        # 404 — the network or snapshot id doesn't exist in this Forward.
        emit_error(ERR_NOT_FOUND, str(e),
                   hint="check --network-id / --snapshot-id with forward-inventory")
    except AuthError as e:
        emit_error(ERR_AUTH, str(e))
    except ForwardError as e:
        emit_error(ERR_API, str(e))

    # Client-side device filter
    items = result.get("items") if isinstance(result, dict) else None
    filtered_by = None
    if args.device_name and isinstance(items, list):
        needle = args.device_name.lower()
        items = [row for row in items if _row_matches_device(row, needle)]
        filtered_by = {"deviceName": args.device_name}

    # data = the answer (the rows); meta = facts about it (counts, the catalog
    # entry we resolved, echoed params, any client-side filter applied).
    meta: dict[str, Any] = {
        "network_id": args.network_id,
        "snapshot_id": args.snapshot_id,
        "catalog": {"path": entry["path"], "queryId": entry["queryId"]},
    }
    if isinstance(items, list):
        data: Any = items
        meta["count"] = len(items)
    else:
        # Unexpected response shape (no "items" list) — pass the raw payload
        # through rather than silently dropping it.
        data = result
    if filtered_by:
        meta["filteredBy"] = filtered_by

    emit_success(data, meta=meta)
    return 0  # unreachable: emit_success exits, kept for the -> int contract


def _row_matches_device(row: Any, needle: str) -> bool:
    if not isinstance(row, dict):
        return False
    for key in ("deviceName", "device", "hostname", "host", "name"):
        v = row.get(key)
        if isinstance(v, str) and needle in v.lower():
            return True
    return False
