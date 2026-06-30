---
name: forward-device-tag
description: Manage device tags for categorization, filtering, and visualization. Use when the user asks "tag all vulnerable devices", "mark devices that failed STIG checks", "create a tag for internet-facing devices", "show me devices tagged CRITICAL", "bulk tag devices from this NQE query". Tags are metadata that persist across snapshots and can be used in NQE queries, vulnerability filters, diagram coloring, and workflow scoping. Not for device discovery (use forward-inventory), device configuration (use forward-device-config), or querying which devices have a given property (use forward-nqe-query).
allowed-tools: Bash(python3 *), Read
---

# Forward Device Tag Management

> **Read first:** `${CLAUDE_PLUGIN_ROOT}/shared/expertise/forward-as-backend.md` — the foundational framing. Device tags are the substrate's *metadata layer* — user-defined labels that persist across snapshots and integrate with every other Forward workflow. When the user says "tag these devices" / "mark violators" / "categorize by risk", default to this skill — *don't* try to maintain external tracking systems.

## Operate as a network engineer

Tags are how operators bring human context into the modeled network. A CVE scan returns 50 vulnerable devices — tagging them as "CVE-2024-HIGH" lets you filter views, scope remediation, track progress, and visualize risk in diagrams. Before single-shotting tag operations:

- Read `${CLAUDE_PLUGIN_ROOT}/shared/expertise/investigation-workflows.md` (Workflow 5 — *Metadata management*) for the recommended chain: identify devices (via NQE / vulnerability / compliance) → bulk tag → use tags to scope follow-up work → remove tags when remediated.
- Tags integrate with other skills: `forward-vulnerability` can filter by tag, `forward-nqe-query` can query by tag, `forward-intent-check` can scope checks by tag, diagram views highlight tagged devices by color.

---

Forward's device tagging system allows you to attach metadata labels to devices and endpoints. Tags are:
- **User-defined**: create any tag names you need (case-insensitive)
- **Persistent**: tags survive across snapshots until explicitly removed
- **Colorable**: assign RGB hex colors for diagram visualization
- **Filterable**: use tags in NQE queries, vulnerability scans, and API filters
- **Bulk-operable**: add/remove tags for multiple devices at once

## Invocation

Run from the user's cwd so the scripts auto-load `.env`. Do NOT `source .env` or export creds manually. Do not narrate which script you're about to run.

```bash
# List all tags (with device counts)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/list_tags.py" \
    --network-id <id>

# Get a specific tag with its devices
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/get_tag.py" \
    --network-id <id> --tag-name "VULNERABLE"

# Create a new tag
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/create_tag.py" \
    --network-id <id> --tag-name "HIGH-PRIORITY" --color "#ff0000"

# Add tag to devices (bulk)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/tag_devices.py" \
    --network-id <id> --tag-name "VULNERABLE" \
    --devices rtr-01 rtr-02 sw-05

# Remove tag from devices
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/untag_devices.py" \
    --network-id <id> --tag-name "VULNERABLE" \
    --devices rtr-01

# Tag devices from NQE query results
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/tag_from_query.py" \
    --network-id <id> --query-id FQ_vulnerable_devices \
    --tag-name "CVE-2024-HIGH" --device-column deviceName

# Rename a tag or change its color
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/update_tag.py" \
    --network-id <id> --tag-name "OLD-NAME" --new-name "NEW-NAME"

# Delete a tag (removes from all devices in all snapshots — irreversible)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/delete_tag.py" \
    --network-id <id> --tag-name "DEPRECATED-TAG"
```

## Output format

Every script emits one JSON envelope on stdout:

- success: `{"ok": true, "schema": 1, "data": <payload>, "meta": {...}}` — read the answer from `data`; counts and echoed params (`network_id`, `tag_name`, `device_count`, `snapshot_id`, …) live in `meta`.
- failure: `{"ok": false, "schema": 1, "error": {"code", "message", "hint?"}}` — non-zero exit. Codes: `NOT_FOUND` (network/snapshot missing), `API` (upstream call failed), `INPUT` (bad/missing args), `EMPTY` (query produced no devices to tag).

Never paste raw JSON. Lead with a verdict, not a dump.

### `list_tags.py`

