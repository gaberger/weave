#!/usr/bin/env python3
"""Create a Forward security-matrix filter on a network.

Mirrors the server-side validation from `provideInvalidMatrixFilters`:
  - `name` must be present and non-empty.
  - `resourcePools` must be present and non-empty.
  - Items in `resourcePools` must be objects, not arbitrary maps. We can't
    fully validate the zone shape client-side, so we forward whatever JSON
    the user supplies and let the server reject malformed entries.
  - `timeoutMins` is the field name (NOT `timeoutSecs`/`timoutSecs`).
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401

from forward_client import ForwardClient, ForwardError, emit_json, die


# IANA protocol numbers — small lookup so users don't have to memorize them.
_PROTO_ALIASES = {
    "icmp": 1, "igmp": 2, "tcp": 6, "udp": 17,
    "gre": 47, "esp": 50, "ah": 51, "icmpv6": 58, "ospf": 89,
}


def _parse_protocols(raw: str) -> list[int]:
    out: list[int] = []
    for token in (t.strip() for t in raw.split(",") if t.strip()):
        if token.isdigit():
            n = int(token)
        elif token.lower() in _PROTO_ALIASES:
            n = _PROTO_ALIASES[token.lower()]
        else:
            raise ValueError(f"unknown protocol {token!r} (use IANA number or one of {sorted(_PROTO_ALIASES)})")
        if not 0 <= n <= 255:
            raise ValueError(f"protocol number {n} out of range 0..255")
        out.append(n)
    return out


_POOL_REQUIRED_KEYS = {
    "DEVICE_ZONE": {"type", "name", "device", "zone"},
    "ON_PREM":     {"type", "name"},   # devices/vrfs/subnets all optional but at least one usually present
    "CLOUD":       {"type", "name"},   # subnets/securityGroups optional but at least one usually present
}
_POOL_ALLOWED_KEYS = {
    "DEVICE_ZONE": {"type", "name", "device", "zone"},
    "ON_PREM":     {"type", "name", "devices", "vrfs", "subnets"},
    "CLOUD":       {"type", "name", "subnets", "securityGroups"},
}


def _validate_pool(pool: dict, idx: int) -> None:
    t = pool.get("type")
    if t not in _POOL_REQUIRED_KEYS:
        die(f"resourcePools[{idx}].type must be one of {sorted(_POOL_REQUIRED_KEYS)}, got {t!r}")
    missing = _POOL_REQUIRED_KEYS[t] - pool.keys()
    if missing:
        die(f"resourcePools[{idx}] (type={t}) missing required field(s) {sorted(missing)}")
    extra = pool.keys() - _POOL_ALLOWED_KEYS[t]
    if extra:
        die(f"resourcePools[{idx}] (type={t}) has unsupported field(s) {sorted(extra)}")
    if not isinstance(pool.get("name"), str) or not pool["name"].strip():
        die(f"resourcePools[{idx}].name must be a non-empty string")


def _load_resource_pools(path: str):
    try:
        text = Path(path).read_text()
    except OSError as e:
        die(f"cannot read --resource-pools-file {path!r}: {e}")
    try:
        pools = json.loads(text)
    except json.JSONDecodeError as e:
        die(f"--resource-pools-file is not valid JSON: {e}")
    if not isinstance(pools, list):
        die("--resource-pools-file must contain a JSON array of resource-pool objects")
    if not pools:
        die("resourcePools is empty — at least one entry is required")
    for i, item in enumerate(pools):
        if not isinstance(item, dict):
            die(f"resourcePools[{i}] is not an object")
        _validate_pool(item, i)
    return pools


def main() -> int:
    p = argparse.ArgumentParser(description="Create a security-matrix filter on a Forward network")
    p.add_argument("--network-id", required=True)
    p.add_argument("--name", required=True, help="Filter name (must be non-empty)")
    p.add_argument(
        "--resource-pools-file",
        required=True,
        help="Path to a JSON file containing the resourcePools array (zone objects)",
    )
    p.add_argument(
        "--exclude-protocols",
        help="Comma-separated IANA protocol numbers or aliases (e.g. 'udp,esp' or '17,50')",
    )
    p.add_argument(
        "--timeout-mins",
        type=int,
        default=30,
        help="Per-cell evaluation timeout in minutes (default: 30)",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the request body that would be POSTed and exit (no API call)",
    )
    args = p.parse_args()

    name = args.name.strip()
    if not name:
        die("--name is empty after trimming whitespace; the server requires a non-empty name")

    resource_pools = _load_resource_pools(args.resource_pools_file)

    body: dict = {
        "name": name,
        "resourcePools": resource_pools,
        "timeoutMins": args.timeout_mins,
    }
    if args.exclude_protocols:
        try:
            body["protocolExclusions"] = _parse_protocols(args.exclude_protocols)
        except ValueError as e:
            die(str(e))

    if args.dry_run:
        emit_json({"method": "POST",
                   "path": f"/api/networks/{args.network_id}/securityMatrixFilters",
                   "body": body})
        return 0

    try:
        client = ForwardClient.from_env()
        result = client.post(
            f"/api/networks/{args.network_id}/securityMatrixFilters",
            body=body,
        )
    except ForwardError as e:
        die(str(e))

    # POST may return the created filter, an array, or empty 2xx — normalize.
    if result is None:
        emit_json({"created": True, "echo": body})
    else:
        emit_json(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
