#!/usr/bin/env python3
"""Established BGP peerings across the network.

Catalog: /L3/BGP/Established BGP Peerings
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _entity import add_common_args, run_entity


def main() -> int:
    p = argparse.ArgumentParser(description="Forward established BGP peerings")
    add_common_args(p)
    args = p.parse_args()
    return run_entity(__file__, "/L3/BGP/Established BGP Peerings", args)


if __name__ == "__main__":
    sys.exit(main())
