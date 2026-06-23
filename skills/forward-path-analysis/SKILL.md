---
name: forward-path-analysis
description: Trace traffic flow through a Forward-modeled network. Use when the user asks "can A reach B", "what's the path from X to Y", "show me paths that violate policy", "why is traffic dropped between these hosts". Not for inventorying devices (use forward-inventory) or introspecting device state (use forward-nqe-query).
allowed-tools: Bash(python3 *), Read
---

# Forward Path Analysis

> **Read first:** `${CLAUDE_PLUGIN_ROOT}/shared/expertise/forward-as-backend.md` — the foundational framing. Path-analysis is the substrate's *simulation* primitive — Forward replays a 5-tuple through the parsed model and tells you the path, hop-by-hop, plus drop reason. When the user asks any reachability question ("can A reach B", "why is this dropping", "show me the path"), default to calling this skill — *don't* try to answer from configs alone.

## Operate as a network engineer

Path-analysis is the centerpiece of any reachability investigation, but the path result is rarely the whole answer — when a packet drops, the operator wants to know *which device, which feature, which config line* caused it, and *what to change*. Before single-shotting a path query:

- Read `${CLAUDE_PLUGIN_ROOT}/shared/expertise/investigation-workflows.md` (Workflow 3 — *Reachability failure*) for the recommended chain: trace → branch on drop reason (ACL / no-route / zone-policy / NAT / uRPF / interface-down) → fetch the relevant config or device-state → propose a fix → optionally validate via `forward-predict` + re-trace with `--changeset`.
- When the drop reason points at vendor-specific behavior (Cisco ACL ordering, Junos firewall-filter, PAN-OS rule shadowing, FortiOS sequence numbers, NX-OS feature flags, BGP neighbor state), read `${CLAUDE_PLUGIN_ROOT}/shared/expertise/config-syntax.md` for the syntax + semantics needed to read the offending stanza correctly.

---

Forward simulates packets through the full parsed network model (ACLs, NAT, routing, security policies, NAT/PAT, ECMP) and returns every path a packet can take from source to destination — including paths that are dropped and paths that violate policy.

## Invocation

Run from the user's cwd so the scripts auto-load `.env`. Do NOT `source .env` or export creds manually. Do not narrate which script you're about to run.

```bash
# Single flow (against real snapshot)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-path-analysis/scripts/search_path.py" \
    --network-id <id> --src-ip 10.1.2.3 --dst-ip 10.5.0.10 \
    --ip-proto tcp --dst-port 443 --intent PREFER_DELIVERED

# Single flow (against Predict changeset for what-if analysis)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-path-analysis/scripts/search_path.py" \
    --network-id <id> --changeset-id CHG-123 \
    --src-ip 10.1.2.3 --dst-ip 10.5.0.10 \
    --ip-proto tcp --dst-port 443

# Bulk from JSON file
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-path-analysis/scripts/search_paths_bulk.py" \
    --network-id <id> --queries-file ./checks.json
```

## Output format

Never paste raw JSON. Lead with a verdict, not a dump.

### `search_path.py`

```markdown
**<srcIp> → <dstIp> : <verdict>**

Where `<verdict>` is one of:
- ✅ `Delivered` — at least one path reaches the destination
- ⚠️ `Violates policy` — delivered but at least one path violates a policy
- ❌ `Dropped` — all candidate paths are dropped
- ⏱ `Timed out` — server budget exhausted; results incomplete

Then, per path (cap at 3 unless user asked for all):

> **Path <k>** · `<outcome>` · <hop count> hops
>
>     <src> → <device1[iface]> → <device2[iface]> → ... → <dst>
>
> - Drop reason / violation name, if applicable
> - Policy hits: `<list>`

If intent was `VIOLATIONS_ONLY` and zero paths returned, say: "**No policy violations found** between src and dst."

If the result suggests a useful next step, phrase it as a user prompt — not a command. Examples:
- *"To hunt for unintended reachability instead, ask: **Are there policy violations between &lt;A&gt; and &lt;B&gt;?**"*
- *"To trace from a different source, ask: **Can &lt;C&gt; reach &lt;B&gt; on the same port?**"*
- *"To check several flows at once, prepare a JSON file and ask: **Run these bulk path checks.**"*
```

### `search_paths_bulk.py`

```markdown
**<N> path searches** (<M> delivered · <V> violated · <D> dropped · <T> timed out)

| # | src → dst | proto/port | outcome | paths | note |

Sort violated first, then dropped, then delivered. Truncate to 20 rows; if more, append: `(20 of <N>; raise or slice --queries-file to drill in)`.

If all N searches were delivered with no violations, say: "**All <N> path checks passed** — no drops or policy violations found."

If the result suggests a useful next step, phrase it as a user prompt — not a command. Examples:
- *"To drill into a failing flow, ask: **Trace the path from &lt;src&gt; to &lt;dst&gt; on TCP 443.**"*
- *"To test a what-if fix, ask: **Run these bulk checks against changeset CHG-XXX.**"*
```

## When to use

- "Can host 10.1.2.3 reach 10.5.0.0/24 on TCP 443?"
- "Trace the path from branch-edge to prod-db"
- "Show me all paths where the firewall drops this flow"
- "Does this traffic violate any policy?"
- "Find unintended reachability from the DMZ"

## When NOT to use

- Inventory questions (what devices exist, what VLANs are configured) → `forward-nqe-query` / `forward-inventory`
- Device-level state (ARP, routes, config) → `forward-nqe-query`
- Questions about generic routing protocol behavior not tied to actual traffic → answer from knowledge

