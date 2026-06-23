#!/usr/bin/env python3
"""
NQE Catalog Discovery - Discovery Tool #7

Lists available NQE queries in the Forward catalog and suggests queries
relevant to your discovery needs.

Use when:
- You want to know what device state you CAN query
- Looking for queries related to a specific technology (BGP, OSPF, interfaces, etc.)
- Building custom discovery workflows
- Troubleshooting why other tools can't find data

Would have helped:
- Discover FQ_interface_status for complete interface inventory
- Find FQ_bgp_sessions for route-map audit
- Identify security/compliance queries for intent checks
"""

import sys
import os
import json
import argparse
from typing import Dict, List, Any
from pathlib import Path
from collections import defaultdict
import re

# Add parent directories to path for imports
SCRIPT_DIR = Path(__file__).parent
SKILL_ROOT = SCRIPT_DIR.parent
SKILLS_ROOT = SKILL_ROOT.parent
sys.path.insert(0, str(SKILLS_ROOT / "forward-nqe-query" / "scripts"))

from forward_client import ForwardClient


def get_nqe_catalog(client: ForwardClient, network_id: int) -> List[Dict[str, Any]]:
    """
    Fetch the complete NQE catalog for a network.

    Returns list of available queries with metadata.
    """
    print(f"🔍 Fetching NQE catalog for network {network_id}...", file=sys.stderr)

    try:
        # Use Forward API to list NQE queries
        catalog = client.list_nqe_queries(network_id)
        return catalog
    except Exception as e:
        print(f"⚠️  Could not fetch NQE catalog: {e}", file=sys.stderr)
        # Fallback: return empty list or common queries
        return []


