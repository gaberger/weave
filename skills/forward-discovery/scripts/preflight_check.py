#!/usr/bin/env python3
"""
Pre-Flight Discovery Checklist

Enforces discovery-first workflow by running all discovery tools and blocking
configuration changes until complete.

This prevents the anti-pattern: "start fixing before finishing discovery"

Workflow:
1. Check for ARCHITECTURE.md (design intent) → BLOCK if missing
2. Run complete interface inventory → WARN on dark links
3. Run intent check baseline → WARN on pre-existing violations
4. Run route-map audit → BLOCK if missing policies
5. Generate validation matrix config → For post-change testing

Only after ALL discovery is complete and reviewed should configuration changes begin.
"""

import sys
import os
import subprocess
import argparse
from pathlib import Path
from typing import Dict, List, Any, Tuple
import json

SCRIPT_DIR = Path(__file__).parent


class PreFlightChecker:
    """Orchestrates pre-flight discovery workflow."""

    def __init__(self, network_id: int, snapshot_id: int = None, workspace: Path = None):
        self.network_id = network_id
        self.snapshot_id = snapshot_id
        self.workspace = workspace or Path.cwd()

        self.results = {
            "architecture_doc": {"status": "pending", "blocking": True},
            "interface_inventory": {"status": "pending", "blocking": False},
            "intent_checks": {"status": "pending", "blocking": False},
            "route_map_audit": {"status": "pending", "blocking": True},
            "validation_matrix": {"status": "pending", "blocking": False},
            "overall_status": "pending",
            "blockers": [],
            "warnings": []
        }

    def check_architecture_doc(self) -> Tuple[bool, str]:
        """Check if ARCHITECTURE.md exists with design intent."""
        arch_doc = self.workspace / "ARCHITECTURE.md"

        if not arch_doc.exists():
            return False, "ARCHITECTURE.md not found - run architecture_intent.py first"

        # Check if it's not just a stub
        content = arch_doc.read_text()
        if len(content) < 500:  # Heuristic: real doc should be substantial
            return False, "ARCHITECTURE.md exists but appears incomplete"

        # Check for key sections
        required_sections = ["Design Pattern", "Physical Links", "Validation Criteria"]
        missing = [s for s in required_sections if s not in content]

        if missing:
            return False, f"ARCHITECTURE.md missing sections: {', '.join(missing)}"

        return True, "ARCHITECTURE.md found and appears complete"

    def run_interface_inventory(self, device_filter: str = None) -> Tuple[bool, Dict[str, Any]]:
        """Run complete interface inventory."""
        print("\n🔍 Running interface inventory...", file=sys.stderr)

        cmd = [
            "python3",
            str(SCRIPT_DIR / "interface_inventory.py"),
            "--network-id", str(self.network_id),
            "--format", "json"
        ]

        if device_filter:
            cmd.extend(["--device-filter", device_filter])

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
            if result.returncode in [0, 2]:  # 0=pass, 2=warnings (dark links)
                data = json.loads(result.stdout)
                has_warnings = len(data.get("dark_links", [])) > 0
                return True, data
            else:
                return False, {"error": result.stderr}
        except Exception as e:
            return False, {"error": str(e)}

    def run_intent_checks(self) -> Tuple[bool, Dict[str, Any]]:
        """Run baseline intent check violations."""
        print("\n🔍 Running intent check baseline...", file=sys.stderr)

        cmd = [
            "python3",
            str(SCRIPT_DIR / "check_intent_violations.py"),
            "--network-id", str(self.network_id),
            "--format", "json"
        ]

        if self.snapshot_id:
            cmd.extend(["--snapshot-id", str(self.snapshot_id)])

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
            # Exit code 0=pass, 2=violations exist
            if result.returncode in [0, 2]:
                data = json.loads(result.stdout)
                return True, data
            else:
                # Intent checks may not be available
                return True, {"warning": "Intent checks not available", "error": result.stderr}
        except Exception as e:
            return True, {"warning": str(e)}  # Non-blocking

    def run_route_map_audit(self) -> Tuple[bool, Dict[str, Any]]:
        """Run route-map policy audit."""
        print("\n🔍 Running route-map audit...", file=sys.stderr)

        cmd = [
            "python3",
            str(SCRIPT_DIR / "route_map_audit.py"),
            "--network-id", str(self.network_id),
            "--format", "json"
        ]

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
            if result.returncode in [0, 2]:  # 0=pass, 2=missing policies
                data = json.loads(result.stdout)
                return True, data
            else:
                return False, {"error": result.stderr}
        except Exception as e:
            return False, {"error": str(e)}

    def generate_validation_matrix_config(self, arch_doc_path: Path) -> Tuple[bool, str]:
        """Generate validation_matrix.yml from ARCHITECTURE.md."""
        print("\n🔍 Generating validation matrix config...", file=sys.stderr)

        # This is a simplified version - production would parse ARCHITECTURE.md
        # and extract validation criteria automatically

        config_path = self.workspace / "validation_matrix.yml"

        # For now, create a template that user can fill in
        template = f"""# Validation Matrix Configuration
# Auto-generated from pre-flight discovery
# Review and adjust before using with validate_all.py

network_id: {self.network_id}

# Border/critical devices that should have full mesh connectivity
border_devices:
  - device-1
  - device-2
  # TODO: Fill in from ARCHITECTURE.md

# Tenant/client pairs that should be ISOLATED (cannot reach each other)
tenant_pairs:
  - [client-a, client-b]
  # TODO: Fill in from ARCHITECTURE.md

# Expected BGP sessions that must be Established
expected_bgp_sessions:
  - {{device: device-1, neighbor: 10.0.0.2}}
  # TODO: Fill in from ARCHITECTURE.md

# Expected active interfaces that must be UP
expected_interfaces:
  - {{device: device-1, interface: Ethernet1}}
  # TODO: Fill in from ARCHITECTURE.md
"""

        config_path.write_text(template)
        return True, f"Template written to {config_path} - review and customize"

    def run_all_checks(self, device_filter: str = None) -> Dict[str, Any]:
        """Run all pre-flight checks."""

        print("="*80)
        print("PRE-FLIGHT DISCOVERY CHECKLIST")
        print("="*80)
        print(f"\nNetwork ID: {self.network_id}")
        if self.snapshot_id:
            print(f"Snapshot ID: {self.snapshot_id}")
        print(f"Workspace: {self.workspace}")
        print("\n" + "="*80)

        # 1. Architecture doc
        print("\n[1/5] Checking for architecture intent document...")
        success, message = self.check_architecture_doc()
        self.results["architecture_doc"]["status"] = "pass" if success else "fail"
        self.results["architecture_doc"]["message"] = message

        if not success:
            self.results["blockers"].append(f"❌ {message}")
            print(f"   ❌ {message}")
        else:
            print(f"   ✅ {message}")

        # 2. Interface inventory
        print("\n[2/5] Running complete interface inventory...")
        success, data = self.run_interface_inventory(device_filter)
        self.results["interface_inventory"]["status"] = "pass" if success else "fail"
        self.results["interface_inventory"]["data"] = data

        if success:
            dark_links = data.get("dark_links", [])
            if dark_links:
                msg = f"Found {len(dark_links)} dark link(s) - review before proceeding"
                self.results["warnings"].append(f"⚠️  {msg}")
                print(f"   ⚠️  {msg}")
                for link in dark_links:
                    print(f"      - {link['device']} {link['interface']}: {link['warning']}")
            else:
                print(f"   ✅ All interfaces accounted for")
        else:
            msg = f"Interface inventory failed: {data.get('error', 'unknown')}"
            self.results["warnings"].append(f"⚠️  {msg}")
            print(f"   ⚠️  {msg}")

        # 3. Intent checks
        print("\n[3/5] Running baseline intent check violations...")
        success, data = self.run_intent_checks()
        self.results["intent_checks"]["status"] = "pass" if success else "fail"
        self.results["intent_checks"]["data"] = data

        if success:
            if data.get("warning"):
                print(f"   ⚠️  {data['warning']}")
            else:
                violations = data.get("total_violations", 0)
                if violations > 0:
                    msg = f"Found {violations} pre-existing intent violation(s)"
                    self.results["warnings"].append(f"⚠️  {msg}")
                    print(f"   ⚠️  {msg}")

                    # Show critical/high violations
                    critical = len(data.get("violations_by_severity", {}).get("critical", []))
                    high = len(data.get("violations_by_severity", {}).get("high", []))
                    if critical > 0:
                        print(f"      - CRITICAL: {critical}")
                    if high > 0:
                        print(f"      - HIGH: {high}")
                else:
                    print(f"   ✅ No intent violations at baseline")

        # 4. Route-map audit
        print("\n[4/5] Running route-map policy audit...")
        success, data = self.run_route_map_audit()
        self.results["route_map_audit"]["status"] = "pass" if success else "fail"
        self.results["route_map_audit"]["data"] = data

        if success:
            missing_inbound = len(data.get("missing_inbound_policy", []))
            missing_outbound = len(data.get("missing_outbound_policy", []))

            if missing_inbound > 0 or missing_outbound > 0:
                msg = f"Missing route-maps: {missing_inbound} inbound, {missing_outbound} outbound"
                self.results["blockers"].append(f"❌ {msg}")
                print(f"   ❌ {msg}")
            else:
                print(f"   ✅ All eBGP sessions have route-maps")
        else:
            msg = f"Route-map audit failed: {data.get('error', 'unknown')}"
            self.results["blockers"].append(f"❌ {msg}")
            print(f"   ❌ {msg}")

        # 5. Validation matrix
        print("\n[5/5] Generating validation matrix config...")
        arch_doc = self.workspace / "ARCHITECTURE.md"
        if arch_doc.exists():
            success, message = self.generate_validation_matrix_config(arch_doc)
            self.results["validation_matrix"]["status"] = "pass" if success else "fail"
            self.results["validation_matrix"]["message"] = message
            print(f"   ✅ {message}")
        else:
            print(f"   ⚠️  Skipped (no ARCHITECTURE.md)")

        # Overall status
        if self.results["blockers"]:
            self.results["overall_status"] = "blocked"
        elif self.results["warnings"]:
            self.results["overall_status"] = "warning"
        else:
            self.results["overall_status"] = "pass"

        return self.results

    def print_summary(self):
        """Print final pre-flight summary."""
        print("\n" + "="*80)
        print("PRE-FLIGHT DISCOVERY SUMMARY")
        print("="*80 + "\n")

        if self.results["overall_status"] == "pass":
            print("✅ ALL PRE-FLIGHT CHECKS PASSED")
            print("\n   You may proceed with configuration changes.")
            print("   Remember to run validate_all.py after EACH snapshot!\n")

        elif self.results["overall_status"] == "warning":
            print("⚠️  PRE-FLIGHT CHECKS PASSED WITH WARNINGS\n")

            for warning in self.results["warnings"]:
                print(f"   {warning}")

            print("\n   Review warnings before proceeding.")
            print("   Run validate_all.py after EACH snapshot to catch regressions!\n")

        else:  # blocked
            print("❌ PRE-FLIGHT CHECKS FAILED - DO NOT PROCEED\n")

            print("   BLOCKERS:\n")
            for blocker in self.results["blockers"]:
                print(f"   {blocker}")

            if self.results["warnings"]:
                print("\n   WARNINGS:\n")
                for warning in self.results["warnings"]:
                    print(f"   {warning}")

            print("\n   Fix blockers before making ANY configuration changes!")
            print("   Skipping discovery leads to multi-hour debugging sessions.\n")

        print("="*80)