## Scripts

| Script | Purpose |
|---|---|
| `search_path.py` | Single path search — one src/dst flow |
| `search_paths_bulk.py` | Bulk — run N path searches in one API call from a JSON file |

### search_path.py

```bash
# Minimum: dstIp + network
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-path-analysis/scripts/search_path.py" \
    --network-id NET_xyz --dst-ip 10.5.0.10

# Full flow: src, dst, ports, protocol
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-path-analysis/scripts/search_path.py" \
    --network-id NET_xyz \
    --src-ip 10.1.2.3 --dst-ip 10.5.0.10 \
    --ip-proto tcp --dst-port 443 \
    --intent PREFER_DELIVERED \
    --max-seconds 30 --max-results 20

# Hunt for violations
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-path-analysis/scripts/search_path.py" \
    --network-id NET_xyz \
    --src-ip 10.1.2.3 --dst-ip 10.5.0.10 \
    --intent VIOLATIONS_ONLY
```

Arguments:

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | From `forward-inventory/list_networks.py` |
| `--dst-ip` | yes | IP or subnet |
| `--src-ip` | no | If omitted, search is from-anywhere |
| `--from` | no | Device or location name to start from |
| `--ip-proto` | no | `tcp`, `udp`, `icmp`, or a protocol number |
| `--src-port` / `--dst-port` | no | Strings (to allow ranges like `1024-65535`) |
| `--intent` | no | `PREFER_DELIVERED` \| `PREFER_VIOLATIONS` \| `VIOLATIONS_ONLY` |
| `--snapshot-id` | no | Defaults to latest processed. **Mutually exclusive with --changeset-id** |
| `--changeset-id` | no | Forward Predict changeset ID (e.g., `CHG-123`) for what-if analysis. **Mutually exclusive with --snapshot-id** |
| `--max-seconds` | no | Server-side search budget (default 30) |
| `--max-candidates` / `--max-results` / `--max-return-path-results` | no | Result caps |
| `--include-network-functions` | no | Include NFV/virtual-appliance modeling |

### search_paths_bulk.py

Run many path searches in one API round-trip. Input is a JSON file:

```json
{
  "queries": [
    {"srcIp": "10.1.2.3", "dstIp": "10.5.0.10", "ipProto": 6, "dstPort": "443"},
    {"srcIp": "10.1.2.3", "dstIp": "10.5.0.11", "ipProto": 6, "dstPort": "22"}
  ],
  "intent": "PREFER_VIOLATIONS",
  "maxSeconds": 60
}
```

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-path-analysis/scripts/search_paths_bulk.py" \
    --network-id NET_xyz --queries-file ./checks.json
```

## Gotchas

- **Slow**: a single complex search can take 30-120s. Bulk searches scale by query count. Always warn the user for any operation with `--max-seconds > 30` or bulk count > 10.
- **`--max-seconds` is a budget, not a timeout**: the server returns whatever it has when the budget elapses. Short budgets can return incomplete results flagged with `timedOut: true`.
- **Snapshot staleness matters**: path results reflect the modeled state of the chosen snapshot. If a config changed this morning and no snapshot has been processed since, the model is stale. Check snapshot age before trusting "policy violation" answers.
- **Large networks produce huge result sets**: use `--max-return-path-results 5` and `--max-results 20` unless the user explicitly wants exhaustive results.
- **IP and port types**: ports are strings (to allow ranges); IP protocol is an integer on the wire but this script accepts `tcp`/`udp`/`icmp` shortcuts.
- **From-anywhere searches**: omitting `--src-ip` searches from every possible source. This is expensive — think twice before kicking it off.
- **Changeset vs Snapshot**: `--changeset-id` and `--snapshot-id` are **mutually exclusive**. When using Forward Predict (what-if analysis), use `--changeset-id CHG-XXX` ONLY — do NOT also pass `--snapshot-id`. The changeset already contains the predicted snapshot context. Mixing them returns a 404 error.

## Forward Predict Integration (What-If Analysis)

To test paths in a **what-if scenario** (e.g., "would this ACL change allow the traffic?"), use `--changeset-id` instead of `--snapshot-id`:

1. Create a changeset using `forward-predict` skill
2. Add configuration changes (ACL, route, BGP advertisement, etc.)
3. Run path analysis with `--changeset-id CHG-XXX`

```bash
# Example: Test if traffic would be delivered after ACL change
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-path-analysis/scripts/search_path.py" \
    --network-id NET_xyz \
    --changeset-id CHG-XXX \
    --src-ip 172.16.1.10 --dst-ip 10.50.1.1 \
    --ip-proto tcp --dst-port 443
```

**CRITICAL**: When using `--changeset-id`, do NOT also pass `--snapshot-id`. They are mutually exclusive. The changeset already contains the predicted snapshot context.

## Key concept: intent

Path search takes an `intent` parameter that changes **which paths are returned and how they're ranked**:

| Intent | Returns |
|---|---|
| `PREFER_DELIVERED` (default-ish) | All paths; rank delivered > dropped > violated |
| `PREFER_VIOLATIONS` | All paths; rank violations > delivered; surfaces policy issues |
| `VIOLATIONS_ONLY` | Only paths that violate at least one policy |

Pick based on the user's question:
- "Can X reach Y?" → `PREFER_DELIVERED`
- "Is there unintended reachability?" → `PREFER_VIOLATIONS` or `VIOLATIONS_ONLY`
- "Show me the security holes" → `VIOLATIONS_ONLY`

See `references/path-intents.md` for more detail.
