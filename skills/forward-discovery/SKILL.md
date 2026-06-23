---
name: forward-discovery
description: Run comprehensive pre-flight discovery before network changes to prevent fix-before-discovery anti-patterns. Use when the user asks "what should I check before making this change", "run pre-flight discovery on this network", "audit route-map policy consistency", "find dark links on these devices", "validate the network after my change". Not for ad-hoc path tracing (use forward-path-analysis), device inventory (use forward-inventory), or creating intent checks directly (use forward-intent-check).
allowed-tools: Bash(python3 *), Read
---

# Forward Discovery

> **Read first:** `${CLAUDE_PLUGIN_ROOT}/shared/expertise/forward-as-backend.md`

## Operate as a network engineer

Pre-flight discovery enforces a structured approach: **discover first, change second**. Before any configuration change, run the discovery workflow to establish baseline knowledge of interface state, BGP policy coverage, and existing intent violations. After each change, validate with `validate_all.py`.

- Read `${CLAUDE_PLUGIN_ROOT}/shared/expertise/investigation-workflows.md` for the recommended investigation chain.
- Read `${CLAUDE_PLUGIN_ROOT}/shared/expertise/config-syntax.md` for vendor-specific BGP and route-map syntax when auditing policy coverage.

---

## Invocation

Run from the user's cwd so the scripts auto-load `.env`. Do NOT `source .env` or export creds manually. Do not narrate which script you're about to run.

```bash
# Step 1: Capture architecture intent (required before preflight)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-discovery/scripts/architecture_intent.py" \
    --network-id <id> --output ARCHITECTURE.md

# Step 2: Run pre-flight check (orchestrates discovery; blocks if gaps found)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-discovery/scripts/preflight_check.py" \
    --network-id <id> --device-filter border

# Step 3: Inventory interfaces (find dark links)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-discovery/scripts/interface_inventory.py" \
    --network-id <id> --device-filter border

# Step 4: Audit route-map policy consistency across all eBGP sessions
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-discovery/scripts/route_map_audit.py" \
    --network-id <id>

# Step 5: Report pre-existing intent violations (establish baseline)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-discovery/scripts/check_intent_violations.py" \
    --network-id <id> --snapshot-id <snap-id>

# Step 6: Validate everything after a change
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-discovery/scripts/validate_all.py" \
    --network-id <id> --snapshot-id <snap-id> --config validation_matrix.yml

# Step 7: Browse NQE catalog for custom discovery queries
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-discovery/scripts/discover_nqe_queries.py" \
    --network-id <id> --suggest

# Step 8: Create intent checks to prevent regression after a fix
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-discovery/scripts/create_intent_checks.py" \
    --network-id <id> --preset route-leak-prevention --config regions.json
```

## Output format

Never paste raw JSON. Lead with a verdict, not a dump.

### `preflight_check.py`

```markdown
**Pre-Flight: <PASS | BLOCKED | WARNING>**

Blockers (exit 1 — must resolve before proceeding):
- <device>: ARCHITECTURE.md missing
- <device> → <neighbor>: eBGP session missing route-map

Warnings (exit 2 — review before proceeding):
- <device> <interface>: dark link (DOWN, no IP, no description)
- <N> pre-existing intent violations

To capture architecture intent, ask: "Run architecture_intent on network <id>."
```

If no blockers and no warnings: "**Pre-flight PASS.** Proceed with change."

### `architecture_intent.py`

```markdown
**Architecture Intent Captured → ARCHITECTURE.md**

Topology type: <mesh | hub-spoke | ring | ...>
Isolation model: <regional | tenant | VRF | ...>
Key design goals:
- <goal 1>
- <goal 2>

To run the pre-flight check, ask: "Run preflight_check on network <id>."
```

### `interface_inventory.py`

```markdown
**Interface Inventory — <device-filter | all devices>**

| Device | Interface | State | IP | Description | Flag |
|---|---|---|---|---|---|
| <device> | <iface> | DOWN | none | none | DARK LINK |
| ... |

Dark links: <N>  Mismatched peers: <N>  Total interfaces: <N>

If zero interfaces found: "No interfaces matched the filter."

To investigate a dark link, ask: "Check path to <device> <interface>."
```

Cap at 20 rows; if more, append: `(20 of <N>; use --device-filter to narrow)`.

### `route_map_audit.py`

```markdown
**Route-Map Audit — <PASS | VIOLATIONS FOUND>**

| Device | Neighbor | Direction | Route-Map | Status |
|---|---|---|---|---|
| <device> | <ip> | inbound | none | MISSING |
| <device> | <ip> | outbound | <map-name> | OK |

Sessions missing policy: <N> of <total>

If all sessions have route-maps: "**Route-map audit PASS.** All eBGP sessions covered."

To fix missing route-maps, ask: "Show me the config for <device> eBGP session to <neighbor>."
```

