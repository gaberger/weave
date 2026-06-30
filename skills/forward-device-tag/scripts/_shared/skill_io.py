"""Shared skill I/O contract — args in → JSON out → creds via env.

Every weave skill, regardless of implementation language, should present the
*same* shape to the harness. This module is the Python reference for that
contract. The TypeScript equivalent (`skill-io.ts`) emits a byte-identical
envelope so weave parses one shape for all skills.

The contract
------------
A skill takes documented flags (creds come from the environment, never flags),
and on stdout emits exactly one JSON envelope when ``--format json``:

    success:  {"ok": true,  "schema": 1, "data": <any>, "meta": {...}}
    failure:  {"ok": false, "schema": 1, "error": {"code", "message", "hint?"}}

``ok`` is the single field weave branches on. ``schema`` lets the envelope
evolve without breaking parsers. ``data`` is the skill's payload (shape is
skill-defined); ``meta`` carries counts/snapshot/timing — anything *about* the
result rather than the result itself.

Human-facing formats (``human``, ``prometheus``, …) are presentation, not the
contract. Render those however reads best; only the JSON path is machine-stable.

Exit codes
----------
Under the contract the exit code means *did the skill run*, not *what did the
data show*:

    0           ran successfully (even if the data reports problems)
    non-zero    the skill could not produce a result (auth, not-found, API error)

Do not overload the exit code as a severity signal in JSON mode — put severity
in ``data``/``meta`` where a parser can read it. (Human/prometheus modes may
still use Nagios-style exit codes for operators; that's presentation.)

Usage
-----
    import _bootstrap            # noqa: F401  (puts _shared/ on sys.path)
    from skill_io import add_format_arg, emit_success, emit_error

    add_format_arg(parser, choices=("human", "json"))
    ...
    emit_success(rows, meta={"count": len(rows)}, fmt=args.format,
                 human=lambda data, meta: print_table(data))
    # or, on a failure path:
    emit_error("NOT_FOUND", f"network {nid} not found",
               hint="list networks with forward-inventory", fmt=args.format)
"""
from __future__ import annotations

import json
import sys
from typing import Any, Callable, Mapping, Optional, Sequence

SCHEMA_VERSION = 1

# Stable error codes. Skills may add their own, but prefer reusing these so
# weave can branch on a known vocabulary.
ERR_AUTH = "AUTH"            # missing/invalid credentials
ERR_NOT_FOUND = "NOT_FOUND"  # referenced resource does not exist
ERR_API = "API"              # upstream API call failed
ERR_INPUT = "INPUT"          # bad/contradictory arguments
ERR_EMPTY = "EMPTY"          # ran fine but produced nothing actionable


def add_format_arg(
    parser: Any,
    *,
    choices: Sequence[str] = ("human", "json"),
    default: str = "human",
) -> None:
    """Register the conventional ``--format`` flag on an argparse parser.

    ``json`` must always be one of the choices — it is the machine contract.
    Default to ``human`` so interactive use stays readable.
    """
    if "json" not in choices:
        raise ValueError("--format choices must include 'json' (the contract)")
    parser.add_argument(
        "--format",
        choices=list(choices),
        default=default,
        help="Output format (json = machine contract; default: %(default)s)",
    )


def ok_envelope(data: Any, meta: Optional[Mapping[str, Any]] = None) -> dict:
    """Build (don't print) a success envelope. Pure — used by tests."""
    return {"ok": True, "schema": SCHEMA_VERSION, "data": data, "meta": dict(meta or {})}


def error_envelope(code: str, message: str, hint: Optional[str] = None) -> dict:
    """Build (don't print) an error envelope. Pure — used by tests."""
    err: dict = {"code": code, "message": message}
    if hint:
        err["hint"] = hint
    return {"ok": False, "schema": SCHEMA_VERSION, "error": err}


def _print(obj: Any) -> None:
    json.dump(obj, sys.stdout, indent=2, default=str)
    sys.stdout.write("\n")


def emit_success(
    data: Any,
    *,
    meta: Optional[Mapping[str, Any]] = None,
    fmt: str = "json",
    human: Optional[Callable[[Any, Mapping[str, Any]], None]] = None,
    exit_after: bool = True,
) -> None:
    """Emit a success result and (by default) exit 0.

    ``json``  → the success envelope on stdout.
    other     → call ``human(data, meta)`` to render; if no renderer is given,
                fall back to the JSON envelope so output is never silently empty.
    """
    meta = dict(meta or {})
    if fmt == "json" or human is None:
        _print(ok_envelope(data, meta))
    else:
        human(data, meta)
    if exit_after:
        sys.exit(0)


def emit_error(
    code: str,
    message: str,
    *,
    hint: Optional[str] = None,
    fmt: str = "json",
    exit_code: int = 1,
) -> None:
    """Emit an error result and exit non-zero.

    ``json``  → the error envelope on **stdout** (so JSON consumers always read
                one parseable object), plus a short line on stderr for humans
                tailing logs.
    other     → a human-readable line on stderr only.
    """
    if exit_code == 0:
        raise ValueError("emit_error requires a non-zero exit_code")
    if fmt == "json":
        _print(error_envelope(code, message, hint))
    sys.stderr.write(f"error [{code}]: {message}\n")
    if hint:
        sys.stderr.write(f"hint: {hint}\n")
    sys.exit(exit_code)
