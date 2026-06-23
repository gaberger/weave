#!/usr/bin/env python3
"""
Intent Check Violations - Discovery Tool #5

Run ALL intent checks and report violations BEFORE making changes.

Would have caught:
- Any existing policy violations at baseline
- Security violations that pre-dated the change
- Violations that might be MASKED by our "fixes"

This establishes a baseline: "What's already broken?"
"""

import sys
import os
import json
import argparse
from typing import Dict, List, Any
from pathlib import Path

# Add parent directories to path for imports
SCRIPT_DIR = Path(__file__).parent
SKILL_ROOT = SCRIPT_DIR.parent
SKILLS_ROOT = SKILL_ROOT.parent
sys.path.insert(0, str(SKILLS_ROOT / "forward-intent-check" / "scripts"))
sys.path.insert(0, str(SKILLS_ROOT / "forward-nqe-query" / "scripts"))

from forward_client import ForwardClient


def get_all_intent_checks(client: ForwardClient, network_id: int) -> List[Dict[str, Any]]:
    """
    List all available intent checks for this network.
    """
    print(f"🔍 Discovering available intent checks...", file=sys.stderr)

    try:
        # Use Forward API to list intent checks
        # This would use the actual Forward Intent Check API
        checks = client.list_intent_checks(network_id)
        return checks
    except Exception as e:
        print(f"⚠️  Could not list intent checks: {e}", file=sys.stderr)
        # Return empty list if API not available
        return []


def run_intent_check(client: ForwardClient, network_id: int, check_id: str, snapshot_id: int = None) -> Dict[str, Any]:
    """
    Run a single intent check and return results.
    """
    try:
        result = client.run_intent_check(
            network_id=network_id,
            check_id=check_id,
            snapshot_id=snapshot_id
        )
        return result
    except Exception as e:
        return {
            "check_id": check_id,
            "error": str(e),
            "violations": []
        }


