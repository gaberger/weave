#!/usr/bin/env python3
"""
Improved NQE catalog search with:
- Ranked results (doesn't require ALL terms to match)
- Fuzzy matching (handles hyphens, plurals, stemming)
- Category-aware boosting
- Query suggestion ("Did you mean...?")
"""
import argparse
import sys
import re
from pathlib import Path
from collections import defaultdict
from typing import List, Dict, Any, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401

from forward_client import ForwardError, load_catalog
from skill_io import emit_error, emit_success, ERR_API, ERR_INPUT


# Synonym/stem mapping for common network terms
SYNONYMS = {
    "bgp": ["bgp", "border gateway"],
    "ospf": ["ospf", "open shortest path"],
    "route": ["route", "routing", "routed"],
    "policy": ["policy", "policies"],
    "prefix": ["prefix", "prefixes"],
    "map": ["map", "maps", "mapping"],
    "list": ["list", "lists", "acl", "access-list"],
    "interface": ["interface", "interfaces", "int", "port"],
    "vlan": ["vlan", "vlans", "vlan-id"],
    "acl": ["acl", "access-list", "access list"],
    "filter": ["filter", "filtering", "filters"],
    "peer": ["peer", "peering", "neighbor", "neighbour"],
    "session": ["session", "sessions", "connection"],
    "security": ["security", "stig", "compliance", "audit"],
}


def normalize_token(token: str) -> List[str]:
    """
    Normalize a search token to multiple variants.

    Examples:
        "route-map" → ["route", "map", "routemap", "route-map"]
        "routing" → ["route", "routing", "routed"]
        "BGP" → ["bgp", "border gateway"]
    """
    token_lower = token.lower().strip()

    # Base forms
    variants = [token_lower]

    # Handle hyphenated terms (route-map → route, map, routemap)
    if "-" in token_lower:
        variants.extend(token_lower.split("-"))
        variants.append(token_lower.replace("-", ""))
        variants.append(token_lower.replace("-", " "))

    # Handle underscored terms
    if "_" in token_lower:
        variants.extend(token_lower.split("_"))
        variants.append(token_lower.replace("_", ""))

    # Apply synonyms/stems
    for key, syns in SYNONYMS.items():
        if token_lower in syns or token_lower == key:
            variants.extend(syns)

    # Remove duplicates, keep order
    seen = set()
    unique_variants = []
    for v in variants:
        if v not in seen:
            seen.add(v)
            unique_variants.append(v)

    return unique_variants


def tokenize_text(text: str) -> List[str]:
    """
    Tokenize text into searchable words.

    Handles hyphens, slashes, underscores as separators.
    """
    # Replace separators with spaces
    text = re.sub(r'[-_/]', ' ', text)
    # Extract words (alphanumeric)
    tokens = re.findall(r'\b\w+\b', text.lower())
    return tokens


def score_query(query: Dict[str, Any], search_terms: List[str]) -> Tuple[int, int, int, str]:
    """
    Score a query based on search terms.

    Returns tuple for sorting: (matches, path_matches, path_length, path)
    Higher matches = better
    Shorter path = better (for tie-breaking)
    """
    path = query.get("path", "")
    intent = query.get("intent", "") or ""
    category = category_of(path)

    path_tokens = set(tokenize_text(path))
    intent_tokens = set(tokenize_text(intent)) if intent else set()

    total_matches = 0
    path_matches = 0

    for term in search_terms:
        # Normalize term to variants
        variants = normalize_token(term)

        # Check if ANY variant matches path tokens
        if any(v in path_tokens for v in variants):
            total_matches += 1
            path_matches += 1
        # Check if ANY variant matches intent tokens
        elif any(v in intent_tokens for v in variants):
            total_matches += 1

    # Category boost (if search terms mention common categories)
    category_boost = 0
    category_terms = ["security", "stig", "l3", "bgp", "ospf", "vlan", "interface"]
    for ct in category_terms:
        if any(ct in t.lower() for t in search_terms) and ct in category.lower():
            category_boost = 1
            break

    # Return score tuple (negative for sorting: more matches first)
    return (-total_matches - category_boost, -path_matches, len(path), path)


def category_of(path: str) -> str:
    parts = [p for p in path.split("/") if p]
    return parts[0] if parts else ""


