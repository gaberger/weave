---
name: forward-security-posture
description: Manage Forward Networks security-matrix filters AND retrieve the rendered security matrix itself (zone-to-zone reachability grid). Use when the user asks to "list matrix filters", "create a security matrix filter", "scope the security matrix to these zones", "delete a posture filter", "show me the security matrix", "fetch the posture matrix", "is zone X reachable from zone Y", or anything about the named filter sets and the matrix evaluation that uses them. Not for running path searches (use forward-path-analysis), STIG sweeps (use forward-compliance-check), or one-off NQE queries (use forward-nqe-query).
allowed-tools: Bash(python3 *), Read
---

# Forward Security Posture

> **Read first:** `${CLAUDE_PLUGIN_ROOT}/shared/expertise/forward-as-backend.md` — the foundational framing. The security matrix is the substrate's *zone-to-zone reachability projection*. When the user says "show me the security matrix" / "is DMZ blocked from Trusted" / "render the posture", default to `get_matrix.py` against the pinned network/snapshot, not to listing the filter management scripts.

## Operate as a network engineer

Posture work is rarely a single API call — the operator usually wants to *bound the scope*, *retrieve the matrix*, then *drill into specific zone-to-zone hotspots*. Before single-shotting a filter operation:

- Read `${CLAUDE_PLUGIN_ROOT}/shared/expertise/investigation-workflows.md` (Workflow 2 — *Policy / compliance violation*) for chaining: define/select the filter here → fetch the security-matrix → drill into hotspots with `forward-path-analysis` for confirmation → optional remediation via `forward-device-config` + `forward-predict`.
- For interpreting matrix cells (what "reachable" really means at the protocol/port level, what zones imply across vendors), read `${CLAUDE_PLUGIN_ROOT}/shared/expertise/config-syntax.md` (zone-firewall and ACL sections).

---

Wraps the security-matrix filter endpoints on Forward Networks. A "matrix filter" is a saved bundle of `{name, resourcePools, protocolExclusions, timeoutMins}` that defines the scope a security-matrix evaluation runs against.

## Invocation

Run from the user's cwd so `.env` auto-loads. Do NOT `source .env` or export creds manually. Do not narrate which script you're about to run.

```bash
# List filters on a network
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-security-posture/scripts/list_matrix_filters.py" \
    --network-id <id>

# Filter by name substring (client-side)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-security-posture/scripts/list_matrix_filters.py" \
    --network-id <id> --name prod

# Create a filter (resourcePools shape comes from a JSON file you provide)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-security-posture/scripts/create_matrix_filter.py" \
    --network-id <id> \
    --name prod-east \
    --resource-pools-file ./prod-east-zones.json \
    --exclude-protocols udp,esp \
    --timeout-mins 30

# Preview the request without sending it
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-security-posture/scripts/create_matrix_filter.py" \
    --network-id <id> --name prod-east \
    --resource-pools-file ./prod-east-zones.json --dry-run

# Delete by id (preferred — unambiguous)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-security-posture/scripts/delete_matrix_filter.py" \
    --network-id <id> --filter-id <fid> --yes

# Delete by name (only works if unique on the network)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-security-posture/scripts/delete_matrix_filter.py" \
    --network-id <id> --name prod-east --yes

# ---- Retrieve the matrix itself ----

# Default filter (id=0), latest processed snapshot, normalized for the renderer
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-security-posture/scripts/get_matrix.py" \
    --network-id <id>

# Specific filter by name + specific snapshot
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-security-posture/scripts/get_matrix.py" \
    --network-id <id> --filter prod-east --snapshot-id <snap-id>

# Render as a colored grid (chain to forward-report-table)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-security-posture/scripts/get_matrix.py" \
    --network-id <id> --filter-id 0 --snapshot-id <snap-id> | \
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-report-table/scripts/render.py" \
    --template security-matrix --format html --output matrix.html

# Single cell + a suggested forward-path-analysis follow-up
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-security-posture/scripts/get_matrix.py" \
    --network-id <id> --filter-id 0 --shape cell --src DMZ --dst Trusted

# Raw passthrough (bypass normalization — for debugging the API response shape)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-security-posture/scripts/get_matrix.py" \
    --network-id <id> --shape raw

# Bulk import filters from a JSON file
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-security-posture/scripts/import_matrix_filters.py" \
    --network-id <id> --input ./filters.json

# Dry-run the import (validate and show plan without writing)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-security-posture/scripts/import_matrix_filters.py" \
    --network-id <id> --input ./filters.json --dry-run

# Import with conflict policy
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-security-posture/scripts/import_matrix_filters.py" \
    --network-id <id> --input ./filters.json --on-conflict replace
```

