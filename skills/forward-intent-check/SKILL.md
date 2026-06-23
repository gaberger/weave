---
name: forward-intent-check
description: Create and read intent checks (verifications) that ensure network policy and behavior hold as configurations evolve. Use when the user asks "create a check that X can reach Y", "verify isolation between A and B", "list all checks", "what checks are failing", "delete check Z". Not for ad-hoc path tracing (use forward-path-analysis), policy hunting (use forward-security-posture), or device state queries (use forward-nqe-query or forward-device-intel).
allowed-tools: Bash(python3 *), Read
---

# Forward Intent Check

> **Read first:** `${CLAUDE_PLUGIN_ROOT}/shared/expertise/forward-as-backend.md` — the foundational framing. Intent checks are the substrate's *verification* primitive — they codify "this traffic SHOULD be allowed" or "this traffic MUST be blocked" and re-evaluate as the network changes. When the user says "verify that" / "create a check that" / "what's failing", default to calling this skill — *don't* try to manually re-run a path search each time the network changes.

## Operate as a network engineer

Checks (called "Verifications" in the UI) are how operators prevent regressions and ensure desired behavior persists as configs evolve. A failing check is rarely the whole answer — the operator wants to know *which device, which feature, which config line* caused the failure, and *what to change*. Before single-shotting a check creation:

- Read `${CLAUDE_PLUGIN_ROOT}/shared/expertise/investigation-workflows.md` (Workflow 1 — *Verification failure*) for the recommended chain: list failing checks → read diagnosis → fetch the relevant config or device-state → propose a fix → optionally validate via `forward-predict` + re-check with `--changeset`.
- When the diagnosis points at vendor-specific behavior (Cisco ACL ordering, Junos firewall-filter, PAN-OS rule shadowing, FortiOS sequence numbers, NX-OS feature flags, BGP neighbor state), read `${CLAUDE_PLUGIN_ROOT}/shared/expertise/config-syntax.md` for the syntax + semantics needed to read the offending stanza correctly.

---

Forward supports 5 types of checks that verify network policy and behavior:

| Type | Purpose | When to use |
|---|---|---|
| **Existential** | Verify specific traffic IS allowed between points | "Ensure prod apps can reach DB on 5432" |
| **Isolation** | Verify specific traffic IS blocked between points | "Ensure DMZ cannot reach internal mgmt VLAN" |
| **Reachability** | Verify traffic gets delivered to intended destination | "Confirm backup path delivers to DR site" |
| **NQE** | Run a custom or library query as a check | "Alert if any device has SSH on non-standard port" |
| **Predefined** | Library of common checks (BGP, VLAN, MTU, etc.) | "Verify BGP neighbor adjacency across network" |

## Invocation

Run from the user's cwd so the scripts auto-load `.env`. Do NOT `source .env` or export creds manually. Do not narrate which script you're about to run.

```bash
# List all checks (with status)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-intent-check/scripts/list_checks.py" \
    --network-id <id>

# List only failing checks
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-intent-check/scripts/list_checks.py" \
    --network-id <id> --status FAIL

# Get a specific check with diagnosis
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-intent-check/scripts/get_check.py" \
    --network-id <id> --check-id <check_id>

# Create an Existential check
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-intent-check/scripts/create_check.py" \
    --network-id <id> --type Existential \
    --name "Prod app can reach DB" \
    --src-ip 10.1.2.3 --dst-ip 10.5.0.10 --ip-proto tcp --dst-port 5432

# Create an Isolation check
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-intent-check/scripts/create_check.py" \
    --network-id <id> --type Isolation \
    --name "DMZ isolated from mgmt" \
    --src-ip 10.10.0.0/16 --dst-ip 10.0.0.0/8

# Delete a check
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-intent-check/scripts/delete_check.py" \
    --network-id <id> --check-id <check_id>
```

## Output format

Never paste raw JSON. Lead with a verdict, not a dump.

### `list_checks.py`

```markdown
**<N> checks** (<passing> passing · <failing> failing · <errors> errors)

Sort by status (FAIL first, then ERROR, then PASS), then by name.

| Name | Type | Priority | Status | Violations |

Truncate to 20 rows; if more, append: `(20 of <N>; use --type or --status filters to narrow)`.

If user asked for failing checks only and there are none: "**All checks passing** ✓"
```

