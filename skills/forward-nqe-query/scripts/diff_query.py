#!/usr/bin/env python3
"""Compare NQE query results between two snapshots (NQE diff).

Identifies ADDED, DELETED, and MODIFIED rows between a 'before' and 'after'
snapshot. Essential for change detection, root cause analysis, and drift tracking.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401 — side-effect: puts forward_client on sys.path

from forward_client import ForwardClient, ForwardError
from skill_io import emit_error, emit_success, ERR_API, ERR_INPUT


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--query-id", required=True, help="NQE query ID (FQ_...)")
    parser.add_argument(
        "--before-snapshot",
        required=True,
        help="Baseline snapshot ID (the 'before' state)",
    )
    parser.add_argument(
        "--after-snapshot",
        required=True,
        help="Comparison snapshot ID (the 'after' state)",
    )
    parser.add_argument("--commit-id", help="Specific query version (optional)")
    parser.add_argument(
        "--params",
        help="JSON string of query parameters (if query declares params)",
    )
    parser.add_argument(
        "--change-type",
        action="append",
        choices=["ADDED", "DELETED", "MODIFIED"],
        help="Filter by change type (can repeat)",
    )
    parser.add_argument(
        "--sort-by-change",
        action="store_true",
        help="Sort results by ChangeType column",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=1000,
        help="Max rows to return (default 1000, max 10000)",
    )
    parser.add_argument(
        "--offset",
        type=int,
        default=0,
        help="Number of rows to skip (for paging)",
    )
    args = parser.parse_args()

    if args.limit > 10000:
        emit_error(ERR_INPUT, "--limit cannot exceed 10000 (API constraint)")

    client = ForwardClient.from_env()

    # Build request body
    body = {
        "queryId": args.query_id,
        "options": {
            "offset": args.offset,
            "limit": args.limit,
            "itemFormat": "JSON",
        },
    }

    if args.commit_id:
        body["commitId"] = args.commit_id

    if args.params:
        body["parameters"] = json.loads(args.params)

    # Sort by ChangeType if requested
    if args.sort_by_change:
        body["options"]["sortBy"] = {"columnName": "ChangeType", "order": "ASC"}

    # Filter by ChangeType if requested
    if args.change_type:
        filters = []
        for ct in args.change_type:
            filters.append({"columnName": "ChangeType", "value": ct})
        body["options"]["columnFilters"] = filters

    path = f"/api/nqe-diffs/{args.before_snapshot}/{args.after_snapshot}"

    try:
        result = client.post(path, body=body)
    except ForwardError as e:
        emit_error(ERR_API, f"Failed to run NQE diff: {e}")

    meta = {
        "beforeSnapshot": args.before_snapshot,
        "afterSnapshot": args.after_snapshot,
        "queryId": args.query_id,
        "changeTypeFilter": args.change_type or ["ALL"],
    }
    items = result.get("items") if isinstance(result, dict) else None
    if items is not None:
        meta["count"] = len(items)

    emit_success(result, meta=meta)


if __name__ == "__main__":
    main()
