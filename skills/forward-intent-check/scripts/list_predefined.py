#!/usr/bin/env python3
"""List available Predefined check types."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401 — side-effect: puts forward_client on sys.path

from forward_client import ForwardClient, ForwardError, emit_json, die


def main():
    client = ForwardClient.from_env()

    try:
        checks = client.get("/api/predefinedChecks")
    except ForwardError as e:
        die(f"Failed to fetch predefined checks: {e}")

    emit_json(checks)


if __name__ == "__main__":
    main()
