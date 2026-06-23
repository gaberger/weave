#!/usr/bin/env python3
"""Trigger a predictive analysis run from a Forward change-set.

POST /api/networks/{networkId}/change-sets/{id}?action=predict
     &baseSnapshotId={snapshotId}&note={note}

Kicks off a Predict snapshot — Forward models the change-set overrides against
the base snapshot and produces a new predicted snapshot. Returns SnapshotMeta.

The predicted snapshot appears in forward-path-analysis as a selectable snapshot
once its processing stage completes (use forward-inventory to poll status).
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401

from forward_client import ForwardClient, ForwardError, emit_json, die


def main() -> int:
    p = argparse.ArgumentParser(
        description="Trigger a predictive analysis run from a Forward change-set"
    )
    p.add_argument("--network-id", required=True)
    p.add_argument("--changeset-id", required=True, help="Change-set ID, e.g. CHG-7")
    p.add_argument(
        "--base-snapshot-id",
        required=True,
        help="Snapshot ID to model against, e.g. 691",
    )
    p.add_argument(
        "--note",
        required=True,
        help="Label for this predict run, e.g. 'test route injection 2026-06-19'",
    )
    p.add_argument("--dry-run", action="store_true", help="Print request params without calling API")
    args = p.parse_args()

    query = {
        "action": "predict",
        "baseSnapshotId": args.base_snapshot_id,
        "note": args.note,
    }

    if args.dry_run:
        emit_json(
            {
                "method": "POST",
                "path": f"/api/networks/{args.network_id}/change-sets/{args.changeset_id}",
                "query": query,
            }
        )
        return 0

    try:
        client = ForwardClient.from_env()
        result = client.post(
            f"/api/networks/{args.network_id}/change-sets/{args.changeset_id}",
            {},
            query=query,
        )
    except ForwardError as e:
        die(str(e))

    emit_json(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
