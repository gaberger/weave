#!/usr/bin/env python3
"""Run a filtered subset of NQE STIG queries and aggregate results.

Catalog subtree: /Security/STIGs/<vendor>/<platform>/<control>

STIG queries in the catalog use two different row dialects. Per-query the
script detects which is in use and counts violations accordingly:

  1. ``rows-on-violation`` (Cisco, Juniper, F5 legacy): a row only appears
     when the control is failing. rowCount == violation count.

  2. ``indicator-field`` (Palo Alto, newer controls): one row per audited
     device with a boolean violation indicator. violation count == rows where
     the indicator is true.

The indicator field is detected by scanning the first row for a boolean-typed
key matching one of ``violation``/``isViolation``/``hasViolation`` (true = bad)
or ``passes``/``passed``/``compliant`` (false = bad). Both casings accepted.
"""
import argparse
import sys
import time
import urllib.parse
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401 — side-effect: puts forward_client on sys.path

from forward_client import ForwardClient, ForwardError, emit_json, die, load_catalog


SAFE_DEFAULT_LIMIT = 50

# Field-name dialects we recognize. Order matters: first match wins.
_VIOLATION_TRUE_KEYS = ("violation", "isViolation", "hasViolation", "violated")
_VIOLATION_FALSE_KEYS = ("passes", "passed", "compliant", "isCompliant")


def _find_field(row: dict, candidates: tuple) -> str | None:
    """Return the first key in `row` whose lowercase matches any candidate
    (also lowercased) AND whose value is a bool."""
    lower_map = {k.lower(): k for k in row.keys()}
    for cand in candidates:
        actual = lower_map.get(cand.lower())
        if actual is not None and isinstance(row[actual], bool):
            return actual
    return None


def count_violations(items: Any) -> tuple[int, str, str | None]:
    """Decide how many of `items` are real violations.

    Returns ``(violation_count, detection_method, field_name)``:
        - detection_method is one of ``rows-on-violation``, ``indicator-field``,
          ``inverted-indicator-field``, or ``no-rows``.
        - field_name is the key inspected, or None.
    """
    if not isinstance(items, list) or not items:
        return 0, "no-rows", None
    first = items[0] if isinstance(items[0], dict) else None
    if first is None:
        # Not dict rows — treat as legacy: every row is a violation.
        return len(items), "rows-on-violation", None

    # Indicator-true pattern: `violation: true` means violation.
    key = _find_field(first, _VIOLATION_TRUE_KEYS)
    if key:
        count = sum(1 for r in items if isinstance(r, dict) and r.get(key) is True)
        return count, "indicator-field", key

    # Inverted pattern: `passes: false` means violation.
    key = _find_field(first, _VIOLATION_FALSE_KEYS)
    if key:
        count = sum(1 for r in items if isinstance(r, dict) and r.get(key) is False)
        return count, "inverted-indicator-field", key

    # Legacy: no indicator field — row-present-implies-violation.
    return len(items), "rows-on-violation", None


def filter_stigs(queries: list, vendor: str, platform: str, path_contains: str) -> list:
    out = []
    for q in queries:
        path = q.get("path", "")
        if not path.startswith("/Security/STIGs/"):
            continue
        parts = [p for p in path.split("/") if p]
        # parts = ['Security', 'STIGs', <vendor>, <platform>, <control>, ...]
        if vendor and (len(parts) < 3 or parts[2] != vendor):
            continue
        if platform and (len(parts) < 4 or parts[3] != platform):
            continue
        if path_contains and path_contains.lower() not in path.lower():
            continue
        out.append(q)
    return out


def run_one(client: ForwardClient, network_id: str, snapshot_id: str | None,
            query_id: str, row_limit: int) -> dict:
    body: dict = {"queryId": query_id}
    if row_limit:
        body["queryOptions"] = {"limit": row_limit}
    qs = {"networkId": network_id}
    if snapshot_id:
        qs["snapshotId"] = snapshot_id
    path = "/api/nqe?" + urllib.parse.urlencode(qs)
    return client.post(path, body)