### `get_check.py`

```markdown
**<name>** · <type> · <priority> · <status>

- **Created:** <createdAt> by <creator>
- **Last executed:** <executedAt> (<executionDurationMillis>ms)
- **Status:** <status> (<numViolations> violations)

**Definition:**
<terse summary of the check's filters/query>

If status is FAIL and diagnosis is available:
> **Diagnosis:**
> <diagnosis.summary>
> 
> Failing devices: <extract from diagnosis.details[].references[]>
> Relevant config: <extract file references if present>

If status is PASS:
> ✓ Check passing

Suggest next step as a user prompt, not a command:
- *"To read the config snippet that's failing, ask: **Show me the config for device X lines Y-Z.**"*
- *"To trace the path and see why it's dropping, ask: **Trace path from A to B.**"*
```

### `create_check.py`

```markdown
**Check created** · <name> · <type> · <status>

- **ID:** `<id>`
- **Status:** <status> (<numViolations> violations)

If status is FAIL:
> ⚠️ Check failed immediately. <Brief diagnosis summary if included>

If status is PASS:
> ✓ Check passing

Remind the user that checks persist forward to future snapshots: "This check will automatically re-evaluate on all future snapshots."
```

### `delete_check.py`

```markdown
**Check deleted** · <check_id>

This check has been deactivated for snapshot <snapshotId> and all future snapshots.
```

### `list_predefined.py`

```markdown
**<N> predefined check types available**

| Type | Description |
|---|---|
| `BGP_NEIGHBOR_ADJACENCY` | Verify all BGP neighbor sessions are established |
| `VLAN_CONSISTENCY` | Verify VLAN configuration is consistent across the network |
| ... | ... |

Truncate to 20 rows; if more, append: `(20 of <N> types shown)`.

If no predefined types are returned: "No predefined check types found — verify the network is reachable and the snapshot is processed."
```

To create one of these checks, ask: "Create a predefined check for BGP neighbor adjacency on network NET_xyz."

## When to use

- "Create a check that web servers can reach the DB"
- "Verify isolation between DMZ and internal networks"
- "Show me all failing checks"
- "What checks do we have for this network?"
- "Delete the check named X"
- "Why is check Y failing?"

## When NOT to use

- Ad-hoc path tracing ("can A reach B right now?") → `forward-path-analysis`
- Policy matrix questions ("what can access what?") → `forward-security-posture`
- Device-level state queries → `forward-nqe-query` or `forward-device-intel`
- One-time bulk path searches → `forward-path-analysis` with `search_paths_bulk.py`

## Scripts

| Script | Purpose |
|---|---|
| `list_checks.py` | List all checks (optionally filtered by type, status, priority) |
| `get_check.py` | Get a specific check with diagnosis |
| `create_check.py` | Create a new check (any of the 5 types) |
| `patch_check.py` | Update a check's metadata (note / tags / priority / name) via immutable replace |
| `delete_check.py` | Deactivate a check |
| `list_predefined.py` | List available Predefined check types |

### list_checks.py

```bash
# All checks
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-intent-check/scripts/list_checks.py" --network-id NET_xyz

# Only failing checks
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-intent-check/scripts/list_checks.py" --network-id NET_xyz --status FAIL

# Only high-priority checks
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-intent-check/scripts/list_checks.py" --network-id NET_xyz --priority HIGH

# Filter by type
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-intent-check/scripts/list_checks.py" --network-id NET_xyz --type Existential --type Isolation

# Use specific snapshot (default: latest processed)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-intent-check/scripts/list_checks.py" --network-id NET_xyz --snapshot-id <id>
```

Arguments:

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | From `forward-inventory/list_networks.py` |
| `--snapshot-id` | no | Defaults to latest processed snapshot |
| `--type` | no | Filter by check type (can repeat) |
| `--priority` | no | Filter by priority: LOW, MEDIUM, HIGH (can repeat) |
| `--status` | no | Filter by status: PASS, FAIL, ERROR, TIMEOUT (can repeat) |

