#!/usr/bin/env python3
"""Delete a Forward security-matrix filter by id (or by name)."""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401

from forward_client import ForwardClient, ForwardError
from skill_io import emit_success, emit_error, ERR_API, ERR_NOT_FOUND, ERR_INPUT


def _resolve_id_by_name(client: ForwardClient, network_id: str, name: str) -> str:
    data = client.get(f"/api/networks/{network_id}/securityMatrixFilters")
    filters = data.get("filters") if isinstance(data, dict) else data
    if not isinstance(filters, list):
        emit_error(ERR_API, f"unexpected list response shape: {type(data).__name__}")
    matches = [f for f in filters if isinstance(f, dict) and f.get("name") == name]
    if not matches:
        emit_error(ERR_NOT_FOUND, f"no security-matrix filter named {name!r} on network {network_id}")
    if len(matches) > 1:
        ids = [m.get("id") for m in matches]
        emit_error(ERR_INPUT,
                   f"name {name!r} is ambiguous — {len(matches)} matches with ids {ids}",
                   hint="pass --filter-id explicitly")
    fid = matches[0].get("id")
    if not fid:
        emit_error(ERR_API, f"matched filter for {name!r} has no id field — cannot delete")
    return str(fid)


def main() -> int:
    p = argparse.ArgumentParser(description="Delete a security-matrix filter on a Forward network")
    p.add_argument("--network-id", required=True)
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--filter-id", help="Filter id to delete")
    g.add_argument("--name", help="Filter name to delete (must be unique on this network)")
    p.add_argument("--yes", action="store_true", help="Skip the destructive-action confirmation")
    args = p.parse_args()

    if not args.yes:
        emit_error(ERR_INPUT, "delete is destructive — re-run with --yes to confirm")

    try:
        client = ForwardClient.from_env()
        filter_id = args.filter_id or _resolve_id_by_name(client, args.network_id, args.name)
        client.delete(f"/api/networks/{args.network_id}/securityMatrixFilters/{filter_id}")
    except ForwardError as e:
        emit_error(ERR_API, str(e))

    emit_success({"deleted": True, "filterId": filter_id},
                 meta={"network_id": args.network_id, "filter_id": filter_id})
    return 0


if __name__ == "__main__":
    sys.exit(main())
