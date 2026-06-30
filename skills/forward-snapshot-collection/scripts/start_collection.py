#!/usr/bin/env python3
"""Trigger a new snapshot collection for a Forward network.

Uses the modern /collector-tasks API (not deprecated /startcollection).

Usage:
    python3 start_collection.py --network-id <id>

Returns:
    JSON with taskId, networkId, status, and timestamps.
"""
from __future__ import annotations

import argparse

import _bootstrap  # noqa: F401 — prepends shared/ to sys.path
from forward_client import ForwardClient, ForwardError, AuthError, NotFoundError
from skill_io import emit_success, emit_error, ERR_API, ERR_AUTH, ERR_NOT_FOUND


def main():
    parser = argparse.ArgumentParser(description="Trigger a Forward network collection")
    parser.add_argument(
        "--network-id",
        required=True,
        help="Network ID to collect"
    )
    args = parser.parse_args()

    try:
        client = ForwardClient.from_env()

        # POST /collector-tasks?networkId=X&type=NETWORK_COLLECTION
        query = {
            "networkId": args.network_id,
            "type": "NETWORK_COLLECTION"
        }
        result = client.post("/api/collector-tasks", None, query=query)

        emit_success(result, meta={"network_id": args.network_id})
    except AuthError as e:
        emit_error(ERR_AUTH, str(e), hint="check FORWARD_API_KEY / FORWARD_API_SECRET")
    except NotFoundError as e:
        emit_error(ERR_NOT_FOUND, str(e), hint="list networks with forward-inventory")
    except ForwardError as e:
        emit_error(ERR_API, str(e),
                   hint="a 409 conflict means a collection is already running for this network")


if __name__ == "__main__":
    main()