## Output format

Never paste raw JSON. Lead with a verdict, not a dump.

### `list_matrix_filters.py`

```markdown
**<count> security-matrix filters on network <network-id>**

One per line, grouped by *configured / sample / auto* if obvious:

    <id>  <name>  <#resourcePools> pools  <timeoutMins>m  [excl: <protos>]

- If `count > 25`, show top 25 and append `...and <k> more (say "list all" to expand)`.
- Mention `protocolExclusions` only if non-empty.
- If count is 0, say: "No security-matrix filters found on network <id>."
```

To create one, ask: "Create a security-matrix filter named prod-east on network \<id\>."

### `create_matrix_filter.py`

```markdown
On success, summarize as:

    Created filter **<name>** (id `<id>`) on network <network-id> — <#pools> resource pools, timeout <m>m[, excludes <protos>].

If the response was empty 2xx, say so explicitly and emit the echoed body.
On 400, surface the server's detail string verbatim — it identifies which field failed validation.
```

To retrieve the matrix for this filter, ask: "Show me the security matrix for filter \<name\> on network \<id\>."

### `delete_matrix_filter.py`

```markdown
    Deleted filter <id> on network <network-id>.
```

To confirm the deletion, ask: "List security-matrix filters on network \<id\>."

### `get_matrix.py`

Present the result based on the `--shape` used:

**`--shape matrix` (default):** Render the zone-to-zone grid as a table. Cap at 20 rows/columns; if larger, note the total count and suggest narrowing with a named filter.

```markdown
**Security matrix for network <id>, filter <filter-id>, snapshot <snap-id>**

| Zone | ZoneA | ZoneB | ZoneC |
|------|-------|-------|-------|
| ZoneA | OPEN | NO_ROUTE | OPEN |
| ZoneB | NO_ROUTE | — | OPEN |
| ZoneC | OPEN | OPEN | — |

- OPEN = traffic allowed; NO_ROUTE = no forwarding path.
- If the matrix is empty (no zones), say: "No matrix data returned for this filter/snapshot combination."
```

To drill into a specific cell, ask: "Is zone DMZ reachable from zone Trusted?"

**`--shape cell`:** Report the single cell verdict and the suggested path drill-down.

```markdown
Zone <src> → Zone <dst>: **<VERDICT>** (filter <filter-id>, snapshot <snap-id>)

To trace the exact path, ask: "Trace traffic from <src> to <dst> on snapshot <snap-id>."
```

**`--shape raw`:** Present the raw API response summary (field names only), and offer to normalize. Do not dump the full JSON.

### `import_matrix_filters.py`

```markdown
**Import complete — network <id>**

- Created: <N>  Replaced: <N>  Skipped: <N>  Failed: <N>  (of <total> total)

List any failures with their error messages. If all succeeded, confirm:
"All <N> filters imported successfully."

If `failed > 0`, surface each failure's name and error string verbatim.
If count is 0 or the file was empty, say: "Nothing to import — the input file contained no filters."
```

To verify the import, ask: "List security-matrix filters on network \<id\>."

## When to use
- "What security-matrix filters do we have on network X?"
- "Create a filter named *prod-east* covering the prod-east zones."
- "Delete the *sample* filter from network X."
- "Show me the security matrix for the *prod-east* filter."
- "Is zone DMZ reachable from zone Trusted?"
- "Render the posture matrix as a colored grid I can show in the review."

## When NOT to use
- Running a hop-by-hop path trace for a specific 5-tuple → `forward-path-analysis`.
- STIG / compliance sweeps → `forward-compliance-check`.
- Reading device state (zones, interfaces, ARP) → `forward-device-intel` / `forward-nqe-query`.

## Scripts

| Script | Purpose |
|---|---|
| `list_matrix_filters.py` | List all security-matrix filters on a network (with optional name substring filter) |
| `create_matrix_filter.py` | Create a new security-matrix filter from a JSON resource-pools file |
| `delete_matrix_filter.py` | Delete a filter by id or unique name (requires `--yes`) |
| `get_matrix.py` | Retrieve the security matrix; supports normalized matrix, single-cell, or raw output shapes |
| `import_matrix_filters.py` | Bulk-import filters from a JSON array file with skip/fail/replace conflict policy |

