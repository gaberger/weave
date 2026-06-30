#!/usr/bin/env python3
"""Bulk-import security-matrix filters into a Forward network.

Reads a JSON array of stripped filter objects (name, resourcePools, timeoutMins,
optional protocolExclusions) — typically the `*.import.json` produced by
hand-stripping the audit fields off a `list_matrix_filters.py` response —
and POSTs each one to the target network.

Per-filter failures are recorded and the loop continues; the final exit code
is non-zero iff at least one filter failed. Existing filters on the target
(matched by name) are SKIPPED by default; pass --on-conflict=fail to abort,
or --on-conflict=replace to delete-then-recreate.
"""
import argparse
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401

from forward_client import ForwardClient, ForwardError, NotFoundError
from skill_io import emit_success, emit_error, ERR_API, ERR_INPUT, ERR_NOT_FOUND, ERR_EMPTY


_REQUIRED = ("name", "resourcePools")
_ALLOWED = {"name", "resourcePools", "protocolExclusions", "timeoutMins"}

_POOL_REQUIRED_KEYS = {
    "DEVICE_ZONE": {"type", "name", "device", "zone"},
    "ON_PREM":     {"type", "name"},
    "CLOUD":       {"type", "name"},
}
_POOL_ALLOWED_KEYS = {
    "DEVICE_ZONE": {"type", "name", "device", "zone"},
    "ON_PREM":     {"type", "name", "devices", "vrfs", "subnets"},
    "CLOUD":       {"type", "name", "subnets", "securityGroups"},
}


def _load_filters(path: str) -> list[dict]:
    try:
        text = Path(path).read_text()
    except OSError as e:
        emit_error(ERR_INPUT, f"cannot read {path!r}: {e}")
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        emit_error(ERR_INPUT, f"{path!r} is not valid JSON: {e}")
    if not isinstance(data, list):
        emit_error(ERR_INPUT, f"{path!r} must contain a top-level JSON array of filter objects")
    if not data:
        emit_error(ERR_EMPTY, f"{path!r} contains an empty array — nothing to import")
    return data


def _validate(item: Any, idx: int) -> tuple[bool, str]:
    """Mirror the server-side rules from provideInvalidMatrixFilters."""
    if not isinstance(item, dict):
        return False, f"filters[{idx}] is not an object"
    for k in _REQUIRED:
        if k not in item:
            return False, f"filters[{idx}] missing required field {k!r}"
    name = item.get("name")
    if not isinstance(name, str) or not name.strip():
        return False, f"filters[{idx}].name must be a non-empty string"
    pools = item.get("resourcePools")
    if not isinstance(pools, list) or not pools:
        return False, f"filters[{idx}].resourcePools must be a non-empty array"
    for j, p in enumerate(pools):
        if not isinstance(p, dict):
            return False, f"filters[{idx}].resourcePools[{j}] must be an object"
        t = p.get("type")
        if t not in _POOL_REQUIRED_KEYS:
            return False, (f"filters[{idx}].resourcePools[{j}].type must be one of "
                           f"{sorted(_POOL_REQUIRED_KEYS)}, got {t!r}")
        missing_pk = _POOL_REQUIRED_KEYS[t] - p.keys()
        if missing_pk:
            return False, (f"filters[{idx}].resourcePools[{j}] (type={t}) missing required "
                           f"field(s) {sorted(missing_pk)}")
        extra_pk = p.keys() - _POOL_ALLOWED_KEYS[t]
        if extra_pk:
            return False, (f"filters[{idx}].resourcePools[{j}] (type={t}) has unsupported "
                           f"field(s) {sorted(extra_pk)}")
        if not isinstance(p.get("name"), str) or not p["name"].strip():
            return False, f"filters[{idx}].resourcePools[{j}].name must be a non-empty string"
    extra = set(item) - _ALLOWED
    if extra:
        return False, f"filters[{idx}] has unsupported field(s) {sorted(extra)} (the server rejects unknown keys)"
    return True, ""


