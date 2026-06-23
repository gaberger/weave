#!/usr/bin/env python3
"""
Architecture Intent Verification - Discovery Tool #2

Interactive questionnaire + document generator to establish design intent BEFORE making changes.

Would have immediately clarified:
- "Is this hub-spoke or mesh?"
- "Is the US-JP link supposed to be active?"
- "What are the isolation requirements?"
"""

import sys
import json
import argparse
from typing import Dict, Any, List
from pathlib import Path
import yaml


ARCHITECTURE_TEMPLATE = """# Network Architecture Intent

**Generated**: {date}
**Network**: {network_name}
**Network ID**: {network_id}

## Design Pattern

**Topology Type**: {topology_type}

{topology_description}

## Physical Links

{physical_links}

## Routing Policy

**Protocol**: {routing_protocol}

### Backbone Routing
{backbone_routing}

### Client Routing
{client_routing}

## Isolation Requirements

{isolation_requirements}

## Redundancy & Failover

{redundancy}

## Traffic Flow Intent

{traffic_flows}

## Validation Criteria

After ANY configuration change, the following MUST be true:

{validation_criteria}

---

*This document is the source of truth for design intent. If implementation deviates,
either fix the implementation OR update this document with explicit reasoning.*
"""


def ask_question(question: str, options: List[str] = None, default: str = None) -> str:
    """Interactive question with optional defaults."""
    if options:
        print(f"\n{question}")
        for i, opt in enumerate(options, 1):
            marker = " (default)" if default and opt == default else ""
            print(f"  {i}. {opt}{marker}")
        while True:
            answer = input("\nChoice (number): ").strip()
            if not answer and default:
                return default
            try:
                idx = int(answer) - 1
                if 0 <= idx < len(options):
                    return options[idx]
            except ValueError:
                pass
            print("Invalid choice, try again.")
    else:
        prompt = f"\n{question}"
        if default:
            prompt += f" [{default}]"
        prompt += ": "
        answer = input(prompt).strip()
        return answer if answer else default


def generate_architecture_doc(answers: Dict[str, Any]) -> str:
    """Generate ARCHITECTURE.md from questionnaire answers."""

    # Topology descriptions
    topology_descriptions = {
        "Hub-spoke": "Central hub routers connect to spoke sites. Spokes do NOT communicate directly.",
        "Full mesh": "All border routers are fully interconnected. Any border can reach any other border directly.",
        "Partial mesh": "Some direct connections between borders, others route through intermediaries.",
        "Hierarchical": "Tiered architecture with core, distribution, and access layers."
    }

    # Build physical links table
    physical_links_lines = ["| Source | Interface | Destination | Interface | Status | Purpose |",
                           "|--------|-----------|-------------|-----------|--------|---------|"]
    for link in answers.get("physical_links", []):
        physical_links_lines.append(
            f"| {link['src_device']} | {link['src_iface']} | "
            f"{link['dst_device']} | {link['dst_iface']} | "
            f"{link['status']} | {link['purpose']} |"
        )
    physical_links_table = "\n".join(physical_links_lines)

    # Build validation criteria
    validation_lines = []
    for i, criterion in enumerate(answers.get("validation_criteria", []), 1):
        validation_lines.append(f"{i}. {criterion}")
    validation_criteria = "\n".join(validation_lines)

    # Build traffic flow table
    traffic_flow_lines = ["| Source Type | Destination Type | Expected Path | Allowed? |",
                          "|-------------|------------------|---------------|----------|"]
    for flow in answers.get("traffic_flows", []):
        traffic_flow_lines.append(
            f"| {flow['source']} | {flow['destination']} | "
            f"{flow['path']} | {flow['allowed']} |"
        )
    traffic_flows_table = "\n".join(traffic_flow_lines)

    doc = ARCHITECTURE_TEMPLATE.format(
        date=answers.get("date", "unknown"),
        network_name=answers.get("network_name", "unknown"),
        network_id=answers.get("network_id", "unknown"),
        topology_type=answers.get("topology_type", "unknown"),
        topology_description=topology_descriptions.get(answers.get("topology_type", ""), ""),
        physical_links=physical_links_table,
        routing_protocol=answers.get("routing_protocol", "BGP"),
        backbone_routing=answers.get("backbone_routing", ""),
        client_routing=answers.get("client_routing", ""),
        isolation_requirements=answers.get("isolation_requirements", ""),
        redundancy=answers.get("redundancy", ""),
        traffic_flows=traffic_flows_table,
        validation_criteria=validation_criteria
    )

    return doc