### get_check.py

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-intent-check/scripts/get_check.py" --network-id NET_xyz --check-id <check_id>
```

Returns a specific check with its full diagnosis (if it failed). Use this to investigate *why* a check is failing.

Arguments:

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | From `forward-inventory/list_networks.py` |
| `--check-id` | yes | From `list_checks.py` output |
| `--snapshot-id` | no | Defaults to latest processed snapshot |

### create_check.py

Create a new check. The check will be evaluated immediately on the current snapshot and will automatically propagate forward to all future snapshots (unless `--persistent false` is specified).

**Existential / Isolation / Reachability checks:**

```bash
# Existential: verify traffic IS allowed
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-intent-check/scripts/create_check.py" --network-id NET_xyz --type Existential \
    --name "Prod app → DB" \
    --src-ip 10.1.2.3 --dst-ip 10.5.0.10 --ip-proto tcp --dst-port 5432

# Isolation: verify traffic IS blocked
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-intent-check/scripts/create_check.py" --network-id NET_xyz --type Isolation \
    --name "DMZ → internal" \
    --src-ip 10.10.0.0/16 --dst-ip 10.0.0.0/8

# Reachability: verify traffic reaches intended destination
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-intent-check/scripts/create_check.py" --network-id NET_xyz --type Reachability \
    --name "DR reachability" \
    --src-ip 10.1.2.3 --dst-ip 10.99.0.10
```

Common arguments for path-based checks:

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Target network |
| `--type` | yes | `Existential`, `Isolation`, or `Reachability` |
| `--name` | yes | Human-readable check name |
| `--src-ip` | recommended | Source endpoint: IP/CIDR **or a bare device name** (device name → ingress `DeviceFilter`). See `references/location-filters.md`. |
| `--dst-ip` | yes | Destination endpoint: IP/CIDR **or a bare device name** (device name → egress `DeviceFilter`, lets you pin which device traffic must leave through). |
| `--ip-proto` | no | `tcp`, `udp`, `icmp`, or protocol number |
| `--src-port` / `--dst-port` | no | Port or range (string) |
| `--priority` | no | `LOW`, `MEDIUM`, `HIGH` (default: `NOT_SET`) |
| `--note` | no | Additional context / documentation |
| `--persistent` | no | Propagate to future snapshots (default: `true`) |
| `--snapshot-id` | no | Defaults to latest processed snapshot |

**NQE checks:**

```bash
# Plain NQE check — no --name (API uses the query name)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-intent-check/scripts/create_check.py" --network-id NET_xyz --type NQE \
    --query-id FQ_abc123def456... \
    --priority HIGH

# PARAMETERIZED NQE check (@query) — --name is REQUIRED and becomes a suffix after
# the query name; --note/--tags are rejected by the API and auto-dropped with a warning
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-intent-check/scripts/create_check.py" --network-id NET_xyz --type NQE \
    --query-id Q_abc123... \
    --name "payments → SR" \
    --params '{"targetPlane":"s-plane","targetCE":["ce-a","ce-b"],"Match":true}' \
    --priority HIGH
```

| Flag | Required | Notes |
|---|---|---|
| `--query-id` | yes | From `forward-nqe-query` catalog (the published query's `queryId`) |
| `--params` | no | JSON string of query parameters. **If set, the query is parameterized → `--name` becomes required.** |
| `--name` | conditional | **Required for parameterized (`@query`) NQE checks** (API mandate; auto-prefixed with the query name). Ignored for plain NQE. |
| `--note` / `--tags` | NO | ⚠️ Rejected by the API for NQE checks — auto-dropped with a stderr warning |

**Predefined checks:**

```bash
# List available predefined check types
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-intent-check/scripts/list_predefined.py"

# Create a predefined check
# NOTE: Predefined checks CANNOT have custom --name (Forward API restriction)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-intent-check/scripts/create_check.py" --network-id NET_xyz --type Predefined \
    --predefined-type BGP_NEIGHBOR_ADJACENCY \
    --priority MEDIUM \
    --note "Monitor BGP session stability"
