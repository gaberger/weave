#!/usr/bin/env python3
"""Add a hypothetical BGP advertisement to a Forward change-set.

POST /api/networks/{networkId}/change-sets/{changesetId}
        /devices/{deviceName}/bgp-advertisements?action=add

Body shape (mirrors what the UI sends — note empty-string sentinels for
optional fields, not nulls / omission):

    {
      "vrf":          "default",
      "externalPeer": "10.0.0.34",
      "type":         "EBGP",
      "prefix":       "10.202.0.0/24",
      "nextHop":      "10.0.0.34",
      "origin":       "IGP",
      "localPref":    "",        # int as string, or "" to omit
      "asPath":       [4259971172],
      "med":          ""         # int as string, or "" to omit
    }

`asPath` accepts ints (4-byte ASNs are fine, e.g. 4259971172). The script
also accepts asdot notation ("65000.36") and converts to a single 32-bit int.
"""
import argparse
import ipaddress
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401

from forward_client import ForwardClient, ForwardError, emit_json, die


_VALID_TYPES = {"EBGP", "IBGP"}
_VALID_ORIGINS = {"IGP", "EGP", "INCOMPLETE"}


def _parse_asn(token: str) -> int:
    """Accept '65001', '65000.36', or any 32-bit ASN as int. Reject negatives."""
    t = token.strip()
    if not t:
        raise ValueError("empty ASN")
    if "." in t:
        # asdot: high.low, each in 0..65535
        hi, lo = t.split(".", 1)
        if not (hi.isdigit() and lo.isdigit()):
            raise ValueError(f"invalid asdot ASN {token!r}")
        h, l = int(hi), int(lo)
        if not (0 <= h <= 0xFFFF and 0 <= l <= 0xFFFF):
            raise ValueError(f"asdot fields out of range in {token!r}")
        return (h << 16) | l
    if not t.isdigit():
        raise ValueError(f"invalid ASN {token!r}")
    n = int(t)
    if not 0 <= n <= 0xFFFFFFFF:
        raise ValueError(f"ASN {n} out of 32-bit range")
    return n


def _parse_as_path(raw: str) -> list[int]:
    return [_parse_asn(tok) for tok in raw.split(",") if tok.strip()]


def _validate_prefix(p: str) -> None:
    try:
        ipaddress.ip_network(p, strict=False)
    except ValueError as e:
        die(f"--prefix {p!r}: {e}")


def _validate_ip(label: str, v: str) -> None:
    try:
        ipaddress.ip_address(v)
    except ValueError as e:
        die(f"--{label} {v!r}: {e}")


def _opt_int_str(label: str, v: str | None) -> str:
    """Forward sends empty-string for unset numeric fields. Honor that."""
    if v is None or v == "":
        return ""
    if not v.lstrip("-").isdigit():
        die(f"--{label} must be an integer or empty, got {v!r}")
    return v


def main() -> int:
    p = argparse.ArgumentParser(
        description="Add a Predict BGP advertisement to a change-set"
    )
    p.add_argument("--network-id", required=True)
    p.add_argument("--changeset-id", required=True, help="e.g. CHG-7")
    p.add_argument("--device", required=True, help="Origin device name (e.g. us-border-1)")
    p.add_argument("--prefix", required=True, help="CIDR e.g. 10.202.0.0/24")
    p.add_argument("--next-hop", required=True, help="Next-hop IP")
    p.add_argument("--external-peer", required=True, help="External peer IP")
    p.add_argument("--vrf", default="default")
    p.add_argument("--type", dest="ad_type", default="EBGP", choices=sorted(_VALID_TYPES))
    p.add_argument("--origin", default="IGP", choices=sorted(_VALID_ORIGINS))
    p.add_argument(
        "--as-path",
        default="",
        help="Comma-separated ASNs, e.g. '4259971172' or '65001,65002'. asdot accepted.",
    )
    p.add_argument("--local-pref", default="", help="Integer or '' to omit")
    p.add_argument("--med", default="", help="Integer or '' to omit")
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the request body that would be POSTed and exit",
    )
    args = p.parse_args()

    _validate_prefix(args.prefix)
    _validate_ip("next-hop", args.next_hop)
    _validate_ip("external-peer", args.external_peer)

    try:
        as_path = _parse_as_path(args.as_path) if args.as_path else []
    except ValueError as e:
        die(str(e))

    body = {
        "vrf": args.vrf,
        "externalPeer": args.external_peer,
        "type": args.ad_type,
        "prefix": args.prefix,
        "nextHop": args.next_hop,
        "origin": args.origin,
        "localPref": _opt_int_str("local-pref", args.local_pref),
        "asPath": as_path,
        "med": _opt_int_str("med", args.med),
    }

    path = (
        f"/api/networks/{args.network_id}/change-sets/{args.changeset_id}"
        f"/devices/{args.device}/bgp-advertisements"
    )

    if args.dry_run:
        emit_json({"method": "POST", "path": path, "query": {"action": "add"}, "body": body})
        return 0

    try:
        client = ForwardClient.from_env()
        result = client.post(path, body, query={"action": "add"})
    except ForwardError as e:
        die(str(e))

    if result is None:
        emit_json({"added": True, "device": args.device, "echo": body})
    else:
        emit_json(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
