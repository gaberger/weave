"""Forward Networks API client — stdlib only.

Usage (after importing _bootstrap at the top of your script):
    from forward_client import ForwardClient, emit_json, die, ForwardError
    client = ForwardClient.from_env()
    networks = client.get("/api/networks")
    emit_json(networks)

Auth: HTTP Basic (key:secret base64). Matches forward-mcp server hardening
(TLS 1.3 minimum).
"""
from __future__ import annotations

import base64
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Optional


class ForwardError(Exception):
    """Base error for Forward API interactions."""


class AuthError(ForwardError):
    """401/403 — credentials invalid or lack permission."""


class NotFoundError(ForwardError):
    """404 — resource not found."""


_INSECURE_WARNED = False


def _parse_bool(v: Optional[str]) -> bool:
    return v is not None and v.strip().lower() in ("1", "true", "yes", "on")


def _build_ssl_context() -> ssl.SSLContext:
    """Construct the SSL context used for every Forward API request.

    Env vars (in order of increasing impact):
      - FORWARD_CA_BUNDLE : PEM path whose roots are ADDED to system trust.
                            Preferred for on-prem Forward with an internal CA.
      - FORWARD_INSECURE  : if truthy, disables cert + hostname verification.
                            Last-resort escape hatch; emits a loud stderr warn.
    """
    global _INSECURE_WARNED

    ctx = ssl.create_default_context()

    ca_bundle = os.environ.get("FORWARD_CA_BUNDLE", "").strip()
    if ca_bundle:
        try:
            ctx.load_verify_locations(cafile=ca_bundle)
        except (OSError, ssl.SSLError) as e:
            raise ForwardError(
                f"FORWARD_CA_BUNDLE at {ca_bundle!r} cannot be loaded: {e}. "
                "Check the path, file permissions, and that it's a valid PEM bundle."
            )

    if _parse_bool(os.environ.get("FORWARD_INSECURE")):
        if not _INSECURE_WARNED:
            sys.stderr.write(
                "warning: FORWARD_INSECURE=true — TLS cert + hostname verification is "
                "DISABLED. Every Forward API call is now MITM-vulnerable. Prefer "
                "FORWARD_CA_BUNDLE to extend trust with your internal CA PEM.\n"
            )
            _INSECURE_WARNED = True
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE

    try:
        ctx.minimum_version = ssl.TLSVersion.TLSv1_3
    except (AttributeError, ValueError):
        pass  # older Python — accept system default

    return ctx


def _load_dotenv() -> None:
    """Best-effort: load the nearest .env at or above cwd into os.environ."""
    cwd = Path.cwd()
    for d in [cwd, *cwd.parents]:
        env_file = d / ".env"
        if env_file.is_file():
            try:
                for line in env_file.read_text().splitlines():
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, _, v = line.partition("=")
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
            except OSError:
                pass
            return


