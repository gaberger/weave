---
name: forward-device-intel
description: Shortcuts for common device-level state queries — device info, ARP, interface status, BGP peerings. Use when the user asks "show me the ARP table", "what interfaces are up on device X", "list BGP peers", "get device hardware info". Not for arbitrary NQE queries (use forward-nqe-query), device inventory (use forward-inventory), or reachability tracing (use forward-path-analysis).
allowed-tools: Bash(python3 *), Read
---

# Forward Device Intel

> **Read first:** `${CLAUDE_PLUGIN_ROOT}/shared/expertise/forward-as-backend.md` — the foundational framing. Forward is the *data substrate*; this skill is the parsed-state projection (ARP, interfaces, BGP peers, routes). When the user says "show me the ARP table" / "what BGP peers are up" / "interface status", default to calling this skill against the pinned snapshot, not to asking the user to specify the snapshot id.

## Operate as a network engineer

Device-state results (ARP, interfaces, BGP peers, routes) are usually evidence inside a larger investigation, not an end in themselves. Before fetching state in isolation:

- For multi-step asks (config-mismatch, policy-violation, reachability-failure), **read `${CLAUDE_PLUGIN_ROOT}/shared/expertise/investigation-workflows.md` first** to plan the right chain. State is most useful when paired with config (`forward-device-config`) and traffic-flow (`forward-path-analysis`).
- When *interpreting* state — what BGP states (Idle/Active/OpenSent/Established) actually mean, what counter patterns indicate, vendor-specific routing preferences, when a "down" interface is admin-down vs proto-down vs err-disabled — read `${CLAUDE_PLUGIN_ROOT}/shared/expertise/config-syntax.md` for the routing-protocol + best-practice background.

---

Curated shortcuts for the most common device-level queries. Each script:

1. Resolves a catalog entry by path hint (bundled catalog, offline).
2. Runs the query against a snapshot via `POST /api/nqe`.
3. Emits the result as JSON, optionally filtered to a single device client-side.

This skill is a **shortcut layer** over `forward-nqe-query`. For anything not covered here — routes, ACLs, config diffs, vendor-specific state — use `forward-nqe-query` directly.

## Invocation

Run from the user's cwd so the scripts auto-load `.env`. Do NOT `source .env` or export creds manually. Do not narrate which script you're about to run.

```bash
# Device hardware info
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-intel/scripts/get_device_info.py" \
    --network-id NET_xyz

# ARP table for a specific device
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-intel/scripts/get_arp.py" \
    --network-id NET_xyz --device-name core-rtr-01

# BGP peers network-wide
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-intel/scripts/get_bgp_peers.py" \
    --network-id NET_xyz --limit 500

# Interface status
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-intel/scripts/get_interfaces.py" \
    --network-id NET_xyz --limit 500
```

## Output format

Never paste raw JSON. Lead with a verdict, not a dump.

The server's column set varies by query — emit whatever columns came back, but condense.

### Default shape (any script, no `--device-name`)

```markdown
**<N> rows** (network `<name>`, snapshot `<id>`)

Group rows by device. Show at most 8 devices unless the user asked for all. For each:

> **<hostname>** · <platform> <model>
>
> | <relevant columns, truncated to ≤5> |

If more than 8 devices match, append: `...and <k> more devices (say "all devices" to expand)`.
```

### With `--device-name` filter

```markdown
**<hostname>** · <platform> <model>

| <all server columns, full-width> |

No grouping needed — it's one device.
```

If `--device-name` produces zero rows, say: "No rows found for device `<name>` in snapshot `<id>`. Confirm the device name with `forward-inventory` or broaden the filter."

### Script-specific hints

- `get_device_info.py` → one row per device; render as a single table: `device | vendor | model | osVersion`.
- `get_interfaces.py` → include admin/oper state columns; if > 50 rows, bucket by `operStatus` (up / down / admin-down) and show counts, offering to expand one bucket.
- `get_arp.py` → columns vary but usually include MAC + IP + interface. Sort by device then IP.
- `get_bgp_peers.py` → flag any row where state ≠ `Established` with a ⚠ prefix; list those first.

### Next-step hints

When closing, phrase suggestions as user prompts — never raw commands. Examples:
- *"To see the NQE query behind this, ask: **Show me the source for `<catalog-path>`.**"* (handled by `forward-nqe-query`)
- *"For custom filtering, ask: **Run NQE query `<FQ_id>` with parameter `<k>`=`<v>`.**"* (handled by `forward-nqe-query`)
- *"To check reachability for a device you see here, ask: **Can `<host>` reach `<dst>`?**"* (handled by `forward-path-analysis`)

## When to use

- "Show me the ARP table"
- "What interfaces are up on device X?"
- "List BGP peers for router Y"
- "Get device hardware info / model / OS version"
- "Which BGP sessions are not Established?"
- "What's the interface speed on core-rtr-01?"

## When NOT to use

- Routes, VRF-scoped queries, or anything not on the shortcut list above → `forward-nqe-query`
- Compliance / STIG checks → `forward-compliance-check`
- Tracing whether traffic can flow → `forward-path-analysis`
- Listing the devices themselves (not their internal state) → `forward-inventory`

## Scripts

| Script | Purpose |
|---|---|
| `get_device_info.py` | Platform, OS version, model for all devices |
| `get_interfaces.py` | Interface admin/oper state, speed, description |
| `get_arp.py` | MAC/IP bindings (ARP tables) across the network |
| `get_bgp_peers.py` | BGP session state per device |

### `get_device_info.py`

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-intel/scripts/get_device_info.py" \
    --network-id NET_xyz
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network ID |
| `--snapshot-id` | no | Defaults to latest processed snapshot |
| `--device-name` | no | Client-side filter; keeps rows matching this device name |
| `--limit` | no | Server-side row limit (default 1000; 0 = no limit) |

### `get_interfaces.py`

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-intel/scripts/get_interfaces.py" \
    --network-id NET_xyz --device-name core-rtr-01
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network ID |
| `--snapshot-id` | no | Defaults to latest processed snapshot |
| `--device-name` | no | Client-side filter; keeps rows matching this device name |
| `--limit` | no | Server-side row limit (default 1000; 0 = no limit) |

### `get_arp.py`

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-intel/scripts/get_arp.py" \
    --network-id NET_xyz --device-name core-rtr-01
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network ID |
| `--snapshot-id` | no | Defaults to latest processed snapshot |
| `--device-name` | no | Client-side filter; keeps rows matching this device name |
| `--limit` | no | Server-side row limit (default 1000; 0 = no limit) |

### `get_bgp_peers.py`

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-intel/scripts/get_bgp_peers.py" \
    --network-id NET_xyz --limit 500
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network ID |
| `--snapshot-id` | no | Defaults to latest processed snapshot |
| `--device-name` | no | Client-side filter; keeps rows matching this device name |
| `--limit` | no | Server-side row limit (default 1000; 0 = no limit) |

## Gotchas

- **Client-side device filter**: `--device-name` filters after the server returns results. The server query still runs across all devices in the snapshot. For very large networks this can be slow; tighten `--limit` or use `forward-nqe-query` with a server-side parameter if the specific catalog query accepts one (inspect with `get_query_source.py`).
- **Columns are query-defined**: `get_interfaces.py`'s output columns depend on what `/Interfaces/Interface Status Query` returns. Inspect its source (`get_query_source.py`) before assuming specific field names.
- **Not all devices populate every field**: BGP queries only return peer rows for devices that run BGP; ARP queries only include devices that maintain ARP tables (L3 gear). Empty result for a given device doesn't mean the device is missing from the snapshot.
