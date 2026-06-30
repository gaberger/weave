#!/usr/bin/env python3
"""Edit the CLI commands for a device in a Forward change-set.

POST /api/networks/{networkId}/change-sets/{id}/devices/{deviceName}?action=editCommands

Body: the CLI command block as a string (IOS/EOS/Junos commands, one per line).
Returns the updated DraftChangeSet.

Supply commands via --commands (inline) or --commands-file (read from disk).
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401

from forward_client import ForwardClient, ForwardError
from skill_io import emit_success, emit_error, ERR_API, ERR_INPUT


def main() -> int:
    p = argparse.ArgumentParser(
        description="Edit CLI commands for a device in a Forward change-set"
    )
    p.add_argument("--network-id", required=True)
    p.add_argument("--changeset-id", required=True, help="Change-set ID, e.g. CHG-7")
    p.add_argument("--device", required=True, help="Device name, e.g. us-border-1")
    cmds = p.add_mutually_exclusive_group(required=True)
    cmds.add_argument(
        "--commands",
        help="CLI command string (use \\n for newlines, or quote a multi-line string)",
    )
    cmds.add_argument(
        "--commands-file",
        help="Path to a text file containing the CLI commands (one per line)",
    )
    p.add_argument("--dry-run", action="store_true", help="Print request body without calling API")
    args = p.parse_args()

    if args.commands_file:
        try:
            command_text = Path(args.commands_file).read_text(encoding="utf-8")
        except OSError as e:
            emit_error(ERR_INPUT, f"cannot read --commands-file {args.commands_file!r}: {e}")
    else:
        command_text = args.commands

    path = (
        f"/api/networks/{args.network_id}/change-sets/{args.changeset_id}"
        f"/devices/{args.device}"
    )

    if args.dry_run:
        emit_success(
            {
                "method": "POST",
                "path": path,
                "query": {"action": "editCommands"},
                "body": command_text,
            },
            meta={"dry_run": True},
        )

    try:
        client = ForwardClient.from_env()
        result = client.post(path, command_text, query={"action": "editCommands"})
    except ForwardError as e:
        emit_error(ERR_API, str(e))

    emit_success(
        result,
        meta={
            "network_id": args.network_id,
            "changeset_id": args.changeset_id,
            "device": args.device,
        },
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
