---
name: forward-nqe-query
description: Search the Forward NQE catalog and run network queries against snapshot data. Use when the user asks "how many interfaces are down", "which devices don't have AAA configured", "show me all BGP peers not Established", "run STIG check CISC-RT-000400", "write a query that finds VLANs with no active interfaces". Not for tracing flows (use forward-path-analysis), listing coarse inventory (use forward-inventory), or per-device config grep (use forward-device-config).
allowed-tools: Bash(python3 *), Read
---

# Forward NQE Query

> **Read first:** `${CLAUDE_PLUGIN_ROOT}/shared/expertise/forward-as-backend.md` — the foundational framing. NQE is the substrate's general-purpose query language — *SQL over the parsed network model*. When the user asks for any tabular network fact ("which devices have telnet enabled", "VLAN membership", "ACL contents", "routing-table size by VRF"), default to NQE, not to scripting the answer manually.

## Operate as a network engineer

NQE is the most general-purpose surface — almost any investigation touches it. Use it as part of a workflow, not just a one-shot:

- For multi-step asks (config-mismatch, policy-violation, reachability-failure), **read `${CLAUDE_PLUGIN_ROOT}/shared/expertise/investigation-workflows.md` first** to plan the chain. NQE often appears as the *bulk-scope* step — "find every device where X is true" — feeding into config / path / device-intel for per-device follow-up.
- When *interpreting* the tabular results — BGP neighbor states, route-protocol preferences, interface error counters, VLAN/VRF semantics, EVPN type-2/3/5 distinctions per vendor — read `${CLAUDE_PLUGIN_ROOT}/shared/expertise/config-syntax.md` for the routing-protocol and best-practice context.

---

NQE (Network Query Engine) is Forward Networks' query language over the network model. Think of it as SQL over every device's parsed state in a snapshot — interfaces, routes, ACLs, VLANs, BGP sessions, running-config, etc.

## Invocation

Run from the user's cwd so the scripts auto-load `.env`. Do NOT `source .env` or export creds manually. Do not narrate which script you're about to run.

```bash
# PREFERRED: Smart search with ranking, fuzzy matching, synonym support
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/smart_search_catalog.py" <terms> [--category CAT] [--min-matches N] [--limit N]

# LEGACY: Old search (requires ALL terms to match exactly)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/search_catalog.py" <terms> [--category CAT] [--repo fwd|org] [--limit N]

# Other tools
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/get_query_source.py" --path "<full-path>" --head
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/run_query.py" --network-id <id> --query-id <FQ_...> --limit 100
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/refresh_catalog.py" [--enrich]   # operator-only; bring catalog up to live
```

**Search behavior change:**
- **smart_search_catalog.py** (recommended): Ranks by relevance, doesn't require ALL terms, handles hyphens/synonyms
- **search_catalog.py** (legacy): Requires ALL terms to match exactly (often returns 0 results)

## Output format

Never paste raw JSON. Lead with a verdict, not a dump. Never dump more than ~20 rows without explicit opt-in.

### `smart_search_catalog.py`

```markdown
**<N> catalog matches** for `<terms>` (ranked by relevance)

| queryId | path | category | score |

- Show top results sorted by match score descending. Cap at 20 rows; if more exist, append: `(showing 20 of <total>; narrow terms or use --limit to see more)`.
- Group by top-level category if ≥ 3 categories appear.
- For zero results: "**No matches found** for `<terms>`. Try fewer or different keywords, or run `refresh_catalog.py --enrich` to enable semantic search."
- Close with a next step phrased as a user prompt, e.g. *"To read the top match before running it, ask: **Show me the source for `<top-match-path>`.**"*
```

### `search_catalog.py`

```markdown
**<N> catalog matches** for `<terms>`

| queryId | path |

- Truncate paths from the left if > 80 chars, keeping the tail (which carries the control code).
- Group by top-level category if ≥ 3 categories appear in the results.
- If `--list-categories` was used, emit a two-column table: `category | count`, sorted desc.
- Close with a next step phrased as a user prompt, e.g. *"To read one before running it, ask: **Show me the source for `&lt;top-match-path&gt;`.**"*
```