```markdown
**<N> tags** (<M> devices tagged)

Sort by device count desc, then alphabetically.

| Tag | Devices | Color |

Truncate to 20 tags; if more, append: `(20 of <N>; use --tag-name filter to narrow)`.

If no tags exist: "**No tags defined.** Create tags to categorize devices for filtering, visualization, and workflow scoping."

Close with next step:
- *"To see which devices have a specific tag, ask: **Show me devices tagged &lt;tag-name&gt;.**"*
- *"To create a new tag, ask: **Create tag &lt;name&gt; with color &lt;hex&gt;.**"*
```

### `get_tag.py`

```markdown
**Tag: <name>** · <N> devices · <color hex>

| Device |

Truncate to 50 devices; if more, append: `(50 of <N>; full list available via API)`.

If tag has zero devices: "**Tag exists but no devices are tagged.** Use this tag to categorize devices as you identify them."

Suggest next steps:
- *"To add more devices, ask: **Tag devices X, Y, Z as &lt;tag-name&gt;.**"*
- *"To run a vulnerability scan on these devices only, ask: **Check vulnerabilities for tag &lt;tag-name&gt;.**"*
```

### `create_tag.py`

```markdown
**Tag created** · `<name>` · <color>

This tag can now be applied to devices. It will appear in diagram views with the specified color.

Next steps:
- *"To tag devices, ask: **Tag devices X, Y, Z as &lt;tag-name&gt;.**"*
- *"To bulk tag from a query, ask: **Tag all devices from query &lt;FQ_...&gt; as &lt;tag-name&gt;.**"*
```

### `tag_devices.py` / `untag_devices.py`

```markdown
**<N> devices tagged** with `<tag-name>`
or
**<N> devices untagged** from `<tag-name>`

- Applied to: <device1>, <device2>, <device3>...

(Truncate device list to 10; if more, say "...and <K> more")

Changes take effect in snapshot <snapshotId> and all future snapshots.

Next steps:
- *"To verify, ask: **Show me devices tagged &lt;tag-name&gt;.**"*
- *"To scope a vulnerability scan to these devices, ask: **Check vulnerabilities for tag &lt;tag-name&gt;.**"*
```

### `tag_from_query.py`

```markdown
**<N> devices tagged** from query results

- Query: `<queryId>`
- Tag: `<tag-name>`
- Device column: `<columnName>`

Tagged devices: <device1>, <device2>, <device3>...

(Truncate to 10; if more, say "...and <K> more")

If the query returns zero rows: "**Query returned no results.** No devices were tagged. Verify the query ID and parameters, or run the query directly to inspect results."

Next steps:
- *"To see the full list, ask: **Show me devices tagged &lt;tag-name&gt;.**"*
- *"To scope remediation work to these devices, use the tag in vulnerability/compliance filters."*
```

### `update_tag.py`

```markdown
**Tag updated** · `<old-name>` → `<new-name>` · <new-color>

(Omit the arrow if only color changed; omit the color if only name changed.)

All devices that had the old tag now have the updated tag. Future snapshots will reflect the new name/color.

Next steps:
- *"To see the updated tag's devices, ask: **Show me devices tagged &lt;new-name&gt;.**"*
- *"To apply this tag to more devices, ask: **Tag devices X, Y, Z as &lt;new-name&gt;.**"*
```

### `delete_tag.py`

```markdown
**Tag deleted** · `<tag-name>`

This tag has been removed from all devices in all snapshots. This action is irreversible.

If the tag did not exist: "**Tag not found.** No action taken."

Next steps:
- *"To see remaining tags, ask: **List all tags.**"*
- *"To re-create a tag with the same name, ask: **Create tag &lt;name&gt; with color &lt;hex&gt;.**"*
```

## When to use

- "Tag all vulnerable devices with HIGH-PRIORITY"
- "Mark devices that failed STIG checks"
- "Create a tag for internet-facing devices"
- "Bulk tag devices from this NQE query"
- "Show me devices tagged CRITICAL"
- "Remove tag from devices that are now patched"
- "Color-code devices by location in diagrams"

## When NOT to use

- Device discovery ("what devices exist?") → `forward-inventory`
- Device configuration ("what's the config?") → `forward-device-config`
- Device queries ("which devices have X?") → `forward-nqe-query`
- One-time filtering without persistent metadata → query directly, don't create tags

## Scripts

| Script | Purpose |
|---|---|
| `list_tags.py` | List all tags with device counts |
| `get_tag.py` | Get a specific tag with its devices |
| `create_tag.py` | Create a new tag (with optional color) |
| `update_tag.py` | Update tag name or color |
| `delete_tag.py` | Delete a tag (removes from all devices) |
| `tag_devices.py` | Add a tag to devices (bulk) |
| `untag_devices.py` | Remove a tag from devices (bulk) |
| `tag_from_query.py` | Bulk tag devices from NQE query results |