def main():
    parser = argparse.ArgumentParser(
        description="Run pre-flight discovery checklist before configuration changes",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Full pre-flight check
  %(prog)s --network-id 863

  # Check specific device group
  %(prog)s --network-id 863 --device-filter border

  # Check specific snapshot
  %(prog)s --network-id 863 --snapshot-id 2055

Workflow:
  1. Run this BEFORE making any configuration changes
  2. If blocked, fix blockers (run architecture_intent.py if needed)
  3. If warnings, review and document acceptable risks
  4. Only proceed if status is PASS or WARNING (with review)
  5. After EACH config change, run validate_all.py

This prevents the anti-pattern:
  ❌ See problem → fix problem → broke something else
  ✅ Complete discovery → plan fix → validate everything
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
        "--device-filter",
        type=str,
        help="Device filter for interface inventory (e.g., 'border')"
    )

    parser.add_argument(
        "--workspace",
        type=str,
        help="Workspace directory for ARCHITECTURE.md and validation configs (default: current dir)"
    )

    parser.add_argument(
        "--json",
        action="store_true",
        help="Output results as JSON"
    )

    args = parser.parse_args()

    workspace = Path(args.workspace) if args.workspace else Path.cwd()

    # Run pre-flight checks
    checker = PreFlightChecker(
        network_id=args.network_id,
        snapshot_id=args.snapshot_id,
        workspace=workspace
    )

    results = checker.run_all_checks(device_filter=args.device_filter)

    if args.json:
        print(json.dumps(results, indent=2))
    else:
        checker.print_summary()

    # Exit codes:
    # 0 = pass
    # 1 = blocked (must fix)
    # 2 = warnings (proceed with caution)
    if results["overall_status"] == "blocked":
        sys.exit(1)
    elif results["overall_status"] == "warning":
        sys.exit(2)
    else:
        sys.exit(0)


if __name__ == "__main__":
    main()
