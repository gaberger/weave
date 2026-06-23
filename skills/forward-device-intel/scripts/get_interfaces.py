#!/usr/bin/env python3
"""Interface status — admin/oper state, speed, description.

Catalog: /Interfaces/Interface Status Query
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _entity import add_common_args, run_entity


def main() -> int:
    p = argparse.ArgumentParser(description="Forward interface status query")
    add_common_args(p)
    args = p.parse_args()
    return run_entity(__file__, "/Interfaces/Interface Status Query", args)


if __name__ == "__main__":
    sys.exit(main())