### list_tags.py

```bash
# All tags with device counts
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/list_tags.py" --network-id NET_xyz

# With device names (more verbose)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/list_tags.py" --network-id NET_xyz --with-devices

# Filter to tags as of a specific snapshot
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/list_tags.py" \
    --network-id NET_xyz --snapshot-id <id> --with-devices
```

Arguments:

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Target network |
| `--with-devices` | no | Include device names in output |
| `--snapshot-id` | no | Show tags as of a specific snapshot (default: current state) |

### get_tag.py

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/get_tag.py" \
    --network-id NET_xyz --tag-name "VULNERABLE"
```

Returns a specific tag with the list of devices that have it.

Arguments:

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Target network |
| `--tag-name` | yes | Tag name (case-insensitive) |
| `--snapshot-id` | no | Show tag as of a specific snapshot |

### create_tag.py

```bash
# Create tag with color
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/create_tag.py" \
    --network-id NET_xyz --tag-name "HIGH-PRIORITY" --color "#ff0000"

# Create tag without color
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/create_tag.py" \
    --network-id NET_xyz --tag-name "REMEDIATION"
```

Arguments:

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Target network |
| `--tag-name` | yes | Tag name (case-insensitive, may include spaces) |
| `--color` | no | RGB hex color for diagram visualization (e.g., `#ff0000`) |

### update_tag.py

```bash
# Rename a tag
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/update_tag.py" \
    --network-id NET_xyz --tag-name "OLD-NAME" --new-name "NEW-NAME"

# Change color
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/update_tag.py" \
    --network-id NET_xyz --tag-name "CRITICAL" --color "#ff0000"

# Both rename and recolor
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/update_tag.py" \
    --network-id NET_xyz --tag-name "OLD-NAME" --new-name "NEW-NAME" --color "#00ff00"
```

Arguments:

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Target network |
| `--tag-name` | yes | Current tag name |
| `--new-name` | no | New tag name (to rename) |
| `--color` | no | New color |

### delete_tag.py

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/delete_tag.py" \
    --network-id NET_xyz --tag-name "OLD-TAG"
```

**Warning:** This removes the tag from ALL devices in ALL snapshots. Irreversible.

Arguments:

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Target network |
| `--tag-name` | yes | Tag to delete |

### tag_devices.py

```bash
# Tag specific devices
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/tag_devices.py" \
    --network-id NET_xyz --tag-name "VULNERABLE" \
    --devices rtr-01 rtr-02 sw-05

# Tag devices from a file (one per line)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/tag_devices.py" \
    --network-id NET_xyz --tag-name "CRITICAL" \
    --devices-file ./vulnerable-devices.txt

# Apply to a specific snapshot (default: next snapshot)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/tag_devices.py" \
    --network-id NET_xyz --tag-name "REMEDIATED" \
    --devices rtr-01 --snapshot-id <id>
```

Arguments:

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Target network |
| `--tag-name` | yes | Tag to apply |
| `--devices` | conditional | Device names (space-separated) |
| `--devices-file` | conditional | File with device names (one per line) |
| `--snapshot-id` | no | Snapshot to apply to (default: next snapshot) |
| `--no-validate` | no | Skip device name validation |

### untag_devices.py

```bash
# Remove tag from specific devices
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/untag_devices.py" \
    --network-id NET_xyz --tag-name "VULNERABLE" \
    --devices rtr-01 rtr-02

# Remove all tags from devices
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/untag_devices.py" \
    --network-id NET_xyz --remove-all \
    --devices rtr-01 rtr-02
```

Arguments:

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Target network |
| `--tag-name` | conditional | Tag to remove (unless `--remove-all`) |
| `--devices` | conditional | Device names (space-separated) |
| `--devices-file` | conditional | File with device names (one per line) |
| `--remove-all` | no | Remove ALL tags from devices |
| `--snapshot-id` | no | Snapshot to apply to (default: next snapshot) |

### tag_from_query.py

**Bulk tagging workflow**: run an NQE query, extract device names from results, apply tag.

```bash
# Tag devices from query results
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/tag_from_query.py" \
    --network-id NET_xyz --query-id FQ_vulnerable_devices \
    --tag-name "CVE-2024-HIGH" --device-column deviceName