```

| Flag | Required | Notes |
|---|---|---|
| `--predefined-type` | yes | From `list_predefined.py` output |
| `--params` | no | JSON string of check parameters |
| `--name` | NO | ⚠️ Ignored (API restriction) — predefined type name used instead |

### patch_check.py

Update a check's **metadata** — note, tags, priority, or name. Forward checks are
**immutable** (the API has no PUT/PATCH — it returns HTTP 405), so this emulates an
update by **POSTing a replacement with the same definition + patched metadata, then
deleting the old check**. Consequences:

- **The check id changes** on every patch (old id is soft-deleted, a new id is created).
- **Definitions are not patchable** here — a different definition is a different check
  (use `create_check.py`). Only metadata is editable.
- If the old check can't be deleted (e.g. it's referenced by a **scorecard**, which
  returns HTTP 400), the freshly-created replacement is **rolled back** so you are never
  left with a duplicate, and the check is reported as skipped/unchanged.

```bash
# Single check: add a tag (merged with existing tags) + set the intent note
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-intent-check/scripts/patch_check.py" \
    --network-id 111 --check-id 1264 \
    --add-tag l-plane --set-note "Plane sentinel: expected L-plane" --execute

# Bulk: tag every failing check, or re-tag a whole matched set (dry-run first)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-intent-check/scripts/patch_check.py" \
    --network-id 111 --status FAIL --add-tag needs-triage          # preview
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-intent-check/scripts/patch_check.py" \
    --network-id 111 --match-name "plane " --add-tag plane-validation --execute
```

Selection (AND-combined; at least one is required — the script refuses to patch the
whole network with no selector):

| Flag | Notes |
|---|---|
| `--check-id` | Explicit id, repeatable |
| `--match-name` | Name contains substring (case-insensitive) |
| `--match-tag` | Check currently carries this tag |
| `--status` | `PASS` / `FAIL` / `ERROR` / `TIMEOUT` |

Patches:

| Flag | Notes |
|---|---|
| `--set-note TEXT` | Replace the note / intent description |
| `--add-tag TAG` | Add tag(s), **merged** with existing (repeatable) |
| `--remove-tag TAG` | Drop tag(s) (repeatable) |
| `--set-tags T [T ...]` | **Replace** the entire tag list (overrides add/remove) |
| `--priority` | `LOW` / `MEDIUM` / `HIGH` / `NOT_SET` |
| `--set-name NAME` | Rename (path-based checks only) |
| `--execute` | Apply changes (default is a **dry-run** preview) |

### delete_check.py

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-intent-check/scripts/delete_check.py" --network-id NET_xyz --check-id <check_id>
```

Deactivates a check for the current snapshot and all future snapshots. This is a soft delete — the check's historical results remain visible.

Arguments:

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Target network |
| `--check-id` | yes | From `list_checks.py` |
| `--snapshot-id` | no | Defaults to latest processed snapshot |

