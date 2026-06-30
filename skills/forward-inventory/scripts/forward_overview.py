#!/usr/bin/env python3
"""Step-0 grounding call.

Returns a single shaped response that pins the substrate before any
operational investigation: networks (with snapshot counts and processed-at
timestamps), inferred default network and snapshot when unambiguous, and a
brief "you are here" summary. Read by Claude at the start of any operational
session so the rest of the conversation runs in substrate terms (pinned
network id, snapshot id) instead of pseudo-conversational hand-waving.

Output (always JSON on stdout) — wrapped in the skill envelope, the answer
under ``data``:

    {
      "ok": true, "schema": 1,
      "data": {
        "networks": [
          {"id": "465", "name": "topologyyml-...", "snapshotCount": 12,
           "latestProcessedSnapshot": {"id": "1008", "processedAtMillis": ..., "creationDateMillis": ...}}
        ],
        "defaults": {
          "networkId": "465",        # only set when there is exactly 1 network
          "snapshotId": "1008",      # only set when defaults.networkId is set AND that network has processed snapshots
          "reason": "single network in tenant; using latest processed snapshot"
        },
        "summary": "1 network, 12 snapshots, latest processed 2026-05-04. Defaults pinned: net=465 snap=1008."
      },
      "meta": {"network_count": 1}
    }
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401

from forward_client import ForwardClient, ForwardError, AuthError, NotFoundError
from skill_io import emit_success, emit_error, ERR_API, ERR_AUTH, ERR_NOT_FOUND


def _fmt_ms(ms: Any) -> str:
    if not isinstance(ms, (int, float)) or ms <= 0:
        return ""
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def _latest_processed(snaps: list[dict]) -> dict | None:
    processed = [s for s in snaps if str(s.get("state", "")).upper() == "PROCESSED"]
    if not processed:
        return None
    processed.sort(
        key=lambda s: s.get("processedAtMillis") or s.get("creationDateMillis") or 0,
        reverse=True,
    )
    return processed[0]


def main() -> int:
    p = argparse.ArgumentParser(description="Step-0 grounding for Forward investigations.")
    p.add_argument(
        "--max-snapshots-per-network",
        type=int,
        default=1,
        help="How many recent snapshots to summarize per network (default 1: just the latest processed).",
    )
    args = p.parse_args()

    try:
        client = ForwardClient.from_env()
        networks = client.get("/api/networks")
    except AuthError as e:
        emit_error(ERR_AUTH, str(e), hint="check FORWARD_API_KEY / FORWARD_API_SECRET in .env")
    except NotFoundError as e:
        emit_error(ERR_NOT_FOUND, str(e))
    except ForwardError as e:
        emit_error(ERR_API, str(e))

    if not isinstance(networks, list):
        emit_error(ERR_API, f"unexpected /api/networks response shape: {type(networks).__name__}")

    out_networks: list[dict] = []
    for n in networks:
        if not isinstance(n, dict):
            continue
        nid = n.get("id")
        nname = n.get("name") or n.get("displayName") or ""
        try:
            snaps = client.get(f"/api/networks/{nid}/snapshots")
        except ForwardError:
            snaps = []
        if isinstance(snaps, dict) and "snapshots" in snaps:
            snaps = snaps["snapshots"]
        if not isinstance(snaps, list):
            snaps = []
        latest = _latest_processed(snaps)
        out_networks.append(
            {
                "id": str(nid) if nid is not None else "",
                "name": nname,
                "snapshotCount": len(snaps),
                "latestProcessedSnapshot": (
                    {
                        "id": str(latest.get("id", "")),
                        "processedAtMillis": latest.get("processedAtMillis"),
                        "processedAt": _fmt_ms(latest.get("processedAtMillis")),
                        "creationDateMillis": latest.get("creationDateMillis"),
                    }
                    if latest
                    else None
                ),
            }
        )

    # Inferred defaults — only when unambiguous
    defaults: dict[str, Any] = {}
    if len(out_networks) == 1:
        only = out_networks[0]
        defaults["networkId"] = only["id"]
        if only.get("latestProcessedSnapshot"):
            defaults["snapshotId"] = only["latestProcessedSnapshot"]["id"]
            defaults["reason"] = "single network in tenant; using latest processed snapshot"
        else:
            defaults["reason"] = "single network in tenant; no processed snapshots"
    else:
        defaults["reason"] = f"{len(out_networks)} networks present — ask the user which (or pass --network-id)"

    # Human-readable one-liner so Claude can reuse it verbatim in its first message.
    if len(out_networks) == 1:
        only = out_networks[0]
        summary_bits = [f"1 network ({only['name'] or only['id']})"]
        summary_bits.append(f"{only['snapshotCount']} snapshot(s)")
        if only.get("latestProcessedSnapshot"):
            ts = only["latestProcessedSnapshot"].get("processedAt") or ""
            summary_bits.append(f"latest processed {ts}".rstrip())
            summary_bits.append(f"defaults: net={defaults['networkId']} snap={defaults['snapshotId']}")
        summary = "; ".join(summary_bits) + "."
    else:
        names = ", ".join(f"{n['id']}={n['name'] or '(unnamed)'}" for n in out_networks[:5])
        more = "" if len(out_networks) <= 5 else f" (+{len(out_networks)-5} more)"
        summary = f"{len(out_networks)} networks: {names}{more}. No default pinned."

    emit_success(
        {"networks": out_networks, "defaults": defaults, "summary": summary},
        meta={"network_count": len(out_networks)},
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
