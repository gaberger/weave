"""Makes `forward_client` importable regardless of install mode.

Side-effect only: prepends the directory containing ``forward_client.py`` to
``sys.path``. Import this before any ``from forward_client import ...`` line.

Search order:
    1. ``$CLAUDE_PLUGIN_ROOT/shared/`` — plugin install (Anthropic plugin loader)
    2. ``<script_dir>/_shared/``       — install.sh install
    3. Walk up for ``shared/forward_client.py`` — dev from source tree
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent


def _candidate_dirs():
    plugin_root = os.environ.get("CLAUDE_PLUGIN_ROOT")
    if plugin_root:
        yield Path(plugin_root) / "shared"
    yield _HERE / "_shared"
    for parent in _HERE.parents:
        yield parent / "shared"


for _d in _candidate_dirs():
    if (_d / "forward_client.py").is_file():
        if str(_d) not in sys.path:
            sys.path.insert(0, str(_d))
        break