# With query parameters
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/tag_from_query.py" \
    --network-id NET_xyz --query-id FQ_custom_query \
    --tag-name "LOCATION-NYC" --device-column device \
    --params '{"location": "nyc"}'

# Create tag if it doesn't exist
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/tag_from_query.py" \
    --network-id NET_xyz --query-id FQ_vulnerable_devices \
    --tag-name "NEW-TAG" --device-column deviceName \
    --create-tag --color "#ff0000"
```

Arguments:

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Target network |
| `--query-id` | yes | NQE query ID (FQ_...) |
| `--tag-name` | yes | Tag to apply |
| `--device-column` | yes | Column name containing device names |
| `--snapshot-id` | no | Snapshot to query against (default: latest) |
| `--params` | no | JSON string of query parameters |
| `--create-tag` | no | Create tag if it doesn't exist |
| `--color` | no | Color for newly created tag |
| `--limit` | no | Max rows to process (default: 1000) |

**How it works:**
1. Runs the NQE query
2. Extracts device names from the specified column
3. Bulk tags those devices

**Common pattern:** vulnerability scan → tag affected devices → scope remediation by tag

## Gotchas

- **Case-insensitive**: tag names "CRITICAL", "Critical", and "critical" are the same tag
- **Snapshot timing**: tags applied "to next snapshot" take effect after the next collection. To apply to a specific snapshot, use `--snapshot-id`.
- **Device validation**: by default, scripts validate that device names exist. Use `--no-validate` to skip (useful for endpoints or future devices).
- **Tag persistence**: tags persist across snapshots until explicitly removed. If you tag a device, it stays tagged even after configs change.
- **Color format**: colors must be RGB hex with `#` prefix (e.g., `#ff0000` for red, `#0064a0` for blue)
- **Bulk operations are atomic**: if one device name is invalid, the entire operation fails (unless `--no-validate`)
- **Deletion is permanent**: `delete_tag.py` removes the tag from all devices in all snapshots — irreversible
- **Tag names can include spaces**: "High Priority" is valid, but quoting is required in shell: `--tag-name "High Priority"`

## Key concepts

### Tags vs. Device Groups

| Aspect | Tags | Device Groups (Aliases) |
|---|---|---|
| Purpose | Metadata for filtering/visualization | Named groups for NQE/path queries |
| Persistence | Persistent across snapshots | Persistent (in NQE context) |
| Mutability | Can add/remove devices easily | Typically static definitions |
| Visualization | Color-coded in diagrams | Not visualized |
| Use case | Dynamic categorization | Static grouping |

**When to use tags:** dynamic metadata that changes as you identify issues, remediate, or categorize devices.

**When to use device groups:** static groupings like "NYC routers", "edge firewalls", "core switches" that rarely change.

### Snapshot scoping

Tags can be applied to:
1. **Current snapshot + all future** (default) — tag persists forward
2. **Specific snapshot + all future** (`--snapshot-id X`) — tag starts at snapshot X
3. **Collection sources** (no `--snapshot-id`) — tag applies to devices in the next collected snapshot

**Default behavior:** tags applied without `--snapshot-id` take effect on the next snapshot and propagate forward.

**Historical tagging:** you can tag devices retroactively by specifying an old snapshot ID, but this is rare (usually for analysis).

### Tag colors and diagrams

Colors are RGB hex (e.g., `#ff0000` for red). They appear in:
- Network topology diagrams
- Device lists in the UI
- Visualization views

**Color best practices:**
- Red (`#ff0000`): critical, high-priority, vulnerable
- Orange (`#ff8800`): medium-priority, warning
- Yellow (`#ffff00`): low-priority, watch
- Green (`#00ff00`): compliant, remediated, verified
- Blue (`#0064a0`): informational, location-based
- Gray (`#808080`): disabled, archived, decommissioned

## Common patterns

### Pattern 1: Tag vulnerable devices from CVE scan

```bash
# Step 1: Run vulnerability scan (forward-vulnerability skill)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-vulnerability/scripts/list_vulnerabilities.py" \
    --network-id NET_xyz --internet-addressable > vuln.json

# Step 2: Extract CRITICAL CVE device names (via jq or script)
# Assume extracted to vulnerable-devices.txt

# Step 3: Create tag
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/create_tag.py" \
    --network-id NET_xyz --tag-name "CVE-CRITICAL" --color "#ff0000"

# Step 4: Bulk tag devices
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/tag_devices.py" \
    --network-id NET_xyz --tag-name "CVE-CRITICAL" \
    --devices-file vulnerable-devices.txt
```