### `get_query_source.py`

```markdown
**Query: `<path>`** (repo: `<fwd|org>`, commit `<short-sha>`)

*<intent one-liner, if present>*

```nqe
<sourceCode>
```

- Below the code, add a one-sentence summary of what it returns (pull from the source's `foreach` / `select` if obvious).
- If the query takes parameters, list them as: `- <name>: <type> — <description>`.
```

### `run_query.py`

```markdown
**<N> rows** (queryId `<id>`, snapshot `<snap>`, <duration>s)

Emit results as a table using the server-returned column order. Limit to 20 rows in the response; if more exist, append: `(showing 20 of <total>; raise `--limit` to see more)`.

For zero rows, explicitly say "**Zero rows returned.** For STIG queries this means the control passed for every device. For other queries, the filter may have excluded everything."

If the query surfaces a pattern the user might want to drill into, close with a user-phrased next step, e.g. *"To audit this vendor network-wide, ask: **Run STIG compliance for &lt;vendor&gt;.**"* (handled by `forward-compliance-check`).
```

### `diff_query.py`

```markdown
**<N> changes** between snapshots `<before>` → `<after>` (<A> added · <D> deleted · <M> modified)

Emit results as a table with the injected `ChangeType` column. Sort by ChangeType (ADDED, DELETED, MODIFIED) unless `--sort-by-change` was used. Limit to 20 rows; if more exist, append: `(showing 20 of <total>; raise `--limit` to see more)`.

For zero changes: "**No changes detected** between snapshots <before> and <after>."

Highlight patterns:
- Large numbers of DELETED rows = outage or mass removal
- Large numbers of MODIFIED rows = significant drift
- Unexpected ADDED rows = new devices/configs appeared

Close with next steps:
- *"To investigate a specific changed device, ask: **Show me config for device X.**"*
- *"To trace the impact of this change, ask: **Can A still reach B?**"*
```

## When to use

- "How many interfaces are down on network X?"
- "Which devices don't have AAA configured?"
- "Show me all BGP peers in state != Established"
- "Run STIG check CISC-RT-000400"
- "Write a query that finds VLANs with no active interfaces"
- "What changed between yesterday and today?" (use `diff_query.py`)
- "Did the maintenance window apply correctly?" (use `diff_query.py`)
- "Show me routing changes this week" (use `diff_query.py`)

## When NOT to use

- Listing networks / snapshots / devices at a coarse level → `forward-inventory`
- Tracing whether traffic A → B can flow → `forward-path-analysis`
- Asking about network protocol *concepts* (not about your actual devices) → answer from knowledge

## Three-step workflow

NQE has a ~1879-query catalog, dominated by STIG compliance checks (~94%). The bundled catalog stores `path`, `queryId`, `lastCommitId`, `sourceCodeSha`, and (after a refresh) `repo` and `intent`. Source code still lives server-side.

**Canonical workflow**:

```
1. smart_search_catalog.py <terms>      → ranked results, fuzzy matching, synonym support
   (or search_catalog.py for strict AND logic)
2. get_query_source.py --path <path>    → read the actual NQE source before running
3. run_query.py --network-id <id> --query-id FQ_…  → execute against a snapshot
```

Step 2 is important: the path tells you the intent, but the source tells you exactly what fields it returns and whether its scope matches the user's question.

### Search improvements (smart_search_catalog.py)

**Problem:** The original `search_catalog.py` requires ALL search terms to match exactly:
- Search: `bgp routing policy prefix-list route-map` → 0 results
- Reason: "routing" and "policy" not in any BGP query paths

**Solution:** `smart_search_catalog.py` ranks by relevance:
- **Fuzzy matching**: `route-map` matches "route map", "routemap", "route-map"
- **Synonym support**: `routing` → `route`, `peer` → `neighbor`, `policy` → `policies`
- **Ranking**: Shows results with 1+ matches, sorted by relevance
- **Category boost**: Prioritizes results in relevant categories