### list_predefined.py

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-intent-check/scripts/list_predefined.py"
```

Lists all available Predefined check types (BGP, VLAN, MTU, etc.). No arguments required — this is a static catalog query.

## Gotchas

- **Checks are forward-propagating**: by default, a check created on snapshot N automatically applies to snapshots N+1, N+2, ... If you want a one-time check, set `--persistent false`.
- **Status is never NONE or PROCESSING**: the API waits for check evaluation to complete before returning. If a check is slow, you'll see longer response times, not a PROCESSING status.
- **Snapshot processing state matters**: `create_check.py` now auto-waits (up to 5 minutes by default) for snapshots to reach PROCESSED state. Use `--wait 0` to fail immediately if not ready, or `--wait 600` for longer timeout.
- **Path-based checks require processed reachability**: Existential/Isolation/Reachability checks may return `REQUIRES_ADDITIONAL_SNAPSHOT_PROCESSING` if advanced reachability computation hasn't been run yet. The script will auto-wait for this.
- **Check creation is synchronous**: creating a check waits for it to evaluate, which can take 10-60 seconds depending on check complexity and network size.
- **Diagnosis depth varies**: not all failing checks have rich diagnosis. Predefined and NQE checks often return tabular results; path-based checks return hop-by-hop diagnosis.
- **Priority is metadata**: priority affects sorting/filtering in the UI but doesn't change check behavior.
- **Deletion is irreversible**: once a check is deleted, it stops evaluating on future snapshots. Historical results remain, but the check won't run again.
- **⚠️ API restrictions on check names**:
  - **Predefined checks** CANNOT have custom --name (Forward API restriction)
  - **Plain NQE checks** CANNOT have custom --name (uses query name instead)
  - **Parameterized (`@query`) NQE checks** REQUIRE --name (API mandate; auto-prefixed with the query name). They also reject `note`/`tags`.
  - **Existential/Isolation/Reachability checks** REQUIRE --name
  - `create_check.py` handles all of this automatically — requires name for path-based + parameterized-NQE, omits it for plain NQE/Predefined, and drops note/tags for NQE
- **⚠️ Host alias requirements**:
  - Path-based checks using subnets (e.g., `--src-ip 10.200.0.0/16`) require host aliases configured in Forward UI
  - If you get "No hosts matching alias" error, use **device loopback IPs** instead of subnets
  - Example: use `--src-ip 1.1.1.1` (border router loopback) instead of `--src-ip 10.200.0.0/16` (subnet)
  - See `${CLAUDE_PLUGIN_ROOT}/INTENT_CHECK_TROUBLESHOOTING.md` for full troubleshooting guide
- **🎯 Endpoint args accept device names, not just IPs** (the misnomer that unlocks plane sentinels):
  - `--src-ip` / `--dst-ip` build a `SubnetLocationFilter` if the value looks like an IP/CIDR (`^\d+\.\d+`), otherwise a `DeviceFilter`.
  - A device name in `--src-ip` = **ingress** pin (`from`); a device name in `--dst-ip` = **egress** pin (`to`).
  - Pinning the egress to a **plane-specific device** turns a path-agnostic delivery check into a **migration / plane sentinel**: it PASSES only while traffic actually egresses that device, and FAILS the moment it falls back to another plane — even though end-to-end delivery still works.
  - Use **Existential** for egress-device sentinels (Reachability rejects a `to` device filter in some builds). Validate a sentinel by toggling the change and confirming it flips FAIL→PASS.
  - Full pattern + worked LDP→SR migration example: `references/location-filters.md`.

## Key concept: persistent vs. transient checks

By default, checks are **persistent** — they propagate forward to all future snapshots. This is the intended behavior: you create a check once, and it continuously monitors the network as configs change.

If you want a **transient** check (evaluate once, don't propagate), set `--persistent false`. This is rare — typically used for one-time validation during a change window.

## Common patterns

### 1. Reachability assertion (Existential)
*"Ensure production app servers can reach the database on port 5432"*

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-intent-check/scripts/create_check.py" --network-id NET_xyz --type Existential \
    --name "Prod → DB:5432" \
    --src-ip 10.1.0.0/16 --dst-ip 10.5.0.10 \
    --ip-proto tcp --dst-port 5432 \
    --priority HIGH
```

### 2. Security isolation (Isolation)
*"Ensure DMZ cannot reach internal management VLAN"*

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-intent-check/scripts/create_check.py" --network-id NET_xyz --type Isolation \
    --name "DMZ ⛔ mgmt" \
    --src-ip 10.10.0.0/16 --dst-ip 192.168.100.0/24 \
    --priority HIGH
```

### 3. Compliance baseline (Predefined)
*"Monitor BGP neighbor adjacency network-wide"*

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-intent-check/scripts/create_check.py" --network-id NET_xyz --type Predefined \
    --name "BGP adjacency check" \
    --predefined-type BGP_NEIGHBOR_ADJACENCY \
    --priority MEDIUM
```

### 4. Custom policy (NQE)
*"Alert if any device has SNMP v1/v2 enabled"*

```bash
# First, create the NQE query (via forward-nqe-query skill)
# Then reference it:
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-intent-check/scripts/create_check.py" --network-id NET_xyz --type NQE \
    --name "SNMPv3 enforcement" \
    --query-id FQ_... \
    --priority HIGH
```

## Integration with other skills

### Critical Workflow: Analyzing Failing Checks

**When ANY check shows FAIL status, you MUST immediately trace the path using forward-path-analysis to identify the root cause.**

```bash
# 1. Find failing checks
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-intent-check/scripts/list_checks.py" \
    --network-id NET_xyz --snapshot-id <id> | jq '.checks[] | select(.status == "FAIL")'

# 2. For EACH failing check, extract filters and trace path
# Example: branch-portal-la-br-to-lon-dmz shows FAIL
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-path-analysis/scripts/search_path.py" \
    --network-id NET_xyz --snapshot-id <id> \
    --from la-br-ce \
    --dst-ip 172.16.2.39 \
    --ip-proto tcp --dst-port 8080

# 3. Analyze the forwardingOutcome
#    - BLACKHOLE → Check "last hop" device and diagnosis (no route, ACL drop, etc.)
#    - DROPPED → Identify which device/ACL dropped it
#    - UNREACHABLE → Check routing or next-hop resolution
#    - Zero paths → Source or destination doesn't exist in model
```

