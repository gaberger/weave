#!/usr/bin/env python3
"""Device basic info — platform, OS version, model.

Catalog: /Devices/Device Basic Info
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _entity import add_common_args, run_entity


def main() -> int:
    p = argparse.ArgumentParser(description="Forward device basic info")
    add_common_args(p)
    args = p.parse_args()
    return run_entity(__file__, "/Devices/Device Basic Info", args)


if __name__ == "__main__":
    sys.exit(main())