def main() -> int:
    p = argparse.ArgumentParser(description="Run a filtered subset of STIG queries and aggregate")
    p.add_argument("--network-id", help="Required unless --dry-run")
    p.add_argument("--snapshot-id", help="Snapshot ID (defaults to latest processed)")
    p.add_argument("--vendor", help="e.g. Cisco, Juniper, F5, 'Palo Alto Networks'")
    p.add_argument("--platform", help="Exact platform name, e.g. 'Cisco IOS Router RTR'")
    p.add_argument("--path-contains", help="Additional substring filter on full path")
    p.add_argument("--limit-queries", type=int, default=SAFE_DEFAULT_LIMIT,
                   help=f"Cap total queries executed (default {SAFE_DEFAULT_LIMIT}; 0 = no cap)")
    p.add_argument("--row-limit", type=int, default=500,
                   help="Per-query row limit (default 500)")
    p.add_argument("--dry-run", action="store_true",
                   help="List matched STIGs without executing")
    args = p.parse_args()

    try:
        queries = load_catalog(__file__)
    except ForwardError as e:
        die(str(e))

    matched = filter_stigs(queries, args.vendor or "", args.platform or "", args.path_contains or "")
    if not matched:
        die("no STIG queries matched your filters")

    selected = matched if args.limit_queries == 0 else matched[: args.limit_queries]
    if args.limit_queries and len(matched) > args.limit_queries:
        sys.stderr.write(
            f"note: {len(matched)} STIGs matched; capped at {args.limit_queries} "
            f"(use --limit-queries 0 to run all)\n"
        )

    if args.dry_run:
        emit_json({
            "mode": "dry-run",
            "matched": len(matched),
            "selected": len(selected),
            "queries": [
                {"path": q.get("path"), "queryId": q.get("queryId")}
                for q in selected
            ],
        })
        return 0

    if not args.network_id:
        die("--network-id is required unless --dry-run is set")

    # Loud warning for long-running sweeps
    if len(selected) > SAFE_DEFAULT_LIMIT:
        sys.stderr.write(
            f"warning: running {len(selected)} STIG queries sequentially. "
            f"This will take several minutes.\n"
        )

    try:
        client = ForwardClient.from_env()
        client.timeout = max(client.timeout, 120)
    except ForwardError as e:
        die(str(e))

    results = []
    api_errors = 0
    queries_with_violations = 0
    total_violation_rows = 0
    dialect_counts: dict[str, int] = {}

    for i, q in enumerate(selected, start=1):
        path = q.get("path", "")
        qid = q.get("queryId", "")
        sys.stderr.write(f"[{i}/{len(selected)}] {path}\n")
        t0 = time.time()
        try:
            resp = run_one(client, args.network_id, args.snapshot_id, qid, args.row_limit)
            items = resp.get("items") if isinstance(resp, dict) else None
            row_count = len(items) if isinstance(items, list) else 0
            violation_count, method, field = count_violations(items)
            dialect_counts[method] = dialect_counts.get(method, 0) + 1
            if violation_count > 0:
                queries_with_violations += 1
                total_violation_rows += violation_count
            results.append({
                "path": path,
                "queryId": qid,
                "durationSec": round(time.time() - t0, 2),
                "rowCount": row_count,
                "violationRowCount": violation_count,
                "detectionMethod": method,
                "indicatorField": field,
                "items": items if isinstance(items, list) else resp,
            })
        except ForwardError as e:
            api_errors += 1
            results.append({
                "path": path,
                "queryId": qid,
                "durationSec": round(time.time() - t0, 2),
                "error": str(e),
            })

    emit_json({
        "summary": {
            "matched": len(matched),
            "selected": len(selected),
            "executed": len(results),
            "api_errors": api_errors,
            "queries_with_violations": queries_with_violations,
            "total_violation_rows": total_violation_rows,
            "dialects": dialect_counts,
        },
        "results": results,
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
