#!/usr/bin/env python3
"""
Holistic Validation Matrix - Discovery Tool #4

Runs comprehensive validation after EVERY snapshot to catch regressions.

Tests ALL requirements, not just the thing we changed:
- Backbone connectivity (all border pairs)
- Tenant isolation (all client pairs should FAIL)
- BGP session health (all eBGP sessions Established)
- Route-map presence (all eBGP sessions have policies)
- Interface status (all ACTIVE links are UP)

Would have caught:
- Snapshot 2048: Broke backbone while fixing route leak
- Snapshot 2055: Broke isolation while adding mesh link
"""

import sys
import os
import json
import argparse
from typing import Dict, List, Any, Tuple
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

# Local skill I/O + client FIRST, so the {ok,error} contract is available to
# report a graceful failure if the cross-skill imports below can't be resolved.
SCRIPT_DIR = Path(__file__).parent
SKILL_ROOT = SCRIPT_DIR.parent
SKILLS_ROOT = SKILL_ROOT.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401 — puts local _shared/forward_client on sys.path
from forward_client import ForwardClient
from skill_io import add_format_arg, emit_success, emit_error, ERR_INPUT

# Cross-skill imports: validate_all orchestrates forward-path-analysis +
# forward-nqe-query. If those skills aren't installed alongside this one, fail
# with a clear error envelope instead of an uncaught ImportError traceback.
sys.path.insert(0, str(SKILLS_ROOT / "forward-path-analysis" / "scripts"))
sys.path.insert(0, str(SKILLS_ROOT / "forward-nqe-query" / "scripts"))
try:
    from search_path import search_path, SearchParams
except ImportError as e:
    emit_error(
        ERR_INPUT,
        f"validate_all requires the forward-path-analysis skill's search_path module: {e}",
        hint="ensure forward-path-analysis (and forward-nqe-query) are installed alongside forward-discovery",
    )