**Example:**
```bash
# OLD: Returns 0 results (requires ALL terms)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/search_catalog.py" bgp routing policy prefix-list route-map

# NEW: Returns 42 results ranked by relevance
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/smart_search_catalog.py" bgp routing policy prefix-list route-map
# Top result: /vendor-specific/Cisco/BGP Route Maps Using Undefined Prefix Lists (4/6 matches)
```

**When to use which:**
- **smart_search_catalog.py** (default): Exploratory search, unknown terminology, multiple keywords
- **search_catalog.py**: Exact filtering, known paths, strict requirements

**Catalog enrichment:**
If `catalogEnriched: false`, search is path-only — semantic terms like "ssh timeout" will miss STIGs whose path is just an opaque control ID. Tell the user how to run `refresh_catalog.py --enrich` (one-time, ~5–15 min) to populate `intent` for every query. Enrichment dramatically improves both search tools.

## Scripts

All scripts read `FORWARD_API_KEY` / `FORWARD_API_SECRET` / `FORWARD_API_BASE_URL` and emit JSON.

| Script | Purpose |
|---|---|
| `smart_search_catalog.py` | Ranked catalog search with fuzzy matching, synonym support, and relevance scoring (preferred) |
| `search_catalog.py` | Offline AND-match grep of bundled catalog by path + intent keywords (legacy) |
| `get_query_source.py` | Fetch NQE source by path + commit (tries `fwd` then `org` repo) |
| `publish_query.py` | **Write** an NQE query to the `org` repo (add or update) via workspace-draft → commit; auto-selects add-vs-edit and **preserves the queryId on update**. Dry-run unless `--execute`. |
| `run_query.py` | POST `/api/nqe` with `queryId` or raw `query` string |
| `diff_query.py` | Compare query results between two snapshots (change detection) |
| `get_bgp_routes.py` | Get all BGP-learned routes from AFT (route leak detection, prefix validation) |
| `validate_bgp_nexthops.py` | Validate BGP next-hop reachability (detects unreachable next-hops causing BLACKHOLEs) |
| `monitor_bgp_health.py` | Monitor BGP session health; alert on sessions established but exchanging 0 prefixes |
| `audit_prepend_steering.py` | Find prefixes where an inactive path loses **purely on AS-path prepend** (reads BGP RIB state `adjRibInPost`); audits prepend-based plane/path steering and migration cutover. Flags: `--device`, `--vrf`, `--include-ties`, `--json` |
| `refresh_catalog.py` | Operator: refresh bundled catalog from live Forward; `--enrich` to populate intent text |

### smart_search_catalog.py

Preferred catalog search. Ranks results by relevance — does not require ALL terms to match. Handles fuzzy matching (hyphens, plurals) and synonym expansion.

```bash
# Exploratory search — ranked by relevance
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/smart_search_catalog.py" bgp routing policy prefix-list

# Filter to a category
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/smart_search_catalog.py" ssh timeout --category Security

# Require at least N term matches (stricter results)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/smart_search_catalog.py" bgp neighbor state --min-matches 2

# Dump all categories
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/smart_search_catalog.py" --list-categories
```

| Flag | Required | Notes |
|---|---|---|
| `terms` | no | One or more search terms; at least 1 match required by default |
| `--category` | no | Filter to a top-level catalog category |
| `--repo` | no | `fwd` or `org`; default: both |
| `--min-matches` | no | Minimum term matches to include a result (default: 1) |
| `--limit` | no | Max results returned (default: 20) |
| `--list-categories` | no | Emit a `category | count` table instead of search results |
| `--suggest` | no | Print "Did you mean…" suggestions for unmatched terms |

### search_catalog.py

Legacy AND-match search; all terms must appear in the path or intent. Use `smart_search_catalog.py` for exploratory searches.