class ForwardClient:
    def __init__(self, base_url: str, api_key: str, api_secret: str, timeout: int = 60):
        if not base_url:
            raise ForwardError(
                "FORWARD_API_BASE_URL is required (e.g. https://fwd.app). "
                "Set it in your shell or a .env file."
            )
        if not api_key or not api_secret:
            raise ForwardError(
                "FORWARD_API_KEY and FORWARD_API_SECRET are required. "
                "Request credentials from your Forward admin."
            )
        self.base_url = base_url.rstrip("/")
        token = base64.b64encode(f"{api_key}:{api_secret}".encode()).decode()
        self._auth = f"Basic {token}"
        self.timeout = timeout
        self._ssl = _build_ssl_context()

    @classmethod
    def from_env(cls) -> "ForwardClient":
        _load_dotenv()
        return cls(
            base_url=os.environ.get("FORWARD_API_BASE_URL", ""),
            api_key=os.environ.get("FORWARD_API_KEY", ""),
            api_secret=os.environ.get("FORWARD_API_SECRET", ""),
            timeout=int(os.environ.get("FORWARD_API_TIMEOUT", "60")),
        )

    def _request(
        self,
        method: str,
        path: str,
        body: Optional[Any] = None,
        query: Optional[dict] = None,
        retries: int = 2,
        raw: bool = False,
    ) -> Any:
        url = self.base_url + path
        if query:
            url += ("&" if "?" in url else "?") + urllib.parse.urlencode(query)
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", self._auth)
        req.add_header("Accept", "*/*" if raw else "application/json")
        if data is not None:
            req.add_header("Content-Type", "application/json")

        last_err: Optional[Exception] = None
        for attempt in range(retries + 1):
            try:
                with urllib.request.urlopen(req, timeout=self.timeout, context=self._ssl) as resp:
                    body_bytes = resp.read()
                    if not body_bytes:
                        return b"" if raw else None
                    return body_bytes if raw else json.loads(body_bytes)
            except urllib.error.HTTPError as e:
                status = e.code
                detail = ""
                try:
                    detail = e.read().decode("utf-8", errors="replace")[:500]
                except Exception:
                    pass
                if status == 401:
                    raise AuthError(
                        f"401 Unauthorized on {method} {path} — check FORWARD_API_KEY / "
                        f"FORWARD_API_SECRET. {detail}"
                    ) from e
                if status == 403:
                    raise AuthError(
                        f"403 Forbidden on {method} {path} — credentials valid but lack "
                        f"permission. {detail}"
                    ) from e
                if status == 404:
                    raise NotFoundError(f"404 Not Found: {method} {path}. {detail}") from e
                if 500 <= status < 600 and attempt < retries:
                    last_err = e
                    time.sleep(0.5 * (2 ** attempt))
                    continue
                raise ForwardError(f"HTTP {status} on {method} {path}: {detail}") from e
            except urllib.error.URLError as e:
                if attempt < retries:
                    last_err = e
                    time.sleep(0.5 * (2 ** attempt))
                    continue
                raise ForwardError(f"network error on {method} {path}: {e.reason}") from e
        raise ForwardError(f"request failed after retries: {last_err}")

    def get(self, path: str, query: Optional[dict] = None) -> Any:
        return self._request("GET", path, query=query)

    def get_text(self, path: str, query: Optional[dict] = None) -> str:
        """Fetch a path and decode the body as UTF-8. Use for endpoints that
        return raw text (e.g. snapshot file contents) rather than JSON."""
        body_bytes = self._request("GET", path, query=query, raw=True)
        if not body_bytes:
            return ""
        return body_bytes.decode("utf-8", errors="replace")

    def post(self, path: str, body: Any, query: Optional[dict] = None) -> Any:
        return self._request("POST", path, body=body, query=query)

    def put(self, path: str, body: Any, query: Optional[dict] = None) -> Any:
        return self._request("PUT", path, body=body, query=query)

    def patch(self, path: str, body: Any, query: Optional[dict] = None) -> Any:
        return self._request("PATCH", path, body=body, query=query)

    def delete(self, path: str, query: Optional[dict] = None) -> Any:
        return self._request("DELETE", path, query=query)

    def run_nqe_query(self, network_id: str, query_id: Optional[str] = None,
                      query: Optional[str] = None, params: Optional[dict] = None,
                      snapshot_id: Optional[str] = None, limit: int = 0) -> Any:
        """Run an NQE query: POST /api/nqe?networkId=&snapshotId= with queryId or raw query.

        Convenience wrapper restored for the discovery scripts (the bare endpoint is
        POST /api/nqe). Returns the parsed JSON (typically {"items": [...]})."""
        qs = {"networkId": network_id}
        if snapshot_id:
            qs["snapshotId"] = snapshot_id
        body: dict = {}
        if query_id:
            body["queryId"] = query_id
        if query:
            body["query"] = query
        if params:
            body["parameters"] = params
        if limit:
            body["queryOptions"] = {"limit": limit}
        return self.post("/api/nqe?" + urllib.parse.urlencode(qs), body)