def suggest_queries(search_terms: List[str], queries: List[Dict[str, Any]], limit: int = 3) -> List[str]:
    """
    Suggest alternative search terms based on common categories/paths.
    """
    suggestions = []

    # If no search terms, suggest browsing categories
    if not search_terms:
        return ["Try: --list-categories to see available categories"]

    # Collect common terms from paths
    term_counts = defaultdict(int)
    for q in queries:
        path_tokens = tokenize_text(q.get("path", ""))
        for token in path_tokens:
            if len(token) > 3:  # Ignore short tokens
                term_counts[token] += 1

    # Find common terms not in search
    search_lower = set(t.lower() for t in search_terms)
    common_terms = sorted(term_counts.items(), key=lambda x: -x[1])[:20]

    for term, count in common_terms:
        if term not in search_lower and count > 10:
            # Check if term is related to search terms
            for search_term in search_terms:
                variants = normalize_token(search_term)
                if term in variants:
                    suggestions.append(f"Try: {term} (appears in {count} queries)")
                    break
        if len(suggestions) >= limit:
            break

    return suggestions


def main() -> int:
    p = argparse.ArgumentParser(
        description="Smart search over NQE catalog with ranking and fuzzy matching",
        epilog="""
Examples:
  # Search with ranking (doesn't require ALL terms)
  %(prog)s bgp route map

  # Search handles hyphens and variants
  %(prog)s route-map     # Matches "route map", "routemap", "route-map"

  # Category filter
  %(prog)s bgp --category L3

  # List categories
  %(prog)s --list-categories

  # Show suggestions
  %(prog)s routing policy --suggest

Improvements over search_catalog.py:
  - Ranks by relevance (doesn't require ALL terms)
  - Handles hyphens (route-map vs "route map")
  - Synonym matching (routing → route, peer → neighbor)
  - Category-aware boosting
  - Query suggestions
        """
    )
    p.add_argument("terms", nargs="*", help="Search terms (ranked by relevance, not ALL required)")
    p.add_argument("--category", help="Filter to a top-level category")
    p.add_argument("--repo", choices=["fwd", "org"], help="Filter to a repo")
    p.add_argument("--min-matches", type=int, default=1,
                   help="Minimum number of search terms that must match (default: 1)")
    p.add_argument("--limit", type=int, default=20, help="Max results (default 20)")
    p.add_argument("--list-categories", action="store_true",
                   help="Print category counts")
    p.add_argument("--suggest", action="store_true",
                   help="Show search suggestions based on catalog")
    p.add_argument("--debug", action="store_true",
                   help="Show scoring details for debugging")
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

    # Apply filters first (category, repo)
    filtered_queries = queries
    if args.category:
        filtered_queries = [q for q in filtered_queries if category_of(q.get("path", "")) == args.category]
    if args.repo:
        filtered_queries = [q for q in filtered_queries if q.get("repo") == args.repo]

    # If no search terms, return filtered results
    if not args.terms:
        results = []
        for q in filtered_queries[:args.limit]:
            results.append({
                "queryId": q.get("queryId"),
                "path": q.get("path"),
                "category": category_of(q.get("path", "")),
                "repo": q.get("repo"),
                "intent": q.get("intent"),
                "lastCommitId": q.get("lastCommitId"),
            })
        emit_success(results, meta={
            "count": len(filtered_queries),
            "truncated": len(filtered_queries) > args.limit,
            "catalogEnriched": any(q.get("intent") for q in filtered_queries),
        })
        return 0

    # Score all queries
    scored_results = []
    for q in filtered_queries:
        score = score_query(q, args.terms)
        matches = -score[0]  # Negate back to positive

        # Filter by min_matches
        if matches < args.min_matches:
            continue

        scored_results.append({
            "queryId": q.get("queryId"),
            "path": q.get("path"),
            "category": category_of(q.get("path", "")),
            "repo": q.get("repo"),
            "intent": q.get("intent"),
            "lastCommitId": q.get("lastCommitId"),
            "_score": score,
            "_matches": matches,
        })

    # Sort by score
    scored_results.sort(key=lambda r: r["_score"])

    # Remove internal fields unless debug
    if not args.debug:
        for r in scored_results:
            r.pop("_score", None)
            r.pop("_matches", None)

    # Generate suggestions
    suggestions = []
    if args.suggest or len(scored_results) == 0:
        suggestions = suggest_queries(args.terms, queries)

    truncated = len(scored_results) > args.limit
    meta = {
        "count": len(scored_results),
        "truncated": truncated,
        "catalogEnriched": any(q.get("intent") for q in queries),
        "intentCoverage": sum(1 for q in queries if q.get("intent")),
    }

    if suggestions:
        meta["suggestions"] = suggestions

    emit_success(scored_results[:args.limit], meta=meta)
    return 0


if __name__ == "__main__":
    sys.exit(main())