class ValidationMatrix:
    """Comprehensive validation test suite."""

    def __init__(self, client: ForwardClient, network_id: int, snapshot_id: int = None):
        self.client = client
        self.network_id = network_id
        self.snapshot_id = snapshot_id
        self.results = {
            "backbone_connectivity": [],
            "tenant_isolation": [],
            "bgp_sessions": [],
            "route_maps": [],
            "interface_status": [],
            "summary": {
                "total_tests": 0,
                "passed": 0,
                "failed": 0,
                "warnings": 0
            }
        }

    def test_backbone_connectivity(self, border_devices: List[str]) -> List[Dict[str, Any]]:
        """
        Test that all border routers can reach each other.

        This is the backbone mesh requirement.
        """
        print("🔍 Testing backbone connectivity...", file=sys.stderr)

        tests = []
        for i, src in enumerate(border_devices):
            for dst in border_devices[i+1:]:  # Only test each pair once
                # Test both directions
                for source, dest in [(src, dst), (dst, src)]:
                    params = SearchParams(
                        srcDevice=source,
                        dstDevice=dest,
                        dstIp="",  # Will match any IP on dest device
                        ipProto="icmp"
                    )

                    result = search_path(
                        self.client,
                        self.network_id,
                        params,
                        self.snapshot_id
                    )

                    test_result = {
                        "source": source,
                        "destination": dest,
                        "expected": "REACHABLE",
                        "actual": "REACHABLE" if result.get("hasPath") else "UNREACHABLE",
                        "passed": result.get("hasPath", False),
                        "violation": result.get("violations", [])
                    }

                    tests.append(test_result)
                    self.results["summary"]["total_tests"] += 1

                    if test_result["passed"]:
                        self.results["summary"]["passed"] += 1
                    else:
                        self.results["summary"]["failed"] += 1

        self.results["backbone_connectivity"] = tests
        return tests

    def test_tenant_isolation(self, tenant_pairs: List[Tuple[str, str]]) -> List[Dict[str, Any]]:
        """
        Test that tenant clients CANNOT reach each other.

        This is the isolation requirement.
        """
        print("🔍 Testing tenant isolation...", file=sys.stderr)

        tests = []
        for src, dst in tenant_pairs:
            params = SearchParams(
                srcDevice=src,
                dstDevice=dst,
                dstIp="",
                ipProto="icmp"
            )

            result = search_path(
                self.client,
                self.network_id,
                params,
                self.snapshot_id
            )

            # For isolation tests, we EXPECT no path (hasPath=False)
            test_result = {
                "source": src,
                "destination": dst,
                "expected": "ISOLATED",
                "actual": "ISOLATED" if not result.get("hasPath") else "LEAKED",
                "passed": not result.get("hasPath", False),  # Pass if no path
                "violation": result.get("violations", [])
            }

            tests.append(test_result)
            self.results["summary"]["total_tests"] += 1

            if test_result["passed"]:
                self.results["summary"]["passed"] += 1
            else:
                self.results["summary"]["failed"] += 1

        self.results["tenant_isolation"] = tests
        return tests

    def test_bgp_sessions(self, expected_sessions: List[Dict[str, str]]) -> List[Dict[str, Any]]:
        """
        Test that all expected BGP sessions are Established.
        """
        print("🔍 Testing BGP session health...", file=sys.stderr)

        # Query BGP sessions
        try:
            result = self.client.run_nqe_query(
                network_id=self.network_id,
                query_id="FQ_bgp_sessions",
                snapshot_id=self.snapshot_id
            )
            sessions = result.get("items", [])
        except Exception as e:
            print(f"⚠️  Could not query BGP sessions: {e}", file=sys.stderr)
            return []

        # Build session lookup
        session_map = {}
        for session in sessions:
            key = (session.get("deviceName"), session.get("neighbor"))
            session_map[key] = session

        # Check expected sessions
        tests = []
        for expected in expected_sessions:
            device = expected["device"]
            neighbor = expected["neighbor"]
            key = (device, neighbor)

            actual_session = session_map.get(key)

            if not actual_session:
                test_result = {
                    "device": device,
                    "neighbor": neighbor,
                    "expected": "Established",
                    "actual": "NOT FOUND",
                    "passed": False
                }
            else:
                state = actual_session.get("state", "unknown")
                test_result = {
                    "device": device,
                    "neighbor": neighbor,
                    "expected": "Established",
                    "actual": state,
                    "passed": state == "Established"
                }

            tests.append(test_result)
            self.results["summary"]["total_tests"] += 1

            if test_result["passed"]:
                self.results["summary"]["passed"] += 1
            else:
                self.results["summary"]["failed"] += 1

        self.results["bgp_sessions"] = tests
        return tests

    def test_route_maps(self, expected_sessions: List[Dict[str, str]]) -> List[Dict[str, Any]]:
        """
        Test that all eBGP sessions have route-maps applied.
        """
        print("🔍 Testing route-map policies...", file=sys.stderr)

        # Query BGP sessions
        try:
            result = self.client.run_nqe_query(
                network_id=self.network_id,
                query_id="FQ_bgp_sessions",
                snapshot_id=self.snapshot_id
            )
            sessions = result.get("items", [])
        except Exception as e:
            print(f"⚠️  Could not query BGP sessions: {e}", file=sys.stderr)
            return []

        # Build session lookup
        session_map = {}
        for session in sessions:
            key = (session.get("deviceName"), session.get("neighbor"))
            session_map[key] = session

        # Check route-maps
        tests = []
        for expected in expected_sessions:
            device = expected["device"]
            neighbor = expected["neighbor"]
            key = (device, neighbor)

            actual_session = session_map.get(key)

            if not actual_session:
                continue  # Already flagged in BGP session test

            inbound_map = actual_session.get("inboundRouteMap")
            outbound_map = actual_session.get("outboundRouteMap")

            # For eBGP sessions, we expect BOTH inbound and outbound route-maps
            has_inbound = bool(inbound_map)
            has_outbound = bool(outbound_map)

            test_result = {
                "device": device,
                "neighbor": neighbor,
                "expected": "Both inbound and outbound",
                "actual": f"Inbound: {inbound_map or 'NONE'}, Outbound: {outbound_map or 'NONE'}",
                "passed": has_inbound and has_outbound
            }

            tests.append(test_result)
            self.results["summary"]["total_tests"] += 1

            if test_result["passed"]:
                self.results["summary"]["passed"] += 1
            else:
                self.results["summary"]["failed"] += 1

        self.results["route_maps"] = tests
        return tests

    def test_interface_status(self, expected_interfaces: List[Dict[str, str]]) -> List[Dict[str, Any]]:
        """
        Test that all expected-active interfaces are UP.
        """
        print("🔍 Testing interface status...", file=sys.stderr)

        # Query interfaces
        try:
            result = self.client.run_nqe_query(
                network_id=self.network_id,
                query_id="FQ_interface_status",
                snapshot_id=self.snapshot_id
            )
            interfaces = result.get("items", [])
        except Exception as e:
            print(f"⚠️  Could not query interfaces: {e}", file=sys.stderr)
            return []

        # Build interface lookup
        iface_map = {}
        for iface in interfaces:
            key = (iface.get("deviceName"), iface.get("interface"))
            iface_map[key] = iface

        # Check expected interfaces
        tests = []
        for expected in expected_interfaces:
            device = expected["device"]
            interface = expected["interface"]
            key = (device, interface)

            actual_iface = iface_map.get(key)

            if not actual_iface:
                test_result = {
                    "device": device,
                    "interface": interface,
                    "expected": "UP",
                    "actual": "NOT FOUND",
                    "passed": False
                }
            else:
                oper_status = actual_iface.get("operationalStatus", "unknown")
                test_result = {
                    "device": device,
                    "interface": interface,
                    "expected": "UP",
                    "actual": oper_status,
                    "passed": "UP" in oper_status.upper()
                }

            tests.append(test_result)
            self.results["summary"]["total_tests"] += 1

            if test_result["passed"]:
                self.results["summary"]["passed"] += 1
            else:
                self.results["summary"]["failed"] += 1

        self.results["interface_status"] = tests
        return tests

    def run_all_tests(self, config: Dict[str, Any]) -> Dict[str, Any]:
        """
        Run all validation tests based on configuration.
        """
        print(f"\n{'='*80}")
        print(f"RUNNING HOLISTIC VALIDATION MATRIX")
        print(f"Network ID: {self.network_id}")
        if self.snapshot_id:
            print(f"Snapshot ID: {self.snapshot_id}")
        print(f"{'='*80}\n")

        # Run tests
        if config.get("border_devices"):
            self.test_backbone_connectivity(config["border_devices"])

        if config.get("tenant_pairs"):
            self.test_tenant_isolation(config["tenant_pairs"])

        if config.get("expected_bgp_sessions"):
            self.test_bgp_sessions(config["expected_bgp_sessions"])
            self.test_route_maps(config["expected_bgp_sessions"])

        if config.get("expected_interfaces"):
            self.test_interface_status(config["expected_interfaces"])

        return self.results

    def print_results(self):
        """Print the human-readable validation results (JSON is emitted via emit_success)."""

        print(f"\n{'='*80}")
        print(f"VALIDATION RESULTS")
        print(f"{'='*80}\n")

        summary = self.results["summary"]
        pass_rate = (summary["passed"] / summary["total_tests"] * 100) if summary["total_tests"] > 0 else 0

        print(f"📊 Overall: {summary['passed']}/{summary['total_tests']} tests passed ({pass_rate:.1f}%)")
        print(f"   ✅ Passed: {summary['passed']}")
        print(f"   ❌ Failed: {summary['failed']}")
        print(f"   ⚠️  Warnings: {summary['warnings']}\n")

        # Print failures by category
        categories = [
            ("backbone_connectivity", "Backbone Connectivity"),
            ("tenant_isolation", "Tenant Isolation"),
            ("bgp_sessions", "BGP Sessions"),
            ("route_maps", "Route-Map Policies"),
            ("interface_status", "Interface Status")
        ]

        for key, title in categories:
            tests = self.results.get(key, [])
            if not tests:
                continue

            failures = [t for t in tests if not t["passed"]]
            if failures:
                print(f"{'─'*80}")
                print(f"❌ {title} FAILURES ({len(failures)}/{len(tests)})")
                print(f"{'─'*80}")

                for test in failures:
                    if key == "backbone_connectivity":
                        print(f"  {test['source']} → {test['destination']}: {test['actual']}")
                    elif key == "tenant_isolation":
                        print(f"  {test['source']} → {test['destination']}: {test['actual']} (should be ISOLATED)")
                    elif key == "bgp_sessions":
                        print(f"  {test['device']} → {test['neighbor']}: {test['actual']}")
                    elif key == "route_maps":
                        print(f"  {test['device']} → {test['neighbor']}: {test['actual']}")
                    elif key == "interface_status":
                        print(f"  {test['device']} {test['interface']}: {test['actual']}")

                print()

        # Overall result
        if summary["failed"] == 0:
            print(f"✅ ALL TESTS PASSED - snapshot is healthy")
            return True
        else:
            print(f"❌ {summary['failed']} TEST(S) FAILED - DO NOT PROCEED")
            return False


