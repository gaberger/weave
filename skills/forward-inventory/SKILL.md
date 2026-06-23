---
name: forward-inventory
description: List Forward Networks resources — networks, snapshots, devices, locations. Use when the user asks "what networks do we have", "list snapshots for X", "show devices in Y", "how many devices are in network Z". Not for querying device state (use forward-nqe-query) or running path searches (use forward-path-analysis).
allowed-tools: Bash(python3 *), Read
---

# Forward Inventory

> **Read first:** `${CLAUDE_PLUGIN_ROOT}/shared/expertise/forward-as-backend.md` — the foundational framing. Forward is the *data substrate* for every question about the user's network; the skills are the query API; you are the brain on top. When the user asks "what networks / snapshots / devices do we have", that's a substrate query (call this skill), not a meta-question about installed plugin scripts.

## Operate as a network engineer

Inventory is almost always step 0 of an investigation — pin the right network and snapshot before doing anything else. For multi-step asks (config-mismatch, policy-violation, reachability-failure), read `${CLAUDE_PLUGIN_ROOT}/shared/expertise/investigation-workflows.md` after this skill returns, to plan the chain.

---

Lists the core resource types in Forward Enterprise: networks, snapshots, devices, locations.

## Invocation

Run from the user's cwd so the scripts auto-load `.env`. Do NOT `source .env` or export creds manually — the scripts handle it. Do not narrate which script you're about to run.

```bash
# Step-0 grounding (always run this first on a new session)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-inventory/scripts/forward_overview.py"

# Optional: limit how many snapshots per network are returned
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-inventory/scripts/forward_overview.py" \
    --max-snapshots-per-network 3

# List all networks (optionally filter by name)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-inventory/scripts/list_networks.py"
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-inventory/scripts/list_networks.py" --name "production"

# List snapshots for a network
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-inventory/scripts/list_snapshots.py" --network-id <id>
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-inventory/scripts/list_snapshots.py" --network-id <id> --latest

# List devices in a network
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-inventory/scripts/list_devices.py" --network-id <id>
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-inventory/scripts/list_devices.py" --network-id <id> --snapshot-id <snap-id> --limit 50 --vendor Cisco
```

## Output format

Never paste raw JSON. Lead with a verdict, not a dump.

### `forward_overview.py`

```markdown
**<N> network(s)** — defaults pinned: net=<id> snap=<id>

One line per network:
    <id>  <name>  (<snapshotCount> snapshots, latest processed <date>)

If defaults were pinned (single network / single processed snapshot), state them explicitly:
    Defaults: network <id>, snapshot <id>. Ready to proceed.

If multiple networks are present and no default was pinned:
    <N> networks found. Ask the user which network to use, or call list_networks.py to show names.

Zero-result: "No networks found in this Forward tenant. Check FORWARD_API_BASE_URL and credentials."

To drill into a specific network, ask: "List the latest snapshot for network <id>."
```

### `list_networks.py`

```markdown
**<N> networks** (orgId <orgId>)

Group by a sensible bucket (prefix, creator, parent, or a "production / scratch / auto-generated" split if obvious). Within each group, one per line:

    <id>  <name>

- If total > 25, show the top buckets in full and collapse the rest as: `...and <k> more (say "list all" to expand)`.
- Emit `creator` / `createdAt` only if the user asked.

Zero-result: "No networks found matching that name. Try without --name to list all networks."

To drill into one, ask: "List the latest snapshot for network <id>."
```

### `list_snapshots.py`

```markdown
**<N> snapshots** for network `<id>` (latest processed: `<snap-id>`, <age>)

Table:

| snapshot id | processed at | status | notes |

- Bold the latest-processed row.
- If `--latest` was used, just emit the one snapshot as a short list: id, processedAt, notes.

Zero-result: "No snapshots found for network <id>. The network may not have been collected yet."

To enumerate devices in this snapshot, ask: "List devices in network <id>."
```

### `list_devices.py`

```markdown
**<N> devices** (network `<name>`, snapshot `<id>`)

Table by vendor/model rollup:

| vendor | model | OS version | count |

Sort by count desc. If `--vendor` filter was used, name it in the header.

Zero-result: "No devices found. Check that --network-id and --snapshot-id are correct, or try without --vendor."

For ARP / BGP / interface state on a device, ask: "Show the ARP table for <hostname>." (handled by `forward-device-intel`)

To check reachability, ask: "Can <A> reach <B> in this network?" (handled by `forward-path-analysis`)
```

## When to use

- "What networks are available?"
- "Show me snapshots for network X"
- "List devices in the production network"
- "Which locations has $network been grouped into?"
- "How many devices are in network Z?"

## When NOT to use

- Running NQE queries → `forward-nqe-query`
- Device-specific config / ARP / routes → `forward-device-intel`
- Tracing flows or checking reachability → `forward-path-analysis`

## Scripts

| Script | Purpose |
|---|---|
| `forward_overview.py` | Step-0 grounding — returns networks, snapshot counts, and inferred defaults |
| `list_networks.py` | List all networks, optionally filtered by name |
| `list_snapshots.py` | List snapshots for a network; `--latest` returns only the latest processed |
| `list_devices.py` | List devices in a network snapshot, with optional vendor filter and row cap |

### `forward_overview.py`

```bash
# Step-0 grounding (no required args)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-inventory/scripts/forward_overview.py"

# Summarize up to 3 recent snapshots per network
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-inventory/scripts/forward_overview.py" \
    --max-snapshots-per-network 3
```

| Flag | Required | Notes |
|---|---|---|
| `--max-snapshots-per-network` | no | How many recent snapshots to summarize per network (default: 1) |

### `list_networks.py`

```bash
# List all networks
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-inventory/scripts/list_networks.py"

# Filter by exact name
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-inventory/scripts/list_networks.py" --name "production"
```

| Flag | Required | Notes |
|---|---|---|
| `--name` | no | Filter by exact name via `GET /api/networks?name=` |

### `list_snapshots.py`

```bash
# List all snapshots for a network
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-inventory/scripts/list_snapshots.py" --network-id NET_xyz

# Get only the latest processed snapshot
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-inventory/scripts/list_snapshots.py" --network-id NET_xyz --latest
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Network ID from `list_networks.py` or `forward_overview.py` |
| `--latest` | no | Return only the latest processed snapshot (`/snapshots/latestProcessed`) |

### `list_devices.py`

```bash
# List all devices in a network (latest snapshot)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-inventory/scripts/list_devices.py" --network-id NET_xyz

# Cap output and filter by vendor
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-inventory/scripts/list_devices.py" \
    --network-id NET_xyz --snapshot-id SNAP_abc --limit 50 --vendor Cisco
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Network ID from `list_networks.py` or `forward_overview.py` |
| `--snapshot-id` | no | Snapshot ID (defaults to latest processed) |
| `--limit` | no | Cap the number of devices returned (0 = no cap, default: 0) |
| `--vendor` | no | Filter by vendor name (case-insensitive, client-side string match) |

## Gotchas

- `list_devices.py` on a large network can return thousands of rows. Use `--limit` unless the user actually wants the full list.
- Snapshot IDs rotate — don't cache them across sessions. Look up the latest when starting a new task.
- Device counts in `list_networks.py` reflect the **latest processed** snapshot; they can lag a live collection.
- Path search and NQE run against a specific snapshot; if the user's question is time-sensitive, pass the snapshot ID explicitly rather than relying on "latest".
