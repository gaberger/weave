#!/usr/bin/env python3
"""Get the status of a collector task.

Usage:
    python3 get_collection_status.py --task-id <id>

Returns:
    JSON with taskId, networkId, status, progress, timestamps, and error (if failed).
"""
from __future__ import annotations

import argparse
import sys

import _bootstrap  # noqa: F401 — prepends shared/ to sys.path
from forward_client import ForwardClient, emit_json, die, ForwardError


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

        emit_json(result)
    except ForwardError as e:
        die(str(e))


if __name__ == "__main__":
    main()