### `list_matrix_filters.py`

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-security-posture/scripts/list_matrix_filters.py" \
    --network-id NET_xyz
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network id |
| `--name` | no | Case-insensitive substring match on filter name (client-side) |

### `create_matrix_filter.py`

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-security-posture/scripts/create_matrix_filter.py" \
    --network-id NET_xyz \
    --name prod-east \
    --resource-pools-file ./prod-east-zones.json \
    --exclude-protocols udp,esp \
    --timeout-mins 30
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network id |
| `--name` | yes | Filter name (non-empty) |
| `--resource-pools-file` | yes | Path to a JSON array of resource-pool objects; see `references/resource-pool-shapes.md` for the per-subtype schema |
| `--exclude-protocols` | no | Comma-separated IANA protocol numbers or aliases (e.g. `udp,esp` or `17,50`) |
| `--timeout-mins` | no | Per-cell evaluation timeout in minutes (default: 30) |
| `--dry-run` | no | Print the POST body without calling the API |

### `delete_matrix_filter.py`

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-security-posture/scripts/delete_matrix_filter.py" \
    --network-id NET_xyz --filter-id <fid> --yes
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network id |
| `--filter-id` | yes (or `--name`) | Numeric filter id; preferred — unambiguous |
| `--name` | yes (or `--filter-id`) | Filter name; must be unique on the network |
| `--yes` | yes | Confirms destructive action; required to proceed |

### `get_matrix.py`

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-security-posture/scripts/get_matrix.py" \
    --network-id NET_xyz --filter prod-east --shape matrix
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network id |
| `--snapshot-id` | no | Snapshot id or `latestProcessed` (default); the endpoint requires a numeric id and this script resolves the sentinel automatically |
| `--filter-id` | no | Numeric filter id; `0` is the default/global filter |
| `--filter` | no | Filter name (resolved by listing); mutually exclusive with `--filter-id` |
| `--shape` | no | `matrix` (default) normalize to `{zones, cells}`; `cell` single cell + drill-down hint; `raw` passthrough |
| `--src` | no | Source zone name — required when `--shape cell` |
| `--dst` | no | Destination zone name — required when `--shape cell` |

### `import_matrix_filters.py`

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-security-posture/scripts/import_matrix_filters.py" \
    --network-id NET_xyz --input ./filters.json --on-conflict replace
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Target network id to import filters into |
| `--input` | yes | Path to a JSON array of stripped filter objects |
| `--on-conflict` | no | `skip` (default) / `fail` / `replace` — behavior when a filter with the same name already exists |
| `--dry-run` | no | Validate inputs and show plan without writing to the API |

## Gotchas

- **resourcePools shape is server-defined.** This skill takes the array from a JSON file rather than CLI flags so you can match whatever zone-object schema your Forward instance expects (zone-name strings, `{name, devices}` objects, etc.). When in doubt, list an existing filter first and copy its `resourcePools` shape. See `references/resource-pool-shapes.md` for the per-subtype keyset.
- **Name uniqueness is not enforced by the server.** `delete_matrix_filter.py --name` refuses to act on duplicates — pass `--filter-id` instead.
- **`timeoutMins` upper bound is server-side.** The validation tests reject 5000; safe defaults are in the 5–60 range. The server's exact ceiling isn't documented here — if 30 fails, ask Forward support, don't guess upward.
- **Protocol exclusions use IANA numbers.** `--exclude-protocols` accepts `udp,esp` or `17,50`. Aliases supported: icmp, igmp, tcp, udp, gre, esp, ah, icmpv6, ospf.
- **`--dry-run` does not call the API** and so cannot validate the zone shape. Use it only to verify the JSON envelope and field names.
- **DELETE is destructive and requires `--yes`.** This is the skill's only confirmation gate; there is no soft-delete or undo.
- **`get_matrix.py` requires a numeric snapshot id.** The `/security-matrix` endpoint rejects the sentinel `latestProcessed` — the script resolves this automatically by listing snapshots, but if the network has no processed snapshots `die()` is called.
- **`--shape raw`** bypasses normalization and returns the Forward API response verbatim. Use only for debugging the API shape; never present raw JSON to the user.
- **Validation contract (preflight):** `create_matrix_filter.py` and `import_matrix_filters.py` validate client-side before any API call. Valid `resourcePools` item types: `DEVICE_ZONE`, `ON_PREM`, `CLOUD`. Unknown fields at the filter or pool level are rejected. The field name is `timeoutMins` — NOT `timeoutSecs`/`timoutSecs`.
