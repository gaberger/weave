#!/usr/bin/env python3
"""Offline keyword search over the bundled NQE catalog.

Each catalog record is at minimum {path, queryId, lastCommitId, sourceCodeSha}.
After ``refresh_catalog.py``, records also carry ``repo`` (fwd|org) and — when
refreshed with ``--enrich`` — a one-line ``intent`` summary distilled from the
query source. Search matches against ``path`` by default and additionally
against ``intent`` when present, so semantic queries like "ssh timeout" match
STIGs whose path is just an opaque control ID.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401 — side-effect: puts forward_client on sys.path

from forward_client import ForwardError, load_catalog
from skill_io import emit_error, emit_success, ERR_API, ERR_INPUT


def category_of(path: str) -> str:
    parts = [p for p in path.split("/") if p]
    return parts[0] if parts else ""


def main() -> int:
    p = argparse.ArgumentParser(description="Search the bundled NQE catalog")
    p.add_argument("terms", nargs="*", help="Case-insensitive terms that must all appear (path + intent)")
    p.add_argument("--category", help="Filter to a top-level category (e.g. Security, L3, Cloud)")
    p.add_argument("--repo", choices=["fwd", "org"],
                   help="Filter to a repo (only effective on a refreshed catalog).")
    p.add_argument("--path-only", action="store_true",
                   help="Match only against path, ignore intent text. Default matches both.")
    p.add_argument("--limit", type=int, default=20, help="Max results (default 20)")
    p.add_argument("--list-categories", action="store_true",
                   help="Instead of searching, print category counts")
    args = p.parse_args()

    try:
        queries = load_catalog(__file__)
    except ForwardError as e:
        emit_error(ERR_API, str(e))

    if args.list_categories:
        counts: dict = {}
        for q in queries:
            c = category_of(q.get("path", ""))
            counts[c] = counts.get(c, 0) + 1
        out = sorted(({"category": c, "count": n} for c, n in counts.items()),
                     key=lambda r: -r["count"])
        emit_success(out, meta={"total": len(queries)})
        return 0

    if not args.terms and not args.category and not args.repo:
        emit_error(ERR_INPUT,
                   "provide at least one search term, or --category, --repo, or --list-categories")

    needles = [t.lower() for t in args.terms]
    results = []
    enriched_count = 0
    for q in queries:
        path = q.get("path", "")
        intent = q.get("intent", "") or ""
        if intent:
            enriched_count += 1
        if args.category and category_of(path) != args.category:
            continue
        if args.repo and q.get("repo") != args.repo:
            continue
        hay = path.lower() if args.path_only else f"{path}\n{intent}".lower()
        if needles and not all(n in hay for n in needles):
            continue
        # Score: path-hits ranked first, then by path length.
        path_lower = path.lower()
        path_hits = sum(1 for n in needles if n in path_lower)
        results.append({
            "queryId": q.get("queryId"),
            "path": path,
            "category": category_of(path),
            "repo": q.get("repo"),
            "intent": intent or None,
            "lastCommitId": q.get("lastCommitId"),
            "_score": (-path_hits, len(path), path_lower),
        })

    results.sort(key=lambda r: r["_score"])
    for r in results:
        r.pop("_score", None)
    truncated = len(results) > args.limit
    emit_success(results[: args.limit], meta={
        "count": len(results),
        "truncated": truncated,
        "catalogEnriched": enriched_count > 0,
        "intentCoverage": enriched_count,
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