**Benefit:** Now you can scope all follow-up work (NQE queries, compliance checks, path analysis) to `tag=CVE-CRITICAL`.

### Pattern 2: Tag STIG violators from compliance scan

```bash
# Step 1: Run STIG sweep (forward-compliance-check skill)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-compliance-check/scripts/stig_sweep.py" \
    --network-id NET_xyz --vendor Cisco > stig-results.json

# Step 2: Extract failing devices from results

# Step 3: Create tag and bulk tag
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/create_tag.py" \
    --network-id NET_xyz --tag-name "STIG-FAIL" --color "#ff8800"
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/tag_from_query.py" \
    --network-id NET_xyz --query-id FQ_stig_control_12345 \
    --tag-name "STIG-FAIL" --device-column deviceName
```

**Benefit:** Track remediation progress by monitoring `tag=STIG-FAIL` device count over time.

### Pattern 3: Tag and untag as you remediate

```bash
# Tag vulnerable devices
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/tag_devices.py" \
    --network-id NET_xyz --tag-name "NEEDS-PATCHING" \
    --devices rtr-01 rtr-02 rtr-03

# After patching rtr-01
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/untag_devices.py" \
    --network-id NET_xyz --tag-name "NEEDS-PATCHING" --devices rtr-01

# Add to "patched" tag
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/tag_devices.py" \
    --network-id NET_xyz --tag-name "PATCHED" --devices rtr-01
```

**Benefit:** Visual progress tracking. Diagram shows shrinking red (NEEDS-PATCHING) and growing green (PATCHED).

### Pattern 4: Bulk tag from NQE query

```bash
# Tag all devices with SSH on non-standard port
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/tag_from_query.py" \
    --network-id NET_xyz --query-id FQ_ssh_non_standard \
    --tag-name "SSH-NON-STANDARD" --device-column device \
    --create-tag --color "#ffff00"
```

**Benefit:** Automatically tag policy violations as they're discovered. Re-run periodically to keep tags current.

### Pattern 5: Location-based tagging

```bash
# Tag all devices in NYC
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/tag_from_query.py" \
    --network-id NET_xyz --query-id FQ_devices_by_location \
    --params '{"location": "nyc"}' --tag-name "LOCATION-NYC" \
    --device-column deviceName --create-tag --color "#0064a0"

# Repeat for ATL, SFO, etc.
```

**Benefit:** Scope vulnerability scans, compliance checks, and intent checks by location using tags.

### Pattern 6: Priority-based remediation workflow

```bash
# Create priority tags
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/create_tag.py" \
    --network-id NET_xyz --tag-name "P0-CRITICAL" --color "#ff0000"
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/create_tag.py" \
    --network-id NET_xyz --tag-name "P1-HIGH" --color "#ff8800"
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/create_tag.py" \
    --network-id NET_xyz --tag-name "P2-MEDIUM" --color "#ffff00"

# Tag devices based on CVE severity and exposure
# (manual or scripted based on vulnerability scan results)

# Remediate P0 first
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/get_tag.py" \
    --network-id NET_xyz --tag-name "P0-CRITICAL"
# ... patch those devices ...

# Remove P0 tags as you patch
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/untag_devices.py" \
    --network-id NET_xyz --tag-name "P0-CRITICAL" --devices <patched>

# Move to P1
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-tag/scripts/get_tag.py" \
    --network-id NET_xyz --tag-name "P1-HIGH"
```

**Benefit:** Structured remediation with visual progress tracking.

## Integration with other skills

| Workflow | Chain |
|---|---|
| Vulnerability tracking | `forward-vulnerability` → identify devices → `tag_from_query.py` → scope follow-up scans by tag |
| Compliance tracking | `forward-compliance-check` → identify violators → `tag_devices.py` → monitor tag count over time |
| Intent check scoping | Create tag for critical devices → `forward-intent-check` with tag filter (future: API support) |
| NQE filtering | `forward-nqe-query` with `tag` parameter (e.g., `where device.tags contains "CRITICAL"`) |
| Change management | Tag devices before change → validate change → untag if successful, escalate if not |
| Diagram visualization | Tag devices by risk/location/function → view color-coded topology diagram |

## Reference documentation

- `references/tagging-strategies.md` — best practices for tag naming, color schemes, and workflows