def categorize_queries(queries: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    """
    Categorize NQE queries by technology/purpose.

    Categories based on query ID patterns and names.
    """
    categories = defaultdict(list)

    # Category patterns (regex)
    patterns = {
        "BGP": re.compile(r"bgp|border gateway", re.IGNORECASE),
        "OSPF": re.compile(r"ospf|open shortest path", re.IGNORECASE),
        "Interfaces": re.compile(r"interface|port|link", re.IGNORECASE),
        "Routing": re.compile(r"route|routing|fib|rib", re.IGNORECASE),
        "Security": re.compile(r"security|acl|firewall|policy", re.IGNORECASE),
        "Compliance/STIG": re.compile(r"stig|compliance|audit", re.IGNORECASE),
        "VLANs": re.compile(r"vlan|switchport|trunk", re.IGNORECASE),
        "MAC/ARP": re.compile(r"mac|arp|neighbor", re.IGNORECASE),
        "QoS": re.compile(r"qos|quality of service", re.IGNORECASE),
        "Multicast": re.compile(r"multicast|igmp|pim", re.IGNORECASE),
        "MPLS": re.compile(r"mpls|label", re.IGNORECASE),
        "VPN": re.compile(r"vpn|ipsec|tunnel", re.IGNORECASE),
        "Hardware": re.compile(r"hardware|inventory|module|power|temp", re.IGNORECASE),
        "Device Info": re.compile(r"device|system|version|uptime", re.IGNORECASE)
    }

    for query in queries:
        query_id = query.get("id", "")
        query_name = query.get("name", "")
        query_desc = query.get("description", "")

        # Check which categories this query matches
        matched = False
        search_text = f"{query_id} {query_name} {query_desc}"

        for category, pattern in patterns.items():
            if pattern.search(search_text):
                categories[category].append(query)
                matched = True

        # Catch-all for uncategorized
        if not matched:
            categories["Other"].append(query)

    return dict(categories)


def find_relevant_queries(
    queries: List[Dict[str, Any]],
    keywords: List[str],
    limit: int = 10
) -> List[Dict[str, Any]]:
    """
    Search queries by keywords and rank by relevance.
    """
    if not keywords:
        return queries[:limit]

    # Score each query based on keyword matches
    scored_queries = []
    for query in queries:
        query_id = query.get("id", "").lower()
        query_name = query.get("name", "").lower()
        query_desc = query.get("description", "").lower()
        search_text = f"{query_id} {query_name} {query_desc}"

        score = 0
        for keyword in keywords:
            keyword_lower = keyword.lower()
            # Exact match in ID is highest priority
            if keyword_lower in query_id:
                score += 10
            # Match in name is high priority
            if keyword_lower in query_name:
                score += 5
            # Match in description is lower priority
            if keyword_lower in query_desc:
                score += 1

        if score > 0:
            scored_queries.append((score, query))

    # Sort by score descending
    scored_queries.sort(key=lambda x: x[0], reverse=True)

    return [q for score, q in scored_queries[:limit]]


def suggest_discovery_queries(categories: Dict[str, List[Dict[str, Any]]]) -> Dict[str, List[str]]:
    """
    Suggest queries useful for pre-flight discovery based on categories.
    """
    suggestions = {
        "Physical Topology Discovery": [],
        "Routing Protocol Health": [],
        "Security/Policy Audit": [],
        "Device Inventory": []
    }

    # Map categories to discovery purposes
    if "Interfaces" in categories:
        suggestions["Physical Topology Discovery"].extend([
            q.get("id") for q in categories["Interfaces"][:3]
        ])

    if "BGP" in categories:
        suggestions["Routing Protocol Health"].extend([
            q.get("id") for q in categories["BGP"][:3]
        ])

    if "OSPF" in categories:
        suggestions["Routing Protocol Health"].extend([
            q.get("id") for q in categories["OSPF"][:2]
        ])

    if "Security" in categories:
        suggestions["Security/Policy Audit"].extend([
            q.get("id") for q in categories["Security"][:3]
        ])

    if "Compliance/STIG" in categories:
        suggestions["Security/Policy Audit"].extend([
            q.get("id") for q in categories["Compliance/STIG"][:3]
        ])

    if "Device Info" in categories or "Hardware" in categories:
        device_queries = categories.get("Device Info", []) + categories.get("Hardware", [])
        suggestions["Device Inventory"].extend([
            q.get("id") for q in device_queries[:3]
        ])

    # Remove empty suggestions
    return {k: v for k, v in suggestions.items() if v}


def print_catalog(
    queries: List[Dict[str, Any]],
    categories: Dict[str, List[Dict[str, Any]]],
    format: str = "human",
    show_descriptions: bool = False,
    category_filter: str = None
):
    """Print NQE catalog in requested format."""

    if format == "json":
        print(json.dumps({
            "total_queries": len(queries),
            "categories": {k: [q.get("id") for q in v] for k, v in categories.items()},
            "queries": queries
        }, indent=2))
        return

    # Human-readable format
    print(f"\n{'='*80}")
    print(f"NQE CATALOG DISCOVERY")
    print(f"{'='*80}\n")

    print(f"📊 Total Queries Available: {len(queries)}\n")

    # Category summary
    if not category_filter:
        print(f"{'─'*80}")
        print("CATEGORIES")
        print(f"{'─'*80}\n")

        for category, cat_queries in sorted(categories.items(), key=lambda x: len(x[1]), reverse=True):
            print(f"  {category:25s} {len(cat_queries):3d} queries")

        print()

    # Detailed listings
    categories_to_show = [category_filter] if category_filter and category_filter in categories else categories.keys()

    for category in sorted(categories_to_show):
        if category not in categories:
            continue

        cat_queries = categories[category]
        print(f"{'─'*80}")
        print(f"{category.upper()} ({len(cat_queries)} queries)")
        print(f"{'─'*80}\n")

        for query in sorted(cat_queries, key=lambda q: q.get("id", "")):
            query_id = query.get("id", "unknown")
            query_name = query.get("name", "No name")

            print(f"  • {query_id}")
            if query_name and query_name != query_id:
                print(f"    {query_name}")

            if show_descriptions:
                desc = query.get("description", "")
                if desc:
                    # Wrap description
                    import textwrap
                    wrapped = textwrap.fill(desc, width=74, initial_indent="    ", subsequent_indent="    ")
                    print(wrapped)

            print()


def print_suggestions(suggestions: Dict[str, List[str]]):
    """Print suggested queries for discovery workflows."""

    print(f"\n{'─'*80}")
    print("SUGGESTED QUERIES FOR DISCOVERY WORKFLOWS")
    print(f"{'─'*80}\n")

    for purpose, query_ids in suggestions.items():
        if not query_ids:
            continue

        print(f"📋 {purpose}:")
        for query_id in query_ids:
            print(f"   - {query_id}")
        print()

    print("💡 TIP: Use forward-nqe-query to run these queries:")
    print("   python3 forward-nqe-query/run_query.py --network-id N --query-id <query_id>\n")


def main():
    parser = argparse.ArgumentParser(
        description="Discover available NQE queries for network discovery workflows",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # List all available queries
  %(prog)s --network-id 863

  # Show only BGP-related queries
  %(prog)s --network-id 863 --category BGP

  # Search for specific queries
  %(prog)s --network-id 863 --search "interface status"

  # Show descriptions for all queries
  %(prog)s --network-id 863 --show-descriptions

  # JSON output for automation
  %(prog)s --network-id 863 --format json

Why this is useful:
  - Discover queries you didn't know existed
  - Find queries for specific technologies (BGP, OSPF, interfaces, etc.)
  - Build custom discovery workflows
  - Troubleshoot why other tools can't find data

Integration with other tools:
  - interface_inventory.py uses FQ_interface_status
  - route_map_audit.py uses FQ_bgp_sessions
  - validate_all.py uses multiple queries for comprehensive testing

If a discovery tool fails with "query not found", use this to find the right query.
        """
    )

    parser.add_argument(
        "--network-id",
        type=int,
        required=True,
        help="Forward Networks network ID"
    )

    parser.add_argument(
        "--category",
        type=str,
        help="Show only queries in this category (BGP, Interfaces, Security, etc.)"
    )

    parser.add_argument(
        "--search",
        type=str,
        help="Search queries by keywords (space-separated)"
    )

    parser.add_argument(
        "--show-descriptions",
        action="store_true",
        help="Show query descriptions (verbose)"
    )

    parser.add_argument(
        "--format",
        choices=["human", "json"],
        default="human",
        help="Output format (default: human)"
    )

    parser.add_argument(
        "--suggest",
        action="store_true",
        help="Show suggested queries for common discovery workflows"
    )

    args = parser.parse_args()

    # Initialize client
    client = ForwardClient()

    # Get catalog
    queries = get_nqe_catalog(client, args.network_id)

    if not queries:
        print("❌ No NQE queries found or unable to fetch catalog", file=sys.stderr)
        print("   This may mean:", file=sys.stderr)
        print("   1. The network has no NQE catalog configured", file=sys.stderr)
        print("   2. The Forward API does not support catalog listing", file=sys.stderr)
        print("   3. You may need to use Forward UI to browse queries", file=sys.stderr)
        sys.exit(1)

    # Search mode
    if args.search:
        keywords = args.search.split()
        queries = find_relevant_queries(queries, keywords)

        if not queries:
            print(f"❌ No queries found matching: {args.search}", file=sys.stderr)
            sys.exit(1)

        print(f"\nFound {len(queries)} queries matching '{args.search}':\n")
        for query in queries:
            print(f"  • {query.get('id')} - {query.get('name', 'No name')}")
            if args.show_descriptions:
                desc = query.get("description", "")
                if desc:
                    import textwrap
                    wrapped = textwrap.fill(desc, width=74, initial_indent="    ", subsequent_indent="    ")
                    print(wrapped)
            print()
        sys.exit(0)

    # Categorize
    categories = categorize_queries(queries)

    # Print catalog
    print_catalog(
        queries=queries,
        categories=categories,
        format=args.format,
        show_descriptions=args.show_descriptions,
        category_filter=args.category
    )

    # Suggestions
    if args.suggest or args.format == "human":
        suggestions = suggest_discovery_queries(categories)
        if suggestions:
            print_suggestions(suggestions)


if __name__ == "__main__":
    main()