**Common Failure Patterns:**

| forwardingOutcome | Root Cause | Next Step |
|---|---|---|
| **BLACKHOLE** at device X | No route in routing table for destination | SSH to device X, check `show ip route vrf <vrf>` |
| **DROPPED** by ACL | ACL explicitly denying traffic | Get device config, review ACL rules |
| **UNREACHABLE** | Next-hop not reachable | Check IGP/BGP convergence, MPLS LSP state |
| **Zero paths** | Source/dest not in Forward model | Verify device exists, check collection status |
| **Multiple outcomes** | ECMP with some paths failing | Compare working vs failing paths |
| **DELIVERED to DIRECT route** | Testing infrastructure IP, not service IP | Check network docs for actual service IP behind firewall/LB |

**Example from real validation:**

```
Check: branch-portal-la-br-to-lon-dmz (FAIL)
Path trace shows: BLACKHOLE at la-br-ce
Diagnosis: "traffic doesn't match any IP routes in the corresponding VRF table"
→ Root cause: la-br-ce missing route to 172.16.2.0/24 in corporate VRF
→ Action: Check BGP VPNv4 route advertisements from LON PE
```

**Example of DIRECT route false positive:**

```
Check: branch-portal-fra-br-to-lon-dmz (PASS but misleading)
Destination: 172.16.2.39 (lon-fw-dmz interface IP)
Path trace shows: DELIVERED
Final hop: Device lon-fw-dmz, Route 172.16.2.39, Route type DIRECT
→ Problem: Only tests reach-firewall, not reach-service
→ Fix: Change destination to 172.16.2.37 (lon-svc-host actual service)
→ Result: Now tests true end-to-end connectivity
```

**How to spot DIRECT route issues in path traces:**
1. Look for `Route type: DIRECT` or `Action: receive` in final hop
2. Check if final device is infrastructure (firewall, router, LB) vs service host
3. Verify destination IP matches service diagrams, not device management IPs

### Standard Workflow Patterns

| Workflow | Chain |
|---|---|
| **Investigate failing check** | `list_checks.py` → identify FAIL → **immediately trace with forward-path-analysis** → analyze outcome → SSH verify if needed → propose fix |
| Create check from path analysis | `forward-path-analysis` to validate behavior → `create_check.py` to codify as check |
| Validate a proposed change | `forward-predict` to simulate change → `forward-path-analysis` with `--changeset` → if passing, `create_check.py` to prevent regression |
| Bulk check creation | Write JSON file with multiple check definitions → create checks in a loop (future: bulk API) |

## Best Practices

### Always use `--flow-types VALID` for production checks

**Problem**: By default, Forward evaluates ALL flow types including BLACKHOLE, DROPPED, UNREACHABLE, etc. This causes checks to fail even when valid paths exist, creating noise and false positives.

**Solution**: Always add `--flow-types VALID` to filter checks to only valid forwarding paths:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-intent-check/scripts/create_check.py" \
    --network-id NET_xyz --type Existential \
    --name "App → DB connectivity" \
    --src-ip 10.1.2.3 --dst-ip 10.5.0.10 \
    --flow-types VALID  # ← Always include this
```

**Impact**:
- **Existential checks** PASS only if ≥1 VALID path exists (ignores blackhole/dropped paths)
- **Isolation checks** PASS only if zero VALID paths exist (ignores invalid paths trying to breach isolation)
- Eliminates false positives from modeling gaps or secondary paths
- Check failures now indicate **real network issues** requiring investigation

**Example**: Without `--flow-types VALID`, an Existential check might FAIL showing "BLACKHOLE at device X" even though a valid path exists through device Y. With the filter, the check correctly PASSes because a valid path exists.

### Use device names for branch/CE sources

**Problem**: Branch CE devices often don't have loopback IPs, or the loopback isn't the right test point for application connectivity.

**Solution**: Use device names instead of IPs for `--src-ip` and `--dst-ip`. Forward resolves device names to DeviceFilter and tests from the device's actual location:

```bash
# ❌ BAD: Using non-existent IP
--src-ip 10.0.0.32  # LA PE loopback (doesn't exist or wrong test point)