def run_questionnaire(network_id: int, network_name: str = None) -> Dict[str, Any]:
    """
    Interactive questionnaire to capture design intent.

    Asks EXPLORATORY questions first to understand the network,
    then drills into specifics. Network-agnostic.
    """

    print("="*80)
    print("ARCHITECTURE INTENT QUESTIONNAIRE")
    print("="*80)
    print("\nThis questionnaire establishes design intent BEFORE making configuration changes.")
    print("We'll ask exploratory questions first to understand your network.")
    print("Answer based on INTENDED behavior, not current state.")
    print("="*80)

    answers = {
        "network_id": network_id,
        "network_name": network_name or f"Network-{network_id}",
        "date": "2026-05-12",  # Would use datetime in production
    }

    # PHASE 1: EXPLORATORY QUESTIONS
    print("\n" + "="*80)
    print("PHASE 1: UNDERSTANDING YOUR NETWORK")
    print("="*80)

    # What kind of network is this?
    print("\n📋 First, let's understand what kind of network this is...")
    network_purpose = ask_question(
        "What is this network's primary purpose?",
        options=[
            "Multi-region backbone (connecting geographic sites)",
            "Data center fabric (within single location)",
            "Campus network (enterprise/university)",
            "Service provider core",
            "Other"
        ]
    )
    answers["network_purpose"] = network_purpose

    # What are the critical devices?
    print("\n📋 What types of devices are the 'critical nodes' in this network?")
    print("   (e.g., border routers, spine switches, core routers, etc.)")
    critical_device_type = ask_question("Critical device type")
    answers["critical_device_type"] = critical_device_type

    # Should they all talk to each other?
    print(f"\n📋 Should all {critical_device_type}s be able to communicate DIRECTLY?")
    full_connectivity = ask_question(
        f"Should any {critical_device_type} reach any other {critical_device_type} directly?",
        options=["Yes - full mesh connectivity", "No - hub-spoke (through central point)", "Partial - some direct, some indirect"],
        default="Yes - full mesh connectivity"
    )

    # Map to topology type
    if "full mesh" in full_connectivity.lower():
        answers["topology_type"] = "Full mesh"
    elif "hub-spoke" in full_connectivity.lower():
        answers["topology_type"] = "Hub-spoke"
    else:
        answers["topology_type"] = "Partial mesh"

    # What about isolation?
    print("\n📋 Are there different tenants/regions/groups that should be ISOLATED from each other?")
    has_isolation = ask_question(
        "Should certain devices/groups be prevented from communicating?",
        options=["Yes - strict isolation required", "No - all devices can communicate", "Partial - some isolation"],
        default="No - all devices can communicate"
    )
    answers["has_isolation_requirements"] = "yes" in has_isolation.lower()

    # Routing protocol
    answers["routing_protocol"] = ask_question(
        "Primary routing protocol?",
        options=["BGP", "OSPF", "IS-IS", "Static", "Mixed"],
        default="BGP"
    )

    # PHASE 2: PHYSICAL TOPOLOGY
    print("\n" + "="*80)
    print("PHASE 2: PHYSICAL TOPOLOGY")
    print("="*80)
    print(f"\nNow let's document the physical links between {critical_device_type}s.")
    print("For each link between critical nodes, specify:")
    print("  - Source device & interface")
    print("  - Destination device & interface")
    print("  - Intended status (ACTIVE/STANDBY/UNUSED)")
    print("  - Purpose (why does this link exist?)")
    print("\nEnter 'done' when finished.")

    links = []
    link_num = 1
    while True:
        print(f"\n--- Link #{link_num} ---")
        src_device = ask_question("Source device (or 'done' to finish)")
        if src_device.lower() == 'done':
            break

        src_iface = ask_question("Source interface")
        dst_device = ask_question("Destination device")
        dst_iface = ask_question("Destination interface")
        status = ask_question("Intended status", options=["ACTIVE", "STANDBY", "UNUSED"], default="ACTIVE")
        purpose = ask_question("Purpose (e.g., 'primary path', 'backup', 'testing')")

        links.append({
            "src_device": src_device,
            "src_iface": src_iface,
            "dst_device": dst_device,
            "dst_iface": dst_iface,
            "status": status,
            "purpose": purpose
        })
        link_num += 1

    answers["physical_links"] = links

    # PHASE 3: ROUTING POLICY
    print("\n" + "="*80)
    print("PHASE 3: ROUTING POLICY")
    print("="*80)

    # Backbone routing
    print(f"\n📋 How should {critical_device_type}s exchange routes?")
    answers["backbone_routing"] = ask_question(
        f"Describe routing between {critical_device_type}s"
    )

    # Client/edge routing (if applicable)
    if network_purpose.startswith("Multi-region") or network_purpose.startswith("Data center"):
        print("\n📋 How should edge/client devices connect?")
        answers["client_routing"] = ask_question(
            "Describe routing policy for edge/client devices"
        )
    else:
        answers["client_routing"] = "N/A"

    # PHASE 4: ISOLATION REQUIREMENTS
    print("\n" + "="*80)
    print("PHASE 4: ISOLATION & SECURITY")
    print("="*80)

    if answers["has_isolation_requirements"]:
        print("\n📋 You mentioned isolation is required. Let's define it.")
        answers["isolation_requirements"] = ask_question(
            "Describe which devices/groups should NOT be able to communicate"
        )
    else:
        answers["isolation_requirements"] = "No isolation required - all devices can communicate"

    # PHASE 5: REDUNDANCY
    print("\n" + "="*80)
    print("PHASE 5: REDUNDANCY & FAILOVER")
    print("="*80)

    print("\n📋 What should happen if a critical device or link fails?")
    answers["redundancy"] = ask_question(
        "Describe redundancy/failover requirements"
    )

    # PHASE 6: TRAFFIC FLOWS
    print("\n" + "="*80)
    print("PHASE 6: EXPECTED TRAFFIC FLOWS")
    print("="*80)
    print("\nFor common traffic patterns, specify:")
    print("  - Source type (e.g., 'client in region A', 'external user')")
    print("  - Destination type")
    print("  - Expected path (high-level, e.g., 'region A border -> region B border -> destination')")
    print("  - Whether this flow is ALLOWED or BLOCKED")
    print("\nEnter 'done' when finished.")

    flows = []
    flow_num = 1
    while True:
        print(f"\n--- Traffic Flow #{flow_num} ---")
        source = ask_question("Source type (or 'done' to finish)")
        if source.lower() == 'done':
            break

        destination = ask_question("Destination type")
        path = ask_question("Expected path (high-level)")
        allowed = ask_question("Should this flow be allowed?", options=["YES", "NO"], default="YES")

        flows.append({
            "source": source,
            "destination": destination,
            "path": path,
            "allowed": allowed
        })
        flow_num += 1

    answers["traffic_flows"] = flows

    # PHASE 7: VALIDATION CRITERIA
    print("\n" + "="*80)
    print("PHASE 7: VALIDATION CRITERIA")
    print("="*80)
    print("\nFinally, what must ALWAYS be true after ANY configuration change?")
    print("These become your 'health check' tests.")
    print("Enter each criterion, then 'done'.")

    criteria = []
    crit_num = 1
    while True:
        print(f"\n{crit_num}. ", end="")
        criterion = input("Validation criterion (or 'done'): ").strip()
        if criterion.lower() == 'done':
            break
        if criterion:
            criteria.append(criterion)
            crit_num += 1

    # Suggest default criteria if none specified
    if not criteria:
        print("\n📋 No criteria entered. Suggesting defaults based on your network...")
        suggested = []

        if links:
            suggested.append("All ACTIVE physical links are operationally UP")

        if answers["routing_protocol"] in ["BGP", "OSPF", "IS-IS"]:
            suggested.append(f"All expected {answers['routing_protocol']} sessions are Established")

        if answers["has_isolation_requirements"]:
            suggested.append("Isolated groups cannot communicate (reachability tests FAIL)")

        if answers["topology_type"] == "Full mesh":
            suggested.append(f"Any {critical_device_type} can reach any other {critical_device_type}")

        suggested.append("No unintended route leaks or policy violations")

        print("\nSuggested criteria:")
        for i, crit in enumerate(suggested, 1):
            print(f"  {i}. {crit}")

        use_defaults = ask_question("\nUse these suggestions?", options=["Yes", "No, I'll define my own"], default="Yes")
        if "yes" in use_defaults.lower():
            criteria = suggested
        else:
            print("\nOK, please enter your criteria:")
            while True:
                criterion = ask_question("Validation criterion (or 'done')")
                if criterion.lower() == 'done':
                    break
                criteria.append(criterion)

    answers["validation_criteria"] = criteria

    return answers