### `check_intent_violations.py`

```markdown
**Baseline Intent Violations — Snapshot <id>**

| Check | Severity | Status | Device | Detail |
|---|---|---|---|---|
| <check-name> | HIGH | FAIL | <device> | <summary> |

Total: <N> violations (<C> critical, <H> high, <M> medium, <L> low)

If zero violations: "**No intent violations.** Baseline is clean."

To create checks that prevent future violations, ask: "Create intent checks for network <id>."
```

Cap at 20 rows; if more, append: `(20 of <N>; use --severity-filter to narrow)`.

### `validate_all.py`

```markdown
**Post-Change Validation — Snapshot <id>: <PASS | FAIL>**

| Test | Type | Result | Detail |
|---|---|---|---|
| backbone connectivity | reachability | PASS | all border pairs reachable |
| tenant isolation | isolation | FAIL | us-client-1 → eu-client-1 reachable (VIOLATION) |
| BGP sessions | existential | PASS | all Established |
| route-map coverage | policy | PASS | all sessions covered |
| interface status | state | PASS | all active links UP |

Failed: <N>  Passed: <M>

If all pass: "**Validation PASS.** Change is safe."
If any fail: "**Validation FAIL.** Revert change, diagnose failure, revise plan."

To revert and re-examine, ask: "Show me the diff between snapshot <before> and <after>."
```

### `discover_nqe_queries.py`

```markdown
**NQE Catalog — <N> queries available**

| Category | Count |
|---|---|
| BGP | <N> |
| Interfaces | <N> |
| Security | <N> |

Suggested for discovery workflows:
- Physical topology: FQ_interface_status, FQ_interface_config
- Routing health: FQ_bgp_sessions, FQ_bgp_routes
- Policy audit: FQ_acl_summary, STIG_ios_cat1

If zero queries found: "No NQE catalog entries found. Verify the network has a processed snapshot."

To run a specific query, ask: "Run NQE query FQ_bgp_sessions on network <id>."
```

### `create_intent_checks.py`

```markdown
**Intent Checks Created — <N> checks**

| Check | Type | Src | Dst | Priority | Status |
|---|---|---|---|---|---|
| <name> | Isolation | <src> | <dst> | HIGH | Created |

If no checks created: "No checks were created. Verify --preset config file or --type/--name flags."

To list existing checks, ask: "List all intent checks on network <id>."
```

## When to use

- "What should I check before making changes to this network?"
- "Run pre-flight discovery before I fix this route leak"
- "Audit BGP route-map policy across all border sessions"
- "Find dark links on the border routers"
- "Show me what intent violations exist before I start"
- "Validate the network after my last snapshot"
- "Create checks so this route leak can't regress"

## When NOT to use

- Tracing a specific traffic flow → `forward-path-analysis`
- Listing devices, networks, or snapshots → `forward-inventory`
- Running arbitrary NQE queries → `forward-nqe-query`
- Inspecting device config or diffs → `forward-device-config`
- Managing intent checks (list, delete, get) → `forward-intent-check`
- Read-only device state (ARP, BGP peers, interfaces) → `forward-device-intel`

## Scripts

| Script | Purpose |
|---|---|
| `preflight_check.py` | Orchestrate pre-flight discovery; block premature changes |
| `architecture_intent.py` | Interactive questionnaire to capture network design intent |
| `interface_inventory.py` | Complete interface inventory; detect dark links |
| `route_map_audit.py` | Audit eBGP route-map policy consistency across all sessions |
| `check_intent_violations.py` | Report pre-existing intent violations as a baseline |
| `validate_all.py` | Post-change holistic validation against a config matrix |
| `discover_nqe_queries.py` | Browse NQE catalog and suggest queries for discovery workflows |
| `create_intent_checks.py` | Create Forward intent checks to prevent issue regression |

### preflight_check.py

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-discovery/scripts/preflight_check.py" \
    --network-id NET_xyz

python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-discovery/scripts/preflight_check.py" \
    --network-id NET_xyz --device-filter border --snapshot-id <snap-id>
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network ID |
| `--snapshot-id` | no | Defaults to latest processed |
| `--device-filter` | no | Substring match on device name (e.g., `border`) |
| `--workspace` | no | Directory for ARCHITECTURE.md / validation configs (default: cwd) |
| `--json` | no | Output results as JSON |

### architecture_intent.py

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-discovery/scripts/architecture_intent.py" \
    --network-id NET_xyz --output ARCHITECTURE.md
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network ID |
| `--network-name` | no | Human-readable label for the network |
| `--output` | no | Output file path (default: `ARCHITECTURE.md`) |
| `--non-interactive` | no | Use defaults — not recommended; defeats the purpose |

