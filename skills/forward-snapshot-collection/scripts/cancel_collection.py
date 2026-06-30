#!/usr/bin/env python3
"""Cancel an in-progress network collection.

Usage:
    python3 cancel_collection.py --network-id <id>

Returns:
    JSON response (typically empty {} on success).
"""
from __future__ import annotations

import argparse

import _bootstrap  # noqa: F401 — prepends shared/ to sys.path
from forward_client import ForwardClient, ForwardError, AuthError, NotFoundError
from skill_io import emit_success, emit_error, ERR_API, ERR_AUTH, ERR_NOT_FOUND


def main():
    parser = argparse.ArgumentParser(description="Cancel Forward network collection")
    parser.add_argument(
        "--network-id",
        required=True,
        help="Network ID whose collection to cancel"
    )
    args = parser.parse_args()

    try:
        client = ForwardClient.from_env()

        # POST /networks/{networkId}/cancelcollection
        result = client.post(f"/api/networks/{args.network_id}/cancelcollection", body={})

        emit_success(result or {"status": "cancelled"}, meta={"network_id": args.network_id})
    except AuthError as e:
        emit_error(ERR_AUTH, str(e), hint="check FORWARD_API_KEY / FORWARD_API_SECRET")
    except NotFoundError as e:
        emit_error(ERR_NOT_FOUND, str(e), hint="list networks with forward-inventory")
    except ForwardError as e:
        emit_error(ERR_API, str(e),
                   hint="the API returns an error if no collection is currently active")


if __name__ == "__main__":
    main()