```bash
# AND-match terms across path AND intent (when catalog is enriched)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/search_catalog.py" ssh timeout --limit 20

# Force path-only search (legacy behavior)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/search_catalog.py" --path-only bgp peer state

# Filter to a category and/or repo
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/search_catalog.py" --category Security --repo fwd cisco aaa

# Dump all categories
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/search_catalog.py" --list-categories
```

| Flag | Required | Notes |
|---|---|---|
| `terms` | no | Space-separated terms; ALL must match (AND logic) |
| `--category` | no | Filter to a top-level category (e.g. `Security`, `L3`, `Cloud`) |
| `--repo` | no | `fwd` or `org`; default: both |
| `--path-only` | no | Ignore intent text; match path tokens only |
| `--limit` | no | Max results (default: 20) |
| `--list-categories` | no | Emit a `category | count` table instead of search results |

Output shape: `[{queryId, path, category, repo, intent, lastCommitId}]` plus a `catalogEnriched` flag indicating whether intent text is available. Catalog is a bundled snapshot — operators should run `refresh_catalog.py` to align with live.

### get_query_source.py

```bash
# By full path (needs commit or --head)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/get_query_source.py" --path "/L3/Routes/BGP peers" --head

# By queryId from the catalog (uses lastCommitId)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/get_query_source.py" --query-id FQ_abc123 --path "/L3/Routes/BGP peers"
```

| Flag | Required | Notes |
|---|---|---|
| `--path` | yes | Full query path, e.g. `/L3/Routes/BGP peers` |
| `--commit-id` | no | Specific commit ID from catalog `lastCommitId` |
| `--head` | no | Use HEAD commit; mutually exclusive with `--commit-id` |
| `--repo` | no | `fwd` or `org`; default: tries `fwd` then falls back to `org` |

Tries `fwd` repo first, falls back to `org`. Returns `{intent, description, repository, sourceCode, ...}`.

### publish_query.py

**Writes** a query to the `org` repo. Default is a **dry-run** (prints the add-vs-edit plan); pass `--execute` to stage + commit. Always validate SYNTAX first with `run_query.py` — a broken query commits fine and only fails at run time.

```bash
# Dry-run: see whether this would add or update, and whether the queryId is preserved
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/publish_query.py" \
    --path "/Production/SR/Plane Validation" --file nqe/plane-validation.nqe

# Execute: stage + commit (auto add-vs-edit; editQuery PRESERVES the queryId)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/publish_query.py" \
    --path "/Production/SR/Plane Validation" --file nqe/plane-validation.nqe \
    --title "Update plane-validation" --body "always emit PASS/FAIL rows" --execute
```

| Flag | Required | Notes |
|---|---|---|
| `--path` | yes | Target query path in the repo (e.g. `/Production/SR/Plane Validation`) |
| `--file` / `--source` | yes | NQE source from a file or inline string |
| `--repo` | no | Only `org` (the `fwd` library repo is read-only) |
| `--title` / `--body` | no | Commit message (object `{title, body}`; title defaults from action+path) |
| `--execute` | no | Stage + commit; without it, dry-run only |
| `--keep-draft-on-error` | no | On commit failure, leave the staged change (default: discard just this path) |