# ✅ GOOD: Using device name
--src-ip la-br-ce   # Forward resolves to device and tests actual connectivity
```

**When to use**:
- Branch CE connectivity tests
- Inter-device reachability (CE ↔ CE)
- When source has no loopback or client subnet is unknown
- Migration testing (plane-specific PE as egress sentinel)

### Target service IPs, not intermediate device IPs

**CRITICAL**: When testing connectivity to services behind firewalls/load balancers, always use the **actual service IP**, not intermediate infrastructure IPs.

**Problem**: Testing connectivity to a firewall's own interface IP validates only that the packet reaches the firewall, not that it can reach the service behind it.

**Real-world example** (bank-global network):
```bash
# ❌ WRONG: Testing firewall interface (DIRECT route)
--dst-ip 172.16.2.39  # lon-fw-dmz interface IP
# Result: Tests only reach-firewall, not reach-service

# ✅ CORRECT: Testing actual service
--dst-ip 172.16.2.37  # lon-svc-host service IP  
# Result: Tests true end-to-end connectivity
```

**How to identify**:
1. **DIRECT routes** in Forward path traces = device's own interface IP (not a service)
2. If path shows `forwardingOutcome: DELIVERED` but `Route type: DIRECT` at destination, you're testing the wrong IP
3. Check network diagrams/docs for actual service IPs vs infrastructure IPs

**Impact**:
- Wrong: Check shows PASS but service is actually unreachable (false positive)
- Wrong: Check shows FAIL due to testing infrastructure IP instead of service (misleading diagnosis)
- Correct: Check validates actual end-to-end application connectivity

**When designing checks**:
- **Firewall DMZs**: Use service host IPs, not firewall interface IPs
- **Load balancers**: Use VIP or backend service IPs, not LB management IPs
- **NAT gateways**: Use post-NAT destination IPs (inside), not gateway IPs
- **Application tiers**: Use application server IPs, not gateway/router IPs

### Add descriptive notes and tags

**Always** include `--note` and `--tags` when creating checks:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-intent-check/scripts/create_check.py" \
    --network-id NET_xyz --type Existential \
    --name "LA-Branch-Portal" \
    --src-ip la-br-ce --dst-ip 172.16.2.39 \
    --ip-proto tcp --dst-port 8080 \
    --note "✅ LA branch CE can access LON DMZ web portal. Corporate VRF trans-PoP connectivity." \
    --tags validated --tags branch-connectivity \
    --flow-types VALID
```

**Note best practices**:
- Start with ✅/⚠️/❌ status indicator
- Explain what the check validates (not just what traffic)
- Include VRF context if relevant
- Document known issues or caveats

**Tag categories**:
- `validated` - Check confirmed working via multiple methods
- `network-issue` - Real connectivity problem requiring fix
- `forward-bug` - Forward modeling gap (network operational, monitoring unreliable)
- `acl-design` - Expected behavior based on ACL design
- VRF/category tags: `payments-vrf`, `corporate-vrf`, `pci-dss`, `branch-connectivity`, `firewall-acl`

### Validate checks after creation

After creating critical checks, verify they work as expected:

```bash
# 1. Create check
python3 create_check.py --network-id NET_xyz --type Existential \
    --name "Critical-App-Path" --src-ip app-server --dst-ip db-server \
    --flow-types VALID --tags critical

# 2. Get check status
python3 get_check.py --network-id NET_xyz --check-id <id>

# 3. If FAIL, trace the path to understand why
python3 ../forward-path-analysis/scripts/search_path.py \
    --network-id NET_xyz --src-ip app-server --dst-ip db-server
```

If check FAILs but you expect it to PASS:
1. Verify source/destination exist in Forward's model
2. Check if using device names instead of IPs helps
3. Trace path with forward-path-analysis to see actual forwarding
4. Verify with SSH/ping if Forward shows unexpected results
5. Consider Forward modeling gap vs real network issue

## Reference documentation

- `references/check-types.md` — deep dive on each check type and when to use it
- `references/location-filters.md` — ingress/egress device pins; turning a delivery check into a plane/path sentinel
