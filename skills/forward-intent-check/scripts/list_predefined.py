#!/usr/bin/env python3
"""List available Predefined check types."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401 — side-effect: puts forward_client on sys.path

from forward_client import ForwardClient, ForwardError
from skill_io import emit_error, emit_success, ERR_API


def main():
    client = ForwardClient.from_env()

    try:
        checks = client.get("/api/predefinedChecks")
    except ForwardError as e:
        emit_error(ERR_API, f"Failed to fetch predefined checks: {e}")

    emit_success(checks, meta={
        "count": len(checks) if isinstance(checks, list) else None,
    })


if __name__ == "__main__":
    main()
