#!/usr/bin/env python3
"""Retrieve the Forward security-matrix for a network/snapshot/filter.

Wraps:
    GET /api/networks/{networkId}/security-matrix?filterId={id}&snapshotId={id}

Three output shapes:

* ``--shape raw``       (default) emit Forward's response verbatim
* ``--shape matrix``    normalize to the {zones, cells} shape that
                        forward-report-table --template security-matrix expects
* ``--shape cell``      with --src/--dst, print just one cell + a suggested
                        forward-path-analysis follow-up command
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401

from forward_client import ForwardClient, ForwardError, NotFoundError
from skill_io import emit_success, emit_error, ERR_API, ERR_NOT_FOUND, ERR_INPUT


def _resolve_snapshot_id(client: ForwardClient, network_id: str, snapshot_arg: str) -> str:
    """The /security-matrix endpoint rejects 'latestProcessed' — it requires a numeric id.
    Resolve the sentinel to the network's most recent processed snapshot.
    """
    if snapshot_arg and snapshot_arg.isdigit():
        return snapshot_arg
    snaps = client.get(f"/api/networks/{network_id}/snapshots")
    items = snaps if isinstance(snaps, list) else (snaps.get("snapshots") if isinstance(snaps, dict) else None)
    if not items:
        emit_error(ERR_NOT_FOUND, f"could not list snapshots for network {network_id} to resolve '{snapshot_arg}'")
    # Prefer processed snapshots, newest first
    def _key(s):
        return (
            1 if str(s.get("state", "")).upper() == "PROCESSED" else 0,
            s.get("processedAtMillis") or s.get("creationDateMillis") or s.get("id") or 0,
        )
    items = sorted([s for s in items if isinstance(s, dict)], key=_key, reverse=True)
    if not items:
        emit_error(ERR_NOT_FOUND, f"no usable snapshots in network {network_id}")
    return str(items[0].get("id"))


def _resolve_filter_id(client: ForwardClient, network_id: str, filter_arg: str | None) -> str:
    """Accept --filter-id 0|<id> directly, or --filter <name> resolved by listing."""
    if filter_arg is None:
        return "0"
    if filter_arg.isdigit():
        return filter_arg
    data = client.get(f"/api/networks/{network_id}/securityMatrixFilters")
    filters = data.get("filters") if isinstance(data, dict) else data
    if not isinstance(filters, list):
        emit_error(ERR_API, f"could not list filters for network {network_id}")
    needle = filter_arg.lower()
    for f in filters:
        if isinstance(f, dict) and str(f.get("name", "")).lower() == needle:
            return str(f.get("id"))
    matches = [f for f in filters if isinstance(f, dict) and needle in str(f.get("name", "")).lower()]
    if len(matches) == 1:
        return str(matches[0].get("id"))
    if not matches:
        emit_error(ERR_NOT_FOUND, f"no security-matrix filter named '{filter_arg}' in network {network_id}")
    names = ", ".join(str(m.get("name")) for m in matches)
    emit_error(ERR_INPUT, f"filter name '{filter_arg}' is ambiguous; matches: {names}")


def _pool_label(p: Any) -> str:
    """Best-effort label for a resource-pool entry."""
    if isinstance(p, str):
        return p
    if isinstance(p, dict):
        return str(p.get("name") or p.get("displayName") or p.get("id") or p.get("label") or p)
    return str(p)


def _cell_verdict(cell: Any) -> str:
    """Extract a single verdict string from a matrix cell.

    Forward's cells look like {"sampleQuery": {...}, "connectivityLevel": "OPEN|NO_ROUTE|..."}.
    Older / plain shapes (already-stringified verdicts) pass through unchanged.
    """
    if cell is None:
        return ""
    if isinstance(cell, str):
        return cell
    if isinstance(cell, dict):
        return str(
            cell.get("connectivityLevel")
            or cell.get("verdict")
            or cell.get("status")
            or cell.get("level")
            or ""
        )
    return str(cell)


def _normalize_to_matrix(raw: dict) -> dict:
    """Normalize Forward's response into {zones: [...], cells: [[verdict, ...], ...]}.

    Authoritative shape (from /api/networks/{id}/security-matrix):
        {
          "srcResourcePools": [<pool>, ...],
          "dstResourcePools": [<pool>, ...],
          "matrix": [[{"sampleQuery":..., "connectivityLevel":"OPEN|NO_ROUTE|..."}, ...], ...]
        }

    Fallback shapes accepted: {zones, matrix}, {zones, cells}.
    """
    if not isinstance(raw, dict):
        return {"zones": [], "cells": []}

    # Authoritative shape
    if isinstance(raw.get("matrix"), list) and (
        "srcResourcePools" in raw or "dstResourcePools" in raw
    ):
        srcs = [_pool_label(p) for p in (raw.get("srcResourcePools") or [])]
        dsts = [_pool_label(p) for p in (raw.get("dstResourcePools") or [])]
        cells = [[_cell_verdict(c) for c in row] for row in raw["matrix"]]
        # When src and dst pool lists are identical (the common "everything ↔ everything" case),
        # collapse to a single zone axis so the grid is square and the renderer is happy.
        if srcs == dsts:
            return {"zones": srcs, "cells": cells}
        return {"src_zones": srcs, "dst_zones": dsts, "zones": srcs, "cells": cells}

    # Fallback A: pre-flattened {zones, matrix}
    if isinstance(raw.get("zones"), list) and isinstance(raw.get("matrix"), list):
        return {
            "zones": raw["zones"],
            "cells": [[_cell_verdict(c) for c in row] for row in raw["matrix"]],
        }

    # Fallback B: already {zones, cells}
    if isinstance(raw.get("zones"), list) and isinstance(raw.get("cells"), list):
        cells = raw["cells"]
        # cells may be 2-D verdict strings or 2-D cell-objects
        if cells and isinstance(cells[0], list):
            return {
                "zones": raw["zones"],
                "cells": [[_cell_verdict(c) for c in row] for row in cells],
            }
        return {"zones": raw["zones"], "cells": cells}

    return {"zones": [], "cells": []}


def main() -> int:
    p = argparse.ArgumentParser(description="Retrieve the Forward security matrix.")
    p.add_argument("--network-id", required=True)
    p.add_argument("--snapshot-id", default="latestProcessed",
                   help="Snapshot ID, or 'latestProcessed' (default).")
    grp = p.add_mutually_exclusive_group()
    grp.add_argument("--filter-id", help="Numeric filter id; '0' is the default/global filter.")
    grp.add_argument("--filter", dest="filter_name",
                     help="Filter by name (resolved by listing). Use '0' or --filter-id 0 for default.")
    p.add_argument("--shape", choices=["raw", "matrix", "cell"], default="matrix",
                   help="raw=passthrough, matrix=normalize for forward-report-table, cell=single cell + drill-down hint.")
    p.add_argument("--src", help="Source zone — required when --shape cell.")
    p.add_argument("--dst", help="Destination zone — required when --shape cell.")
    args = p.parse_args()

    if args.shape == "cell" and (not args.src or not args.dst):
        emit_error(ERR_INPUT, "--shape cell requires both --src and --dst")

    try:
        client = ForwardClient.from_env()
        filter_id = _resolve_filter_id(client, args.network_id, args.filter_id or args.filter_name)
        snapshot_id = _resolve_snapshot_id(client, args.network_id, args.snapshot_id)
        data = client.get(
            f"/api/networks/{args.network_id}/security-matrix",
            query={"filterId": filter_id, "snapshotId": snapshot_id},
        )
    except NotFoundError as e:
        emit_error(ERR_NOT_FOUND, f"not found: {e}")
    except ForwardError as e:
        emit_error(ERR_API, str(e))

    base_meta = {
        "network_id": args.network_id,
        "snapshot_id": snapshot_id,
        "filter_id": filter_id,
        "shape": args.shape,
    }

    if args.shape == "raw":
        emit_success(data, meta=base_meta)
        return 0

    matrix = _normalize_to_matrix(data if isinstance(data, dict) else {})

    if args.shape == "matrix":
        emit_success(matrix, meta={**base_meta, "zone_count": len(matrix.get("zones", []))})
        return 0

    # cell
    zones = matrix["zones"]
    if args.src not in zones or args.dst not in zones:
        emit_error(ERR_INPUT, f"src '{args.src}' or dst '{args.dst}' not in matrix zones: {zones}")
    si = zones.index(args.src)
    di = zones.index(args.dst)
    verdict = matrix["cells"][si][di]
    suggested = (
        f"python3 \"$CLAUDE_PLUGIN_ROOT/skills/forward-path-analysis/scripts/run_path.py\" "
        f"--snapshot-id {snapshot_id} --src-zone {args.src!r} --dst-zone {args.dst!r}"
    )
    emit_success(
        {
            "src": args.src,
            "dst": args.dst,
            "verdict": verdict,
            "filter_id": filter_id,
            "snapshot_id": snapshot_id,
            "drill_down": suggested,
        },
        meta=base_meta,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
