#!/usr/bin/env python3
"""Get the status of a collector task.

Usage:
    python3 get_collection_status.py --task-id <id>

Returns:
    JSON with taskId, networkId, status, progress, timestamps, and error (if failed).
"""
from __future__ import annotations

import argparse

import _bootstrap  # noqa: F401 — prepends shared/ to sys.path
from forward_client import ForwardClient, ForwardError, AuthError, NotFoundError
from skill_io import emit_success, emit_error, ERR_API, ERR_AUTH, ERR_NOT_FOUND


def main():
    parser = argparse.ArgumentParser(description="Get Forward collection task status")
    parser.add_argument(
        "--task-id",
        required=True,
        help="Collector task ID to check"
    )
    args = parser.parse_args()

    try:
        client = ForwardClient.from_env()

        # GET /collector-tasks/{taskId}
        result = client.get(f"/api/collector-tasks/{args.task_id}")

        emit_success(result, meta={"task_id": args.task_id})
    except AuthError as e:
        emit_error(ERR_AUTH, str(e), hint="check FORWARD_API_KEY / FORWARD_API_SECRET")
    except NotFoundError as e:
        emit_error(ERR_NOT_FOUND, str(e),
                   hint="task ID comes from start_collection.py output")
    except ForwardError as e:
        emit_error(ERR_API, str(e))


if __name__ == "__main__":
    main()