How it works (the undocumented write API, baked into the script):
1. **Stage** into the user's workspace draft (reversible): `POST /api/users/current/nqe/changes?action=addQuery|editQuery&path=<path>`. `editQuery` carries `{"basis":{queryId,commitId}}` and **preserves the queryId** — prefer it over delete+re-add, which mints a new queryId and **orphans any intent check bound to it**.
2. **Commit** scoped to the path: `POST /api/nqe/repos/org/commits` body `{"paths":[<path>], "message":{title,body}}`. `paths` scopes the blast radius — unlisted dirs (e.g. other users' `/Users/*`) are structurally protected.
- Re-publishing **identical** source is a clean no-op (Forward stages nothing). `addQuery` requires the enclosing dir to already exist.

#### Convention: make the query a valid CHECK (`violation` field)

If you intend to bind the query to an NQE intent check, follow Forward's check convention (matches the built-in STIG `stigRuleRecord`):

- Return **one row per entity** in the full population, each with a boolean field literally named **`violation`** (optionally a `remediation`/`status` string for humans). The check engine counts rows where `violation == true` (0 → **PASS**).
- **If NO `violation` field is present, Forward counts EVERY returned row as a violation** — so a plain inventory query (one row per node) always FAILs. Proven: 8 rows with `violation:false` → PASS; the same 8 rows without the field → FAIL with 8 violations.
- So: return the **full population + a `violation` boolean**, *not* a `where`-filtered violations-only set (and not 0 rows). A self-contained query should also default its parameters so the standalone view is never empty.

### run_query.py

```bash
# By ID against latest snapshot of a network
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/run_query.py" --network-id NET_xyz --query-id FQ_abc123

# With explicit snapshot + pagination + parameters
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/run_query.py" --network-id NET_xyz --snapshot-id SNAP_abc \
    --query-id FQ_abc123 \
    --limit 100 --offset 0 \
    --param deviceName=core-rtr-01

# Raw query string (for custom queries)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/run_query.py" --network-id NET_xyz --query-file ./my-query.nqe --limit 50
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network ID |
| `--snapshot-id` | no | Snapshot ID; defaults to latest processed |
| `--query-id` | no* | Catalog query ID (`FQ_...`); one of `--query-id`, `--query`, or `--query-file` required |
| `--query` | no* | Raw NQE query string |
| `--query-file` | no* | Path to a file containing the NQE query |
| `--param` | no | `key=value` parameter; can repeat |
| `--params-json` | no | All parameters as a JSON object string |
| `--limit` | no | Max rows (default: 1000; max: 10000) |
| `--offset` | no | Rows to skip for paging (default: 0) |
| `--format` | no | `JSON` (default) or `CSV` |

### diff_query.py

**Change detection between snapshots.** Compares query results from a 'before' snapshot to an 'after' snapshot and identifies ADDED, DELETED, and MODIFIED rows. Essential for root cause analysis, change validation, and drift detection.

```bash
# Basic diff: compare BGP neighbors before/after a change
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/diff_query.py" --query-id FQ_bgp_neighbors \
    --before-snapshot 1234 --after-snapshot 1235

# Filter to only show ADDED rows (new entries)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/diff_query.py" --query-id FQ_interface_status \
    --before-snapshot 1234 --after-snapshot 1235 \
    --change-type ADDED

# Show only DELETED and MODIFIED (changes/removals)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/diff_query.py" --query-id FQ_routing_table \
    --before-snapshot 1200 --after-snapshot 1250 \
    --change-type DELETED --change-type MODIFIED

# Sort by change type
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/diff_query.py" --query-id FQ_vlan_list \
    --before-snapshot 1234 --after-snapshot 1235 \
    --sort-by-change

# With query parameters
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/diff_query.py" --query-id FQ_custom_query \
    --before-snapshot 1234 --after-snapshot 1235 \
    --params '{"deviceName": "rtr-01"}'
```

| Flag | Required | Notes |
|---|---|---|
| `--query-id` | yes | NQE query ID (`FQ_...`) |
| `--before-snapshot` | yes | Baseline snapshot ID (the "before" state) |
| `--after-snapshot` | yes | Comparison snapshot ID (the "after" state) |
| `--commit-id` | no | Specific query version (optional) |
| `--params` | no | JSON string of query parameters |
| `--change-type` | no | Filter by `ADDED`, `DELETED`, or `MODIFIED`; can repeat |
| `--sort-by-change` | no | Sort results by ChangeType column |
| `--limit` | no | Max rows (default: 1000; max: 10000) |
| `--offset` | no | Rows to skip for paging (default: 0) |

**Output:** Standard NQE result format with an injected `ChangeType` column containing `ADDED`, `DELETED`, or `MODIFIED`.

**Common use cases:**
- **Troubleshooting:** "It worked yesterday, broke today — what changed?" (compare good vs. broken snapshots)
- **Change validation:** "Did the maintenance window apply correctly?" (compare before/after change)
- **Drift detection:** "What routing changes happened this week?" (compare snapshots days apart)
- **Regression detection:** "Did any security ACLs get weakened?" (compare deny counts)
- **Compliance drift:** "Did new devices appear that violate policy?" (filter to ADDED violations)

**How it works:**
- Server-side diff computation (not manual comparison)
- Each row gets a `ChangeType` annotation
- Can sort/filter by `ChangeType` like any other column
- Standard NQE limits apply (default 1000 rows, max 10000)

### get_bgp_routes.py

**Get all BGP-learned routes from the AFT (Abstract Forwarding Table).** This is a commonly used query for BGP analysis, route leak detection, and prefix validation.

```bash
# Get all BGP routes in the network
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/get_bgp_routes.py" --network-id NET_xyz

# Filter to specific device
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/get_bgp_routes.py" --network-id NET_xyz --device us-border-1

# Filter to specific VRF
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/get_bgp_routes.py" --network-id NET_xyz --vrf default

# Search for specific prefixes
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/get_bgp_routes.py" --network-id NET_xyz --prefix 1.1.1

# Combine filters
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/get_bgp_routes.py" --network-id NET_xyz \
    --device us-border-1 \
    --vrf default \
    --prefix 10.200

# With explicit snapshot
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/get_bgp_routes.py" --network-id NET_xyz --snapshot-id 1525
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network ID |
| `--snapshot-id` | no | Snapshot ID; defaults to latest processed |
| `--device` | no | Filter to a specific device name (post-query filter) |
| `--vrf` | no | Filter to a specific VRF (post-query filter) |
| `--prefix` | no | Filter to prefixes containing this string (post-query filter) |
| `--limit` | no | Max results (default: 1000) |

**Output fields:**
- `Device`: Device name
- `VRF`: Network instance / VRF name
- `Prefix`: IP prefix (e.g., 10.200.0.0/24)
- `Protocol`: Origin protocol (BGP)
- `Next Hop IP`: Next-hop IP address
- `Next Hop Interface`: Outgoing interface
- `Next Hop Type`: Type of next-hop (e.g., LOCAL, REMOTE)

**Use cases:**
- **Route leak detection:** Check if internal prefixes (loopbacks, management) appear in BGP table
- **Prefix validation:** Verify expected routes are present
- **Route analysis:** Understand BGP routing behavior across network
- **Troubleshooting:** "Why is traffic going through device X instead of Y?"
- **Change detection:** Compare BGP routes before/after a change (use with `diff_query.py`)

**Note:** This queries the AFT (actual forwarding table), not BGP RIB. The AFT shows routes that are actually installed and being used for forwarding. For neighbor-specific advertised/received routes, use `forward-device-config --category ebgp_advr_routes` or `ebgp_recv_routes`.

### validate_bgp_nexthops.py

**Validate BGP next-hop reachability.** Detects BGP routes where the next-hop IP is not reachable via the routing table, causing traffic to BLACKHOLE.

**Common failure pattern (Scenario 2):**
1. BGP learns routes with next-hop X.X.X.X
2. IGP (OSPF/EIGRP/ISIS) should advertise route to X.X.X.X
3. Route filter (distribute-list, route-map) blocks the IGP advertisement
4. Next-hop is unreachable → BGP route is unusable → traffic BLACKHOLEs

```bash
# Check all BGP next-hops for reachability issues
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/validate_bgp_nexthops.py" --network-id NET_xyz

# Filter to specific device
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/validate_bgp_nexthops.py" --network-id NET_xyz --device us-client-1

# Filter to specific VRF
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/validate_bgp_nexthops.py" --network-id NET_xyz --vrf default

# Show all routes (including reachable), not just problems
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/validate_bgp_nexthops.py" --network-id NET_xyz --show-all

# With explicit snapshot
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/validate_bgp_nexthops.py" --network-id NET_xyz --snapshot-id 1525
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network ID |
| `--snapshot-id` | no | Snapshot ID; defaults to latest processed |
| `--device` | no | Filter to a specific device name |
| `--vrf` | no | Filter to a specific VRF |
| `--show-all` | no | Include reachable next-hops in output (default: problems only) |

**Output fields:**
- `Device`: Device name
- `VRF`: Network instance / VRF name
- `BGP Prefix`: The BGP-learned prefix
- `Next Hop IP`: Next-hop IP address
- `Next Hop Interface`: Outgoing interface
- `Next Hop Type`: Type (LOCAL, REMOTE, etc.)
- `Reachable`: true/false (is next-hop in routing table?)
- `Covering Route`: Which prefix covers the next-hop (if reachable)
- `Issue`: "UNREACHABLE_NEXTHOP" or null

**How it works:**
1. Query all BGP routes with next-hops (via `get_bgp_routes.py` query)
2. Query entire routing table (all protocols)
3. For each BGP next-hop, check if any routing table entry covers that IP
4. Flag routes where next-hop is NOT covered by any route

**Use cases:**
- **Troubleshooting BLACKHOLEs:** "Traffic to X.X.X.X is dropping, why?"
- **Route filter validation:** "Did my OSPF distribute-list break BGP?"
- **IGP-BGP integration:** "Are all BGP next-hops reachable via IGP?"
- **Network migrations:** "After moving to EIGRP, are all next-hops still reachable?"
- **Proactive monitoring:** "Alert on any unreachable next-hops"

**Example output (unreachable next-hop detected):**
```json
{
  "Device": "us-client-1",
  "VRF": "default",
  "BGP Prefix": "10.201.0.0/24",
  "Next Hop IP": "1.1.1.1",
  "Next Hop Interface": "et2",
  "Next Hop Type": "REMOTE",
  "Reachable": false,
  "Covering Route": null,
  "Issue": "UNREACHABLE_NEXTHOP"
}
```

**Root causes for unreachable next-hops:**
- OSPF/EIGRP/ISIS distribute-list filtering the next-hop subnet
- Route-map on redistribution blocking next-hop advertisements
- Missing static route to next-hop
- Next-hop in subnet that's not advertised by IGP
- Administrative distance preventing route installation

**Next steps after finding unreachable next-hops:**
1. Check IGP configuration (OSPF, EIGRP, ISIS) for distribute-lists/route-maps — ask: "Search device config for distribute-list on device X" (use `forward-device-config`)
2. Verify next-hop subnet is advertised by IGP
3. Use `forward-path-analysis` to trace why next-hop is unreachable — ask: "Can device A reach next-hop X.X.X.X?"
4. Fix: Remove overly restrictive filters or add static route to next-hop

### monitor_bgp_health.py

Alert on BGP sessions that are ESTABLISHED but exchanging zero or asymmetric prefixes — a common symptom of route-filter misconfiguration (Scenario 2 pattern).

```bash
# Check all BGP sessions; report WARNING and CRITICAL
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/monitor_bgp_health.py" --network-id NET_xyz

# Report only CRITICAL (zero-prefix) sessions
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/monitor_bgp_health.py" --network-id NET_xyz --alert-level CRITICAL

# Show all sessions including healthy
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/monitor_bgp_health.py" --network-id NET_xyz --verbose

# With explicit snapshot and custom iBGP pattern
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/monitor_bgp_health.py" --network-id NET_xyz \
    --snapshot-id SNAP_abc \
    --ibgp-pattern "10." --ibgp-pattern "192.168."
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network ID |
| `--snapshot-id` | no | Snapshot ID; defaults to latest processed |
| `--alert-level` | no | Minimum level to report: `HEALTHY`, `WARNING`, `CRITICAL` (default: `WARNING`) |
| `--verbose` | no | Show all sessions including HEALTHY |
| `--ibgp-pattern` | no | IP prefix string for iBGP peer detection (e.g., `10.` or `1.1.1.`); can repeat |

*Note: output uses `print()`/`json.dumps()` rather than `emit_json()`. When parsing output programmatically, use `--format json`; the `human` and `prometheus` modes produce plain text, not JSON.*

*To trace why next-hops are unreachable on a problem session, ask: "Validate BGP next-hop reachability on network NET_xyz."*

### refresh_catalog.py

Operator-only. Pulls the live catalog from `/api/nqe/repos/{fwd,org}/commits/head/queries`, tags each entry with its `repo`, and (with `--enrich`) fetches every query's source to attach a one-line `intent`. Writes in-place to wherever `find_catalog` resolves; preserves the `accessSettings` envelope.

```bash
# Fast path: refresh paths/IDs only (~2 API calls)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/refresh_catalog.py"

# Full enrichment so search_catalog.py can match intent text (~1879 calls)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/refresh_catalog.py" --enrich --throttle-ms 20

# Inspect what would change
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-nqe-query/scripts/refresh_catalog.py" --enrich --dry-run
```

| Flag | Required | Notes |
|---|---|---|
| `--repo` | no | `fwd` or `org`; can repeat; default: both |
| `--output` | no | Write refreshed catalog here; default: in-place |
| `--enrich` | no | Fetch each query's source and attach one-line `intent` (~1879 API calls) |
| `--throttle-ms` | no | Milliseconds to sleep between enrich calls (default: 20) |
| `--dry-run` | no | Show what would change without writing |

## Gotchas

- **Slow**: NQE runs against the parsed network model. Simple queries: seconds. Full-catalog STIG sweeps on large networks: 30-120s. Warn the user.
- **Large results**: a single query can return thousands of rows. Always pass `--limit` unless the user explicitly asked for everything. Default limit = 1000.
- **Snapshot-scoped**: every run is against one snapshot. If the user asks "what's happening now?" — fetch the latest snapshot ID first via `forward-inventory` (ask: "List the latest snapshot for network NET_xyz").
- **Parameters are per-query**: some catalog queries take parameters (e.g. `deviceName`). Inspect the source first to know what's required.
- **Two repos, no flag in legacy catalog**: pre-refresh records don't carry a `repo` field, so `get_query_source.py` tries `fwd` first and falls back to `org`. Run `refresh_catalog.py` to tag every record with its repo and skip the fallback round-trip.
- **Path-only search misses semantics**: STIG paths look like `CISC-RT-000400 V-216588` — the intent ("AAA timeout") lives in the source, not the path. If `catalogEnriched` is false in `search_catalog.py` output, semantic queries will miss; suggest `refresh_catalog.py --enrich`.

## Writing a custom query

Two complementary sources keep custom NQE correct — use both:

- **`references/nqe-reference.md`** — the authoritative NQE grammar: query structure, type
  system, operators, `foreach`/`where`/`let`/`group-by`/`select` clauses, expressions,
  built-in functions, pattern matching, UDFs (`export`/`import`), parameterized queries
  (`@query`), the data-model schema, enums, common patterns, and gotchas. Read this when you
  need to **author** a query from scratch or understand a clause/function you haven't seen.
- **The live catalog** — ground-truth working examples for the exact data you're after.

Fastest path to a correct custom query:

1. Use `smart_search_catalog.py` to find a query that returns similar data.
2. Use `get_query_source.py` to read its source (real, current syntax for that pattern).
3. Adapt it — or, for a clause/function the example doesn't cover, consult
   `references/nqe-reference.md` for the grammar rather than guessing.
4. Run with `run_query.py --query-file`. **Validate syntax by running** before any
   `publish_query.py` — a broken query commits fine and only fails at run time.

Don't write NQE from training-data memory: prefer a verified catalog example for the shape,
and the grammar reference for any syntax the example doesn't show. `references/nqe-primer.md`
is the quick orientation; `references/nqe-reference.md` is the full grammar.