def analyze_violations(results: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Analyze intent check results to categorize violations.
    """
    analysis = {
        "total_checks": len(results),
        "checks_run": 0,
        "checks_passed": 0,
        "checks_failed": 0,
        "checks_errored": 0,
        "total_violations": 0,
        "violations_by_severity": {
            "critical": [],
            "high": [],
            "medium": [],
            "low": [],
            "info": []
        },
        "violations_by_check": {},
        "summary": []
    }

    for result in results:
        check_id = result.get("check_id", "unknown")
        check_name = result.get("check_name", check_id)

        if result.get("error"):
            analysis["checks_errored"] += 1
            continue

        analysis["checks_run"] += 1

        violations = result.get("violations", [])
        violation_count = len(violations)

        if violation_count == 0:
            analysis["checks_passed"] += 1
        else:
            analysis["checks_failed"] += 1
            analysis["total_violations"] += violation_count

            # Categorize by severity
            for violation in violations:
                severity = violation.get("severity", "medium").lower()
                if severity not in analysis["violations_by_severity"]:
                    severity = "medium"

                violation_data = {
                    "check_id": check_id,
                    "check_name": check_name,
                    "message": violation.get("message", "No description"),
                    "device": violation.get("device"),
                    "location": violation.get("location"),
                    "recommendation": violation.get("recommendation")
                }

                analysis["violations_by_severity"][severity].append(violation_data)

            # Track violations by check
            analysis["violations_by_check"][check_id] = {
                "check_name": check_name,
                "violation_count": violation_count,
                "violations": violations
            }

    # Generate summary
    if analysis["checks_failed"] == 0:
        analysis["summary"].append("✅ All intent checks PASSED - network is compliant")
    else:
        analysis["summary"].append(f"❌ {analysis['checks_failed']} intent check(s) FAILED")
        analysis["summary"].append(f"   Total violations: {analysis['total_violations']}")

        for severity in ["critical", "high", "medium", "low", "info"]:
            count = len(analysis["violations_by_severity"][severity])
            if count > 0:
                analysis["summary"].append(f"   {severity.upper()}: {count}")

    return analysis


def print_analysis(analysis: Dict[str, Any], format: str = "human", verbose: bool = False):
    """Print intent check violation analysis."""

    if format == "json":
        print(json.dumps(analysis, indent=2))
        return

    print(f"\n{'='*80}")
    print(f"INTENT CHECK VIOLATIONS - BASELINE ANALYSIS")
    print(f"{'='*80}\n")

    print(f"📊 Checks Run: {analysis['checks_run']}")
    print(f"   ✅ Passed: {analysis['checks_passed']}")
    print(f"   ❌ Failed: {analysis['checks_failed']}")
    print(f"   ⚠️  Errors: {analysis['checks_errored']}\n")

    if analysis["total_violations"] == 0:
        print("✅ No violations found - network is compliant with all intent checks")
        return

    print(f"❌ Total Violations: {analysis['total_violations']}\n")

    # Violations by severity
    print(f"{'─'*80}")
    print("VIOLATIONS BY SEVERITY")
    print(f"{'─'*80}\n")

    for severity in ["critical", "high", "medium", "low", "info"]:
        violations = analysis["violations_by_severity"][severity]
        if not violations:
            continue

        emoji = {"critical": "🔴", "high": "🟠", "medium": "🟡", "low": "🔵", "info": "⚪"}
        print(f"{emoji.get(severity, '⚪')} {severity.upper()}: {len(violations)} violation(s)")

        if verbose:
            for i, v in enumerate(violations, 1):
                print(f"\n   {i}. {v['check_name']}")
                print(f"      {v['message']}")
                if v.get('device'):
                    print(f"      Device: {v['device']}")
                if v.get('recommendation'):
                    print(f"      → {v['recommendation']}")
        print()

    # Top failing checks
    if analysis["violations_by_check"]:
        print(f"{'─'*80}")
        print("TOP FAILING CHECKS")
        print(f"{'─'*80}\n")

        sorted_checks = sorted(
            analysis["violations_by_check"].items(),
            key=lambda x: x[1]["violation_count"],
            reverse=True
        )

        for check_id, data in sorted_checks[:10]:  # Top 10
            print(f"  {data['check_name']:50s} {data['violation_count']:3d} violation(s)")

    # Summary
    print(f"\n{'─'*80}")
    print("SUMMARY")
    print(f"{'─'*80}\n")
    for line in analysis["summary"]:
        print(f"  {line}")

    if analysis["checks_failed"] > 0:
        print(f"\n⚠️  IMPORTANT: These violations exist at BASELINE (before any changes)")
        print(f"   Do not introduce NEW violations on top of these!")
        print(f"   Consider fixing critical/high violations before proceeding.")


def main():
    parser = argparse.ArgumentParser(
        description="Run all intent checks and report baseline violations",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Check all intent checks on latest snapshot
  %(prog)s --network-id 863

  # Check specific snapshot
  %(prog)s --network-id 863 --snapshot-id 2055

  # Verbose output with all violation details
  %(prog)s --network-id 863 --verbose

  # JSON output for automation
  %(prog)s --network-id 863 --format json

Why this matters:
  Before making ANY configuration changes, you need to know what's ALREADY broken.
  Otherwise you might:
  1. Blame your changes for pre-existing violations
  2. Introduce NEW violations without noticing
  3. "Fix" something that masks a different violation
        """
    )

    parser.add_argument(
        "--network-id",
        type=int,
        required=True,
        help="Forward Networks network ID"
    )

    parser.add_argument(
        "--snapshot-id",
        type=int,
        help="Specific snapshot ID (default: latest)"
    )

    parser.add_argument(
        "--format",
        choices=["human", "json"],
        default="human",
        help="Output format (default: human)"
    )

    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Show detailed violation information"
    )

    parser.add_argument(
        "--severity-filter",
        choices=["critical", "high", "medium", "low", "info", "all"],
        default="all",
        help="Only show violations of specified severity or higher (default: all)"
    )

    args = parser.parse_args()

    # Initialize client
    client = ForwardClient()

    # Get all intent checks
    checks = get_all_intent_checks(client, args.network_id)

    if not checks:
        print("⚠️  No intent checks found for this network", file=sys.stderr)
        print("   This may mean:", file=sys.stderr)
        print("   1. Intent checks are not configured for this network", file=sys.stderr)
        print("   2. The Forward API does not support intent check listing", file=sys.stderr)
        print("   3. You may need to configure checks in Forward UI first", file=sys.stderr)
        sys.exit(1)

    print(f"Found {len(checks)} intent check(s) to run...\n", file=sys.stderr)

    # Run all checks
    results = []
    for i, check in enumerate(checks, 1):
        check_id = check.get("id")
        check_name = check.get("name", check_id)
        print(f"  [{i}/{len(checks)}] Running: {check_name}...", file=sys.stderr)

        result = run_intent_check(
            client=client,
            network_id=args.network_id,
            check_id=check_id,
            snapshot_id=args.snapshot_id
        )
        result["check_id"] = check_id
        result["check_name"] = check_name
        results.append(result)

    # Analyze
    analysis = analyze_violations(results)

    # Apply severity filter
    if args.severity_filter != "all":
        severity_order = ["critical", "high", "medium", "low", "info"]
        cutoff_index = severity_order.index(args.severity_filter)
        keep_severities = severity_order[:cutoff_index + 1]

        filtered_violations = {}
        for severity in keep_severities:
            filtered_violations[severity] = analysis["violations_by_severity"][severity]

        # Update analysis with filtered data
        analysis["violations_by_severity"] = filtered_violations
        analysis["total_violations"] = sum(
            len(v) for v in filtered_violations.values()
        )

    # Print results
    print_analysis(analysis, format=args.format, verbose=args.verbose)

    # Exit with warning code if violations found
    if analysis["checks_failed"] > 0:
        sys.exit(2)


if __name__ == "__main__":
    main()