def _existing_filters_by_name(client: ForwardClient, network_id: str) -> dict[str, str]:
    try:
        data = client.get(f"/api/networks/{network_id}/securityMatrixFilters")
    except NotFoundError:
        emit_error(ERR_NOT_FOUND, f"target network {network_id} not found on this Forward instance")
    filters = data.get("filters") if isinstance(data, dict) else data
    if not isinstance(filters, list):
        return {}
    out: dict[str, str] = {}
    for f in filters:
        if isinstance(f, dict):
            n, fid = f.get("name"), f.get("id")
            if isinstance(n, str) and fid:
                out[n] = str(fid)
    return out


def main() -> int:
    p = argparse.ArgumentParser(description="Bulk-import security-matrix filters into a Forward network")
    p.add_argument("--network-id", required=True, help="Target network id to import filters into")
    p.add_argument("--input", required=True, help="Path to a JSON array of stripped filter objects")
    p.add_argument(
        "--on-conflict",
        choices=("skip", "fail", "replace"),
        default="skip",
        help="Behavior when a filter with the same name exists on the target (default: skip)",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate inputs and report what would happen, without calling the API",
    )
    args = p.parse_args()

    items = _load_filters(args.input)

    # Preflight validation — fail the whole batch BEFORE any writes if any are malformed.
    invalid: list[str] = []
    for i, item in enumerate(items):
        ok, msg = _validate(item, i)
        if not ok:
            invalid.append(msg)
    if invalid:
        # Preflight failure — refuse to start the import. Keep the exit code at 2
        # (distinct from a partial-failure run) but emit the contract envelope.
        emit_error(ERR_INPUT,
                   "preflight validation failed — refusing to start the import: "
                   + "; ".join(invalid),
                   exit_code=2)

    if args.dry_run:
        try:
            client = ForwardClient.from_env()
            existing = _existing_filters_by_name(client, args.network_id)
        except ForwardError as e:
            emit_error(ERR_API, str(e))
        plan = []
        for item in items:
            name = item["name"]
            action = "create"
            if name in existing:
                action = {"skip": "skip", "fail": "fail", "replace": "replace"}[args.on_conflict]
            plan.append({"name": name, "action": action, "existingId": existing.get(name)})
        emit_success(plan, meta={"dry_run": True, "network_id": args.network_id, "total": len(items)})
        return 0

    try:
        client = ForwardClient.from_env()
        existing = _existing_filters_by_name(client, args.network_id)
    except ForwardError as e:
        emit_error(ERR_API, str(e))

    created: list[dict] = []
    skipped: list[dict] = []
    replaced: list[dict] = []
    failed: list[dict] = []

    for i, item in enumerate(items):
        name = item["name"]
        existing_id = existing.get(name)

        if existing_id is not None:
            if args.on_conflict == "skip":
                skipped.append({"index": i, "name": name, "existingId": existing_id})
                continue
            if args.on_conflict == "fail":
                failed.append({
                    "index": i, "name": name,
                    "error": f"filter named {name!r} already exists (id={existing_id}); --on-conflict=fail",
                })
                continue
            # replace: delete first, then create
            try:
                client.delete(f"/api/networks/{args.network_id}/securityMatrixFilters/{existing_id}")
            except ForwardError as e:
                failed.append({"index": i, "name": name, "error": f"delete-before-replace failed: {e}"})
                continue

        try:
            result = client.post(
                f"/api/networks/{args.network_id}/securityMatrixFilters",
                body=item,
            )
        except ForwardError as e:
            failed.append({"index": i, "name": name, "error": str(e)})
            continue

        new_id = None
        if isinstance(result, dict):
            new_id = result.get("id")
        record = {"index": i, "name": name, "id": new_id}
        (replaced if existing_id is not None else created).append(record)

    # Per-filter failures are part of the data, not a skill failure: under the
    # contract the exit code means "did the skill run", so we always exit 0 and
    # surface the failed count in meta for parsers to branch on.
    meta = {
        "network_id": args.network_id,
        "total": len(items),
        "created": len(created),
        "replaced": len(replaced),
        "skipped": len(skipped),
        "failed": len(failed),
    }
    emit_success(
        {
            "created": created,
            "replaced": replaced,
            "skipped": skipped,
            "failed": failed,
        },
        meta=meta,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
