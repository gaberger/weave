"""Shared helpers for forward-bgp-prefix scripts.

All four BGP-prefix endpoints hang off a single network/snapshot scope and key
off a normalized CIDR. `bgp-prefix-search` is the entry point: its `origin` and
`devicesByOutcome` entries are full `BgpNodeInfo` records ({device, vrf,
locationId, routerId}) that `bgp-prefix-details` requires verbatim — a bare
{device, vrf} is rejected server-side. So `resolve_node` round-trips `search`
to turn a friendly --device/--vrf into the full node the API demands.
"""
from __future__ import annotations

import argparse
import ipaddress
import sys
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401 — side-effect: puts forward_client on sys.path

from forward_client import ForwardClient, ForwardError  # noqa: F401

# BgpTraceOutcome enum accepted by bgp-prefix-trace (server-confirmed).
OUTCOMES = ("INSTALLED", "NOT_PREFERRED", "FILTERED_OUT")


def add_scope_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--network-id", required=True, help="Forward network ID")
    parser.add_argument(
        "--snapshot-id",
        help="Snapshot ID (defaults to the network's latest processed snapshot)",
    )


def scope_query(args: argparse.Namespace) -> dict:
    """Query params common to every call. snapshotId is optional — the server
    falls back to the latest processed snapshot when it's omitted."""
    q: dict[str, str] = {}
    if getattr(args, "snapshot_id", None):
        q["snapshotId"] = args.snapshot_id
    return q


def validate_prefix(prefix: str) -> str:
    """Validate and normalize a CIDR to its network address form.

    The RIB stores network-address prefixes (e.g. 10.24.0.0/24), so a host IP
    inside the block (10.24.0.5/24) is normalized to match. Raises ForwardError
    on anything that isn't a valid CIDR."""
    try:
        net = ipaddress.ip_network(prefix.strip(), strict=False)
    except ValueError as e:
        raise ForwardError(f"--prefix {prefix!r} is not a valid CIDR: {e}")
    return str(net)


def search(client: ForwardClient, network_id: str, prefix: str, query: dict) -> Any:
    """POST /bgp-prefix-search — the keystone read. Returns
    {origin: [BgpNodeInfo], devicesByOutcome: {OUTCOME: [BgpNodeInfo]}}."""
    return client.post(
        f"/api/networks/{network_id}/bgp-prefix-search",
        {"prefix": prefix},
        query=query or None,
    )


def _collect_nodes(search_result: Any) -> list:
    """Flatten origin + every devicesByOutcome bucket into a deduped node list."""
    pools = list(search_result.get("origin", []) or [])
    for bucket in (search_result.get("devicesByOutcome", {}) or {}).values():
        pools.extend(bucket or [])
    nodes, seen = [], set()
    for n in pools:
        key = (n.get("device"), n.get("vrf"))
        if key in seen:
            continue
        seen.add(key)
        nodes.append(n)
    return nodes


def resolve_node(
    client: ForwardClient,
    network_id: str,
    prefix: str,
    device: str,
    vrf: Optional[str],
    query: dict,
) -> dict:
    """Resolve a full BgpNodeInfo for --device[/--vrf] by searching the prefix.

    bgp-prefix-details needs the complete {device, vrf, locationId, routerId};
    this finds the matching record. Raises ForwardError with the available
    nodes when there's no match, or asks for --vrf when a device carries the
    prefix in more than one VRF."""
    nodes = _collect_nodes(search(client, network_id, prefix, query))
    matches = [
        n for n in nodes
        if n.get("device") == device and (vrf is None or n.get("vrf") == vrf)
    ]
    if not matches:
        avail = ", ".join(f"{n.get('device')}/{n.get('vrf')}" for n in nodes) or "(none)"
        raise ForwardError(
            f"prefix {prefix} not present on {device}"
            f"{('/' + vrf) if vrf else ''}. Nodes carrying it: {avail}"
        )
    if len(matches) > 1:
        opts = ", ".join(f"{n.get('device')}/{n.get('vrf')}" for n in matches)
        raise ForwardError(
            f"{device} carries {prefix} in multiple VRFs: {opts}. Narrow with --vrf."
        )
    return matches[0]


def resolve_origin(
    client: ForwardClient,
    network_id: str,
    prefix: str,
    query: dict,
    origin_device: Optional[str],
    origin_vrf: str,
) -> dict:
    """Determine the {device, vrf} a trace originates from.

    Explicit --origin-device wins. Otherwise pull it from search's `origin`
    list: unambiguous when there's exactly one origin, else error and list
    them so the caller can pick."""
    if origin_device:
        return {"device": origin_device, "vrf": origin_vrf}
    origins = search(client, network_id, prefix, query).get("origin", []) or []
    if not origins:
        raise ForwardError(
            f"prefix {prefix} has no origin in this snapshot — nothing to trace."
        )
    if len(origins) > 1:
        opts = ", ".join(f"{o.get('device')}/{o.get('vrf')}" for o in origins)
        raise ForwardError(
            f"prefix {prefix} has multiple origins: {opts}. "
            "Pick one with --origin-device / --origin-vrf."
        )
    o = origins[0]
    return {"device": o.get("device"), "vrf": o.get("vrf")}