### interface_inventory.py

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-discovery/scripts/interface_inventory.py" \
    --network-id NET_xyz --device-filter border
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network ID |
| `--device-filter` | no | Substring match on device name |
| `--format` | no | `human` (default) or `json` |

### route_map_audit.py

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-discovery/scripts/route_map_audit.py" \
    --network-id NET_xyz
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network ID |
| `--format` | no | `human` (default) or `json` |

### check_intent_violations.py

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-discovery/scripts/check_intent_violations.py" \
    --network-id NET_xyz --snapshot-id <snap-id>
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network ID |
| `--snapshot-id` | no | Defaults to latest processed |
| `--format` | no | `human` (default) or `json` |
| `--verbose` | no | Show full violation details |
| `--severity-filter` | no | `critical`, `high`, `medium`, `low`, `info`, or `all` (default) |

### validate_all.py

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-discovery/scripts/validate_all.py" \
    --network-id NET_xyz --snapshot-id <snap-id> --config validation_matrix.yml
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network ID |
| `--snapshot-id` | no | Defaults to latest processed |
| `--config` | yes | Path to validation matrix YAML file |
| `--format` | no | `human` (default) or `json` |

### discover_nqe_queries.py

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-discovery/scripts/discover_nqe_queries.py" \
    --network-id NET_xyz --suggest

python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-discovery/scripts/discover_nqe_queries.py" \
    --network-id NET_xyz --category BGP --search "interface status"
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network ID |
| `--category` | no | Filter by category (BGP, Interfaces, Security, etc.) |
| `--search` | no | Keyword search across query names |
| `--show-descriptions` | no | Include query descriptions in output |
| `--format` | no | `human` (default) or `json` |
| `--suggest` | no | Show suggested queries for common discovery workflows |

### create_intent_checks.py

```bash
# Preset: route leak prevention (creates isolation checks between regions)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-discovery/scripts/create_intent_checks.py" \
    --network-id NET_xyz --preset route-leak-prevention --config regions.json

# Preset: BGP session existential checks
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-discovery/scripts/create_intent_checks.py" \
    --network-id NET_xyz --preset bgp-sessions --config border-routers.json

# Single custom isolation check
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-discovery/scripts/create_intent_checks.py" \
    --network-id NET_xyz --type Isolation --name "US DMZ → EU isolation" \
    --src-ip 192.168.100.0/24 --dst-ip 10.201.0.0/16 --priority HIGH
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network ID |
| `--snapshot-id` | no | Snapshot to evaluate against (default: latest processed) |
| `--preset` | no | `route-leak-prevention`, `bgp-sessions`, or `intra-region` |
| `--config` | no | JSON config file for preset (regions, border routers, etc.) |
| `--type` | no | `Isolation` or `Existential` (required for single check) |
| `--name` | no | Check name (required for single check) |
| `--src-ip` | no | Source IP or CIDR |
| `--dst-ip` | no | Destination IP or CIDR |
| `--priority` | no | `HIGH`, `MEDIUM` (default), or `LOW` |
| `--ip-proto` | no | IP protocol (`tcp`, `udp`, `icmp`, etc.) |
| `--src-port` | no | Source port number |
| `--dst-port` | no | Destination port number |
| `--note` | no | Documentation / reason for check |

## Gotchas

- **Scripts use print() not emit_json()**: These scripts were authored before the emit_json convention was adopted. Output will be human-readable text rather than structured JSON. Parse with care in automation contexts.
- **Scripts bypass _bootstrap / use cross-skill sys.path**: Current scripts insert sibling skill paths manually. A `_bootstrap.py` is now present but scripts do not yet import it. This is a known technical debt item.
- **ForwardClient() without .from_env()**: Scripts construct `ForwardClient()` directly instead of `ForwardClient.from_env()`. Credentials must be available via the environment in another way.
- **validate_all.py requires PyYAML**: The `--config` flag reads a YAML file using `yaml.safe_load()` (third-party). Ensure PyYAML is installed or convert your validation matrix to JSON format.
- **preflight_check.py writes files to cwd**: `architecture_intent.py` and `preflight_check.py` generate files (`ARCHITECTURE.md`, `validation_matrix.yml`) in the working directory. This is intentional but differs from the skill convention of emitting JSON only.
- **Snapshot scoping**: All scripts default to the network's latest processed snapshot. Pass `--snapshot-id` explicitly when comparing pre/post-change states.
- **Rate and size**: `validate_all.py` with many border pairs or tenant pairs can be slow — each reachability test is a separate path-analysis call.

## Reference documentation

- `references/create-intent-checks-examples.md` — worked examples and troubleshooting for `create_intent_checks.py`