def emit_json(obj: Any) -> None:
    """Print an object as JSON to stdout."""
    json.dump(obj, sys.stdout, indent=2, default=str)
    sys.stdout.write("\n")


def die(msg: str, code: int = 1) -> None:
    sys.stderr.write(f"error: {msg}\n")
    sys.exit(code)


# -- NQE catalog helpers ------------------------------------------------------
# The NQE catalog is bundled into every installed skill at scripts/_catalog/.
# These helpers let any script resolve a queryId from a path hint without
# duplicating discovery logic.


def find_catalog(script_file: str) -> Path:
    """Locate the bundled NQE catalog relative to the calling script.

    Search order:
      1. $FORWARD_NQE_CATALOG                       (explicit override)
      2. $CLAUDE_PLUGIN_ROOT/catalog/nqe-catalog.json (plugin install)
      3. <script_dir>/_catalog/nqe-catalog.json     (install.sh layout)
      4. <script_dir>/../_catalog/nqe-catalog.json
      5. walk-up <repo_root>/catalog/nqe-catalog.json (dev from source)
    """
    here = Path(script_file).resolve().parent
    candidates: list[Path] = []

    env_cat = os.environ.get("FORWARD_NQE_CATALOG")
    if env_cat:
        candidates.append(Path(env_cat))

    plugin_root = os.environ.get("CLAUDE_PLUGIN_ROOT")
    if plugin_root:
        candidates.append(Path(plugin_root) / "catalog" / "nqe-catalog.json")

    candidates.extend([
        here / "_catalog" / "nqe-catalog.json",
        here.parent / "_catalog" / "nqe-catalog.json",
    ])

    for parent in here.parents:
        cand = parent / "catalog" / "nqe-catalog.json"
        if cand.is_file():
            candidates.append(cand)
            break

    for c in candidates:
        if c.is_file():
            return c
    raise ForwardError(
        "bundled NQE catalog not found. Install the plugin, re-run install.sh, "
        "or set FORWARD_NQE_CATALOG. "
        f"Tried: {', '.join(str(c) for c in candidates)}"
    )


def load_catalog(script_file: str) -> list:
    """Return the list of catalog query records."""
    with find_catalog(script_file).open("r") as f:
        return json.load(f).get("queries", [])


def resolve_query_id(script_file: str, path_hint: str) -> dict:
    """Find the catalog entry whose path best matches the hint.

    Exact match (case-insensitive) wins. Otherwise the shortest path containing
    all whitespace-separated terms in `path_hint` (AND match) wins.

    Returns the full catalog record: {path, queryId, lastCommitId, sourceCodeSha}.
    Raises ForwardError if zero matches. If multiple ties, raises with the list
    so the caller can disambiguate.
    """
    queries = load_catalog(script_file)
    hint_lower = path_hint.lower().strip()
    # 1. Exact path match
    for q in queries:
        if q.get("path", "").lower() == hint_lower:
            return q
    # 2. AND-match on terms, rank by path length
    terms = [t for t in hint_lower.split() if t]
    candidates = [
        q for q in queries
        if all(t in q.get("path", "").lower() for t in terms)
    ]
    if not candidates:
        raise ForwardError(f"no catalog entry matches {path_hint!r}")
    candidates.sort(key=lambda q: (len(q.get("path", "")), q.get("path", "")))
    best = candidates[0]
    # If multiple exact-shortest-length ties, surface them
    ties = [q for q in candidates if len(q.get("path", "")) == len(best.get("path", ""))]
    if len(ties) > 1:
        listing = "\n  - " + "\n  - ".join(q.get("path", "") for q in ties)
        raise ForwardError(f"ambiguous catalog hint {path_hint!r}; tied candidates:{listing}")
    return best
