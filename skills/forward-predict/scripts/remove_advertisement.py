#!/usr/bin/env python3
"""Remove a hypothetical BGP advertisement from a Forward change-set.

POST /api/networks/{networkId}/change-sets/{changesetId}
        /devices/{deviceName}/bgp-advertisements?action=remove

The server identifies advertisements by content, not id. To save the user
from having to copy-paste the full record, this script:

  1. GETs the change-set (?view=summary).
  2. Finds the device's addedAdvertisements with matching --prefix and
     (optionally) --next-hop / --external-peer / --vrf / --type.
  3. If exactly one matches, sends it back as the remove body.
     If 0 match -> error. If >1 match -> error with the candidates printed.
  4. Always requires --yes to actually issue the POST.

Use --dry-run to see which record would be removed without calling action=remove.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401

from forward_client import ForwardClient, ForwardError
from skill_io import emit_error, emit_success, ERR_API, ERR_INPUT, ERR_NOT_FOUND


def _matches(ad: dict, args) -> bool:
    if ad.get("prefix") != args.prefix:
        return False
    if args.next_hop and ad.get("nextHop") != args.next_hop:
        return False
    if args.external_peer and ad.get("externalPeer") != args.external_peer:
        return False
    if args.vrf and ad.get("vrf") != args.vrf:
        return False
    if args.ad_type and ad.get("type") != args.ad_type:
        return False
    return True


def main() -> int:
    p = argparse.ArgumentParser(
        description="Remove a Predict BGP advertisement from a change-set"
    )
    p.add_argument("--network-id", required=True)
    p.add_argument("--changeset-id", required=True)
    p.add_argument("--device", required=True)
    p.add_argument("--prefix", required=True, help="CIDR of the advertisement to remove")
    p.add_argument("--next-hop", help="Disambiguator if multiple advertisements share --prefix")
    p.add_argument("--external-peer", help="Disambiguator")
    p.add_argument("--vrf", help="Disambiguator")
    p.add_argument("--type", dest="ad_type", choices=["EBGP", "IBGP"], help="Disambiguator")
    p.add_argument("--yes", action="store_true", help="Required to actually remove (destructive)")
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Show the matched record and the request that would be sent, without calling the API",
    )
    args = p.parse_args()

    try:
        client = ForwardClient.from_env()
        cs = client.get(
            f"/api/networks/{args.network_id}/change-sets/{args.changeset_id}",
            query={"view": "summary"},
        )
    except ForwardError as e:
        emit_error(ERR_API, str(e))

    if "deviceToChanges" not in cs:
        emit_error(
            ERR_API,
            f"change-set {args.changeset_id} summary does not include deviceToChanges — "
            "this Forward server only exposes view=summary which omits advertisement details; "
            "cannot locate the advertisement to remove",
        )

    dev_changes = (cs.get("deviceToChanges") or {}).get(args.device) or {}
    ads = dev_changes.get("addedAdvertisements") or []
    if not ads:
        emit_error(
            ERR_NOT_FOUND,
            f"no addedAdvertisements on device {args.device} in change-set "
            f"{args.changeset_id}",
        )

    matches = [a for a in ads if _matches(a, args)]
    if not matches:
        emit_error(
            ERR_NOT_FOUND,
            f"no advertisement on {args.device} matches the given filters "
            f"(prefix={args.prefix!r}, vrf={args.vrf!r}, nextHop={args.next_hop!r}, "
            f"externalPeer={args.external_peer!r}, type={args.ad_type!r})",
        )
    if len(matches) > 1:
        # Ambiguous filters — preserve exit code 2 and surface the candidates so
        # the user can re-issue with more disambiguators.
        candidates = "; ".join(str(m) for m in matches)
        emit_error(
            ERR_INPUT,
            f"{len(matches)} advertisements match — narrow with --next-hop / "
            f"--external-peer / --vrf / --type",
            hint=f"candidates: {candidates}",
            exit_code=2,
        )

    target = matches[0]
    path = (
        f"/api/networks/{args.network_id}/change-sets/{args.changeset_id}"
        f"/devices/{args.device}/bgp-advertisements"
    )

    meta = {
        "device": args.device,
        "network_id": args.network_id,
        "changeset_id": args.changeset_id,
        "prefix": args.prefix,
    }

    if args.dry_run:
        emit_success(
            {"method": "POST", "path": path, "query": {"action": "remove"}, "body": target},
            meta={**meta, "dry_run": True},
        )
        return 0

    if not args.yes:
        emit_error(ERR_INPUT, "removal is destructive; pass --yes to confirm")

    try:
        result = client.post(path, target, query={"action": "remove"})
    except ForwardError as e:
        emit_error(ERR_API, str(e))

    if result is None:
        emit_success(
            {"removed": True, "device": args.device, "advertisement": target}, meta=meta
        )
    else:
        emit_success(result, meta=meta)
    return 0


if __name__ == "__main__":
    sys.exit(main())
