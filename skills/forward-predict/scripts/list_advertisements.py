#!/usr/bin/env python3
"""List BGP advertisements added to a change-set, optionally for one device.

Reads the change-set with ?view=summary and projects
deviceToChanges[*].addedAdvertisements into a flat array. Output shape:

    [
      {
        "device": "us-border-1",
        "vrf": "default",
        "type": "EBGP",
        "prefix": "10.202.0.0/24",
        "nextHop": "10.0.0.34",
        "externalPeer": "10.0.0.34",
        "origin": "IGP",
        "asPath": [4259971172],
        "localPref": "",
        "med": ""
      },
      ...
    ]

Use --device to filter to a single device. Use --json to print the raw
projection; without it, a compact human-readable summary goes to stdout
followed by the JSON (the model uses both).
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401

from forward_client import ForwardClient, ForwardError
from skill_io import emit_error, emit_success, ERR_API


def _collect(changeset: dict, device_filter: str | None) -> list[dict]:
    out: list[dict] = []
    for dev, changes in (changeset.get("deviceToChanges") or {}).items():
        if device_filter and dev != device_filter:
            continue
        for ad in (changes or {}).get("addedAdvertisements") or []:
            row = {"device": dev}
            row.update(ad)
            out.append(row)
    return out


def _render_human(rows: list[dict], meta) -> None:
    """Compact human summary, then the JSON array for downstream consumers."""
    changeset_id = meta.get("changeset_id")
    device = meta.get("device")
    if not rows:
        scope = f" on {device}" if device else ""
        sys.stdout.write(
            f"no added BGP advertisements in change-set {changeset_id}{scope}\n"
        )
        return

    by_dev: dict[str, list[dict]] = {}
    for r in rows:
        by_dev.setdefault(r["device"], []).append(r)
    sys.stdout.write(
        f"{len(rows)} added BGP advertisement(s) across {len(by_dev)} device(s) "
        f"in change-set {changeset_id}:\n"
    )
    for dev, items in by_dev.items():
        sys.stdout.write(f"  {dev}:\n")
        for r in items:
            ap = ",".join(str(a) for a in r.get("asPath") or [])
            sys.stdout.write(
                f"    {r.get('type','?')} vrf={r.get('vrf','?')} "
                f"prefix={r.get('prefix','?')} nextHop={r.get('nextHop','?')} "
                f"peer={r.get('externalPeer','?')} as-path=[{ap}]\n"
            )
    sys.stdout.write("\n")
    json.dump(rows, sys.stdout, indent=2, default=str)
    sys.stdout.write("\n")


def main() -> int:
    p = argparse.ArgumentParser(
        description="List BGP advertisements added to a Forward change-set"
    )
    p.add_argument("--network-id", required=True)
    p.add_argument("--changeset-id", required=True)
    p.add_argument("--device", help="Filter to one device's advertisements")
    p.add_argument(
        "--json",
        action="store_true",
        help="Emit only the JSON array (no human summary)",
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
            "this Forward server only exposes view=summary which omits advertisement details",
        )

    rows = _collect(cs, args.device)

    meta = {
        "count": len(rows),
        "device_count": len({r["device"] for r in rows}),
        "network_id": args.network_id,
        "changeset_id": args.changeset_id,
        "device": args.device,
    }

    # --json selects the machine envelope; otherwise render the human summary
    # (which still appends the raw JSON array — the model uses both).
    emit_success(
        rows,
        meta=meta,
        fmt="json" if args.json else "human",
        human=_render_human,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
