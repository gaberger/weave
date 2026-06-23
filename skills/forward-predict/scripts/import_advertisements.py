#!/usr/bin/env python3
"""Bulk-add Predict BGP advertisements to a change-set from a JSON file.

The input file must be a JSON array. Each element is one of:

  A) Per-device wrapper (preferred — mirrors the change-set shape):
     [
       {
         "device": "us-border-1",
         "advertisements": [
           {"vrf":"default","externalPeer":"10.0.0.34","type":"EBGP",
            "prefix":"10.202.0.0/24","nextHop":"10.0.0.34","origin":"IGP",
            "asPath":[4259971172],"localPref":"","med":""},
           ...
         ]
       },
       ...
     ]

  B) Flat — each item carries its own "device":
     [
       {"device":"us-border-1", "vrf":"default", "type":"EBGP", "prefix":"...", ...},
       ...
     ]

Sends one POST per advertisement (the API has no documented batch shape).
On any failure, prints what succeeded so far and stops — re-running the same
input is safe only if you remove already-added rows yourself; the API has no
upsert semantic, so duplicates may produce 4xx.

Use --dry-run to print every request body without calling the API.
Use --continue-on-error to keep going after a failed POST (records the error
in the result summary instead of exiting).
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401

from forward_client import ForwardClient, ForwardError, emit_json, die


_REQUIRED = {"vrf", "externalPeer", "type", "prefix", "nextHop", "origin"}
_VALID_TYPES = {"EBGP", "IBGP"}
_VALID_ORIGINS = {"IGP", "EGP", "INCOMPLETE"}


def _normalize(items):
    """Yield (device, advertisement) pairs from either input form."""
    for i, item in enumerate(items):
        if not isinstance(item, dict):
            die(f"input[{i}] is not an object")
        if "advertisements" in item:
            dev = item.get("device")
            if not isinstance(dev, str) or not dev.strip():
                die(f"input[{i}].device must be a non-empty string")
            ads = item.get("advertisements")
            if not isinstance(ads, list) or not ads:
                die(f"input[{i}].advertisements must be a non-empty array")
            for j, ad in enumerate(ads):
                if not isinstance(ad, dict):
                    die(f"input[{i}].advertisements[{j}] is not an object")
                yield dev, ad
        else:
            dev = item.get("device")
            if not isinstance(dev, str) or not dev.strip():
                die(f"input[{i}].device must be a non-empty string (flat form)")
            ad = {k: v for k, v in item.items() if k != "device"}
            yield dev, ad


def _validate_ad(ad: dict, where: str) -> None:
    missing = _REQUIRED - ad.keys()
    if missing:
        die(f"{where} missing required field(s) {sorted(missing)}")
    if ad.get("type") not in _VALID_TYPES:
        die(f"{where}.type must be one of {sorted(_VALID_TYPES)}, got {ad.get('type')!r}")
    if ad.get("origin") not in _VALID_ORIGINS:
        die(f"{where}.origin must be one of {sorted(_VALID_ORIGINS)}, got {ad.get('origin')!r}")
    if not isinstance(ad.get("asPath", []), list):
        die(f"{where}.asPath must be an array of integers")
    # Forward expects empty-string sentinels, not nulls — coerce.
    ad.setdefault("asPath", [])
    ad.setdefault("localPref", "")
    ad.setdefault("med", "")


def main() -> int:
    p = argparse.ArgumentParser(description="Bulk-add Predict BGP advertisements")
    p.add_argument("--network-id", required=True)
    p.add_argument("--changeset-id", required=True)
    p.add_argument("--input-file", required=True, help="Path to JSON file (see module docstring)")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument(
        "--continue-on-error",
        action="store_true",
        help="Don't stop on first failure; record per-row errors in the summary",
    )
    args = p.parse_args()

    try:
        text = Path(args.input_file).read_text()
    except OSError as e:
        die(f"cannot read --input-file {args.input_file!r}: {e}")
    try:
        items = json.loads(text)
    except json.JSONDecodeError as e:
        die(f"--input-file is not valid JSON: {e}")
    if not isinstance(items, list) or not items:
        die("--input-file must contain a non-empty JSON array")

    pairs = list(_normalize(items))
    for k, (dev, ad) in enumerate(pairs):
        _validate_ad(ad, f"input row {k} (device={dev})")

    if args.dry_run:
        emit_json([
            {
                "method": "POST",
                "path": (
                    f"/api/networks/{args.network_id}/change-sets/{args.changeset_id}"
                    f"/devices/{dev}/bgp-advertisements"
                ),
                "query": {"action": "add"},
                "body": ad,
            }
            for dev, ad in pairs
        ])
        return 0

    try:
        client = ForwardClient.from_env()
    except ForwardError as e:
        die(str(e))

    summary = {"total": len(pairs), "succeeded": 0, "failed": 0, "results": []}
    for k, (dev, ad) in enumerate(pairs):
        path = (
            f"/api/networks/{args.network_id}/change-sets/{args.changeset_id}"
            f"/devices/{dev}/bgp-advertisements"
        )
        try:
            resp = client.post(path, ad, query={"action": "add"})
            summary["succeeded"] += 1
            summary["results"].append({"row": k, "device": dev, "ok": True, "response": resp})
        except ForwardError as e:
            summary["failed"] += 1
            summary["results"].append({"row": k, "device": dev, "ok": False, "error": str(e)})
            if not args.continue_on_error:
                emit_json(summary)
                return 1

    emit_json(summary)
    return 0 if summary["failed"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