def main():
    parser = argparse.ArgumentParser(
        description="Capture network architecture design intent",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Interactive questionnaire
  %(prog)s --network-id 863 --output ARCHITECTURE.md

  # Non-interactive (use defaults) - NOT RECOMMENDED
  %(prog)s --network-id 863 --non-interactive
        """
    )

    parser.add_argument(
        "--network-id",
        type=int,
        required=True,
        help="Forward Networks network ID"
    )

    parser.add_argument(
        "--network-name",
        type=str,
        help="Human-readable network name"
    )

    parser.add_argument(
        "--output",
        type=str,
        default="ARCHITECTURE.md",
        help="Output file path (default: ARCHITECTURE.md)"
    )

    parser.add_argument(
        "--non-interactive",
        action="store_true",
        help="Use defaults (NOT RECOMMENDED - defeats the purpose)"
    )

    args = parser.parse_args()

    if args.non_interactive:
        print("⚠️  Non-interactive mode defeats the purpose of this tool!", file=sys.stderr)
        print("⚠️  The goal is to THINK through design intent, not auto-generate docs.", file=sys.stderr)
        sys.exit(1)

    # Run questionnaire
    answers = run_questionnaire(
        network_id=args.network_id,
        network_name=args.network_name
    )

    # Generate document
    doc = generate_architecture_doc(answers)

    # Write output
    output_path = Path(args.output)
    output_path.write_text(doc)

    print(f"\n{'='*80}")
    print(f"✅ Architecture intent document written to: {output_path}")
    print(f"{'='*80}")
    print("\nNext steps:")
    print("  1. Review and refine the document")
    print("  2. Run interface_inventory.py to validate physical topology matches intent")
    print("  3. Run route_map_audit.py to validate routing policy matches intent")
    print("  4. Only THEN start making configuration changes")


if __name__ == "__main__":
    main()