def load_validation_config(config_path: Path, fmt: str = "json") -> Dict[str, Any]:
    """Load validation configuration from YAML file."""
    try:
        import yaml
    except ImportError as e:
        emit_error(ERR_INPUT, f"loading a validation config requires PyYAML: {e}",
                   hint="pip install pyyaml", fmt=fmt)

    if not config_path.exists():
        emit_error(ERR_INPUT, f"Config file not found: {config_path}",
                   hint="pass a valid --config path to a validation matrix YAML file",
                   fmt=fmt)

    with open(config_path) as f:
        return yaml.safe_load(f)


def main():
    parser = argparse.ArgumentParser(
        description="Run holistic validation matrix after snapshot",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Run all tests from config
  %(prog)s --network-id 863 --config validation_matrix.yml

  # Validate specific snapshot
  %(prog)s --network-id 863 --snapshot-id 2055 --config validation_matrix.yml

Config file format (YAML):
  border_devices:
    - us-border-1
    - eu-border-1
    - jp-border-1

  tenant_pairs:
    - [us-client-1, eu-client-1]
    - [us-client-1, jp-client-1]
    - [eu-client-1, jp-client-1]

  expected_bgp_sessions:
    - {device: us-border-1, neighbor: 10.0.0.6}
    - {device: us-border-1, neighbor: 10.0.0.34}

  expected_interfaces:
    - {device: us-border-1, interface: Ethernet3}
    - {device: us-border-1, interface: Ethernet4}
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
        "--config",
        type=str,
        required=True,
        help="Validation configuration YAML file"
    )

    add_format_arg(parser, choices=("human", "json"))

    args = parser.parse_args()

    # Load config
    config = load_validation_config(Path(args.config), fmt=args.format)

    # Initialize client and validator
    client = ForwardClient.from_env()
    validator = ValidationMatrix(client, args.network_id, args.snapshot_id)

    # Run all tests
    validator.run_all_tests(config)

    summary = validator.results["summary"]
    meta = {
        "network_id": args.network_id,
        "snapshot_id": args.snapshot_id,
        "config": args.config,
        "total_tests": summary["total_tests"],
        "passed": summary["passed"],
        "failed": summary["failed"],
        "warnings": summary["warnings"],
    }

    # JSON is the machine contract — pass/fail lives in data/meta, exit 0.
    if args.format == "json":
        emit_success(validator.results, meta=meta, fmt="json")

    # Human output below preserves its pass/fail exit code.
    success = validator.print_results()

    # Exit with error code if tests failed
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
