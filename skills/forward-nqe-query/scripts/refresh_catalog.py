#!/usr/bin/env python3
"""Refresh the bundled NQE catalog from a live Forward instance.

Closes the discovery gap caused by the bundled snapshot drifting from server
state, and adds two pieces of metadata the bundled file lacks:

  - ``repo``   — which repo each query lives in (``fwd`` or ``org``); the old
                 catalog had no flag, so callers had to try both.
  - ``intent`` — a one-line summary distilled from the query source, when
                 ``--enrich`` is set. Lets ``search_catalog.py`` match on what
                 a query *does*, not just where it lives in the path tree.

Endpoints used:
  GET /api/nqe/repos/{repo}/commits/head/queries
      → list every query in {repo}; expected to return the same record shape
        as the bundled file ({path, queryId, lastCommitId, sourceCodeSha}).
  GET /api/nqe/repos/{repo}/commits/{commitId}/queries?path={path}
      → fetch source per query (used only with --enrich).

Output is written in-place to wherever ``find_catalog`` resolves, preserving
the ``{queries, accessSettings}`` envelope. Override with --output.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401

from forward_client import (
    ForwardClient,
    ForwardError,
    NotFoundError,
    die,
    emit_json,
    find_catalog,
)


REPOS_DEFAULT = ("fwd", "org")


def list_queries(client: ForwardClient, repo: str) -> list[dict]:
    """List every query in the given repo at HEAD.

    Forward returns either a bare list or an object containing ``queries``;
    handle both.
    """
    endpoint = f"/api/nqe/repos/{repo}/commits/head/queries"
    data = client.get(endpoint)
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        if isinstance(data.get("queries"), list):
            return data["queries"]
    raise ForwardError(f"unexpected response shape from {endpoint}: {type(data).__name__}")


def distill_intent(source_code: str, intent_field: str | None) -> str:
    """Pick the best one-line description from a query's source.

    Order: explicit ``intent`` field from the API → first non-empty docstring/
    comment line → first non-empty code line truncated.
    """
    if intent_field:
        return intent_field.strip().splitlines()[0][:200]
    if not source_code:
        return ""
    for raw in source_code.splitlines():
        line = raw.strip()
        if not line:
            continue
        # Strip leading comment markers used in NQE / docstrings
        for prefix in ("///", "//", "#", "/**", "/*", "*"):
            if line.startswith(prefix):
                line = line[len(prefix):].strip()
                break
        if line.endswith("*/"):
            line = line[:-2].strip()
        if line:
            return line[:200]
    return ""


def enrich(client: ForwardClient, record: dict, throttle_ms: int) -> dict:
    """Fetch source and attach a one-line ``intent`` to the record."""
    repo = record.get("repo")
    commit = record.get("lastCommitId") or "head"
    path = record.get("path", "")
    if not repo or not path:
        return record
    endpoint = f"/api/nqe/repos/{repo}/commits/{commit}/queries"
    try:
        src = client.get(endpoint, query={"path": path})
    except NotFoundError:
        return record
    if isinstance(src, dict):
        record["intent"] = distill_intent(
            src.get("sourceCode", ""),
            src.get("intent") or src.get("description"),
        )
    if throttle_ms:
        time.sleep(throttle_ms / 1000.0)
    return record


def main() -> int:
    p = argparse.ArgumentParser(description="Refresh the bundled NQE catalog from live Forward")
    p.add_argument("--repo", choices=["fwd", "org"], action="append",
                   help="Limit to one repo (repeatable). Default: fwd + org.")
    p.add_argument("--output", help="Write refreshed catalog here (default: in-place).")
    p.add_argument("--enrich", action="store_true",
                   help="Also fetch each query's source to attach a one-line `intent`. SLOW (~1879 calls).")
    p.add_argument("--throttle-ms", type=int, default=20,
                   help="Sleep between enrich requests (default 20ms).")
    p.add_argument("--dry-run", action="store_true",
                   help="Print summary only; do not write the file.")
    args = p.parse_args()

    repos = tuple(args.repo) if args.repo else REPOS_DEFAULT

    try:
        client = ForwardClient.from_env()
    except ForwardError as e:
        die(str(e))

    merged: list[dict] = []
    seen: set[tuple[str, str]] = set()
    per_repo_counts: dict[str, int] = {}

    for repo in repos:
        try:
            rows = list_queries(client, repo)
        except NotFoundError:
            per_repo_counts[repo] = 0
            continue
        except ForwardError as e:
            die(f"listing repo {repo!r}: {e}")
        per_repo_counts[repo] = len(rows)
        for row in rows:
            key = (repo, row.get("queryId") or row.get("path", ""))
            if key in seen:
                continue
            seen.add(key)
            row["repo"] = repo
            merged.append(row)

    if not merged:
        die("no queries returned — check FORWARD_API_BASE_URL and credentials")

    if args.enrich:
        for i, rec in enumerate(merged):
            enrich(client, rec, args.throttle_ms)
            if i % 100 == 0:
                sys.stderr.write(f"  enriched {i}/{len(merged)}\n")
        sys.stderr.write(f"  enriched {len(merged)}/{len(merged)}\n")

    if args.dry_run:
        emit_json({
            "total": len(merged),
            "perRepo": per_repo_counts,
            "enriched": args.enrich,
        })
        return 0

    out_path = Path(args.output) if args.output else find_catalog(__file__)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # Preserve the envelope shape that load_catalog expects.
    existing_envelope: dict = {}
    if out_path.is_file():
        try:
            with out_path.open("r") as f:
                existing_envelope = json.load(f)
        except (OSError, ValueError):
            existing_envelope = {}
    envelope = {
        "queries": merged,
        "accessSettings": existing_envelope.get("accessSettings", {}),
    }
    with out_path.open("w") as f:
        json.dump(envelope, f, indent=2)

    emit_json({
        "wrote": str(out_path),
        "total": len(merged),
        "perRepo": per_repo_counts,
        "enriched": args.enrich,
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
