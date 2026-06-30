#!/usr/bin/env python3
"""List the change-set directory tree for a Forward network.

GET /api/networks/{networkId}/change-set-directories

Returns ChangeSetDirectories — the hierarchical folder structure used to
organise change-sets in the UI. Use --json for the raw tree object.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401

from forward_client import ForwardClient, ForwardError
from skill_io import emit_success, emit_error, ERR_API


def _walk(node: dict, prefix: str = "") -> None:
    """Recursively print directory tree."""
    name = node.get("name", "/")
    path = node.get("path", "")
    cs_ids = node.get("changeSetIds") or []
    children = node.get("children") or []

    label = f"{prefix}{name}/" if name != "/" else "/"
    cs_info = f"  ({len(cs_ids)} change-set(s): {', '.join(cs_ids)})" if cs_ids else ""
    sys.stdout.write(f"  {label}{cs_info}\n")
    for child in children:
        _walk(child, prefix + "  ")


def main() -> int:
    p = argparse.ArgumentParser(
        description="List the change-set directory tree for a Forward network"
    )
    p.add_argument("--network-id", required=True)
    p.add_argument("--json", action="store_true", help="Emit raw JSON only")
    args = p.parse_args()

    fmt = "json" if args.json else "human"

    try:
        client = ForwardClient.from_env()
        result = client.get(f"/api/networks/{args.network_id}/change-set-directories")
    except ForwardError as e:
        emit_error(ERR_API, str(e), fmt=fmt)

    def _render_human(data, meta) -> None:
        if not data:
            sys.stdout.write(
                f"No directory structure found for network {meta['network_id']}.\n"
            )
            return
        sys.stdout.write(
            f"Change-set directory tree for network {meta['network_id']}:\n"
        )
        root = data if isinstance(data, dict) else {"children": data}
        _walk(root)
        sys.stdout.write("\n")

    emit_success(
        result,
        meta={"network_id": args.network_id},
        fmt=fmt,
        human=_render_human,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
