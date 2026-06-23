---
name: forward-bgp-prefix
description: Inspect BGP prefix provenance in a Forward snapshot — where a prefix is originated, which devices received it and whether they installed it, the winning-path attributes/policies on a device, and the hop-by-hop AS-path propagation trace. Use when the user asks "where does prefix X come from", "who originates 10.24.0.0/24", "which devices installed this prefix", "why didn't device Y prefer this route", "trace how this prefix propagated to Z", "show the best-path attributes for this prefix on a device". Read-only. Not for injecting hypothetical advertisements (use forward-predict), dumping a raw RIB/peer table (use forward-device-intel or forward-nqe-query), or tracing data-plane flows (use forward-path-analysis).
allowed-tools: Bash(python3 *), Read
---

# Forward BGP Prefix

> **Read first:** `${CLAUDE_PLUGIN_ROOT}/shared/expertise/forward-as-backend.md` — the foundational framing. This skill reads the **control-plane RIB** the way Forward modeled it from a snapshot. It answers *control-plane* provenance questions ("who originated this, who installed it, why was it (not) preferred"); for *data-plane* reachability ("can A reach B"), use `forward-path-analysis`.

## Operate as a network engineer

These four endpoints are how you interrogate **BGP route provenance** without paging through per-device RIB dumps. They form a drill-down, not four independent calls:

1. **`search`** — start here. "Where does `10.24.0.0/24` live?" → the origin device(s) and every device that received it, bucketed by RIB outcome (`INSTALLED` / `NOT_PREFERRED` / `FILTERED_OUT`).
2. **`device-info`** — for a single device, every advertisement it *received* for the prefix (per next-hop), which one won, and any more-specific installed routes. This is the per-device counterpart of `search`'s `devicesByOutcome`.
3. **`details`** — the winning path's BGP attributes (`localPref`, `med`, `origin`, AFI/SAFI, weight, preference) plus the import/export policies bound on that node.
4. **`trace`** — the hop-by-hop AS-path walk from origin to a chosen router, **with the route-maps applied at each hop**. This is the "why did it take this path / why was it transformed" view.

For routing-protocol context (what local-pref / MED / AS-path / origin imply for best-path selection), read `${CLAUDE_PLUGIN_ROOT}/shared/expertise/config-syntax.md` (BGP section).

---

## Invocation

Run from the user's cwd so `.env` auto-loads. Do NOT `source .env` or export creds manually. `--snapshot-id` is optional everywhere — it defaults to the network's latest processed snapshot. Do not narrate which script you're about to run.

```bash
# 1. Where does a prefix come from, and who received it?  (START HERE)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-bgp-prefix/scripts/search_prefix.py" \
    --network-id 111 --prefix 10.24.0.0/24

# 2. One device's received advertisements for the prefix (which won, per next-hop)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-bgp-prefix/scripts/device_prefix_info.py" \
    --network-id 111 --device tok-br-ce --prefix 10.24.0.0/24

# 3. Winning-path attributes + import/export policies on a device
#    (--device/--vrf are resolved to the full node via search automatically)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-bgp-prefix/scripts/prefix_details.py" \
    --network-id 111 --device tok-br-ce --prefix 10.24.0.0/24

# 4. Hop-by-hop propagation trace from origin to a router
#    (origin auto-resolved from search when --origin-device is omitted)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-bgp-prefix/scripts/trace_prefix.py" \
    --network-id 111 --device tok-br-ce --prefix 10.24.0.0/24
# Trace a route that was NOT preferred (to see why it lost):
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-bgp-prefix/scripts/trace_prefix.py" \
    --network-id 111 --device tok-br-ce --prefix 10.24.0.0/24 \
    --origin-device osa-br-ce --outcome NOT_PREFERRED
```

## Output format

Never paste raw JSON. Lead with a verdict, not a dump.

### `search_prefix.py`

```markdown
Lead with one line:

    Prefix <prefix> is originated by <origin device(s)> and received by <N> device(s):
    <I> INSTALLED, <P> NOT_PREFERRED, <F> FILTERED_OUT.

Then, if useful, list the INSTALLED devices (device/vrf) and call out any
FILTERED_OUT / NOT_PREFERRED devices as the interesting anomalies.
```

Zero result (`origin: []`, empty `devicesByOutcome`): "Prefix <prefix> is not present in the BGP RIB of this snapshot."

To drill into one device, ask: "Show me the bgp-prefix-info for <device> and <prefix>."

### `device_prefix_info.py`

```markdown
Summarize per VRF:

    <device> (<vendor>) vrf <vrf>: received <K> advertisement(s) for <prefix> —
      <nexthop> → <OUTCOME> (from <originatedFrom.device>)
    Installed more-specifics: <csv or "none">
```

The winning advertisement is the one with `outcome: INSTALLED`. A `NOT_PREFERRED`
next-hop is a path the device knew about but didn't select — name it.

### `prefix_details.py`

```markdown
Lead with:

    Best path for <prefix> on <device>/<vrf>: localPref <lp>, MED <med>,
    origin <origin>, <afi>/<safi>, weight <w>.
    Import policies: <csv or "none">.  Export policies: <csv or "none">.
```

`importPolicies` / `exportPolicies` empty means no route-map is bound for this
prefix on that node — say so; it's often the answer to "why wasn't it filtered/changed".

### `trace_prefix.py`

```markdown
Render each propagation path as an AS-path walk:

    <origin>(AS<asn>) → <hop>(AS<asn>) → … → <router>(AS<asn>)

Annotate hops that apply policy: "<device> applies export [<names>] / import [<names>]".
If multiple paths are returned, show each. An empty array means no path reaches
<router> with that <outcome> — report it as "no <outcome> path from <origin> to <router>".
```

## When to use

- "Where does `10.24.0.0/24` come from?" / "Who originates this prefix?"
- "Which devices installed `10.24.0.0/24`, and which rejected it?"
- "Why didn't `tok-br-ce` prefer the route via `10.1.0.117`?"
- "What are the best-path attributes for this prefix on `l-pe-lon`?"
- "Trace how this prefix propagated from its origin to `tok-br-ce`."
- "Which route-maps touched this prefix along the way?"

## When NOT to use

- **Injecting / removing hypothetical advertisements** (what-if) → `forward-predict`.
- **Dumping a full RIB, BGP peer table, or arbitrary route attributes** → `forward-device-intel` or `forward-nqe-query`.
- **Tracing a data-plane flow** ("can host A reach host B", drop reasons) → `forward-path-analysis`.
- **Reading raw device config** (the actual `route-map` / `prefix-list` text) → `forward-device-config`. This skill names the *bound* policies; it does not print their bodies.

## Scripts

| Script | Purpose |
|---|---|
| `search_prefix.py` | Find a prefix's origin device(s) and every receiver bucketed by RIB outcome. **Entry point.** |
| `device_prefix_info.py` | One device's received advertisements for a prefix (per next-hop), which won, and installed more-specifics |
| `prefix_details.py` | Winning-path BGP attributes + bound import/export policies for a prefix on a node |
| `trace_prefix.py` | Hop-by-hop AS-path propagation trace from origin to a router, with per-hop policies |

### `search_prefix.py`

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-bgp-prefix/scripts/search_prefix.py" \
    --network-id 111 --prefix 10.24.0.0/24
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network ID |
| `--prefix` | yes | CIDR; a host IP inside a block is normalized to the network address |
| `--snapshot-id` | no | Defaults to the network's latest processed snapshot |

### `device_prefix_info.py`

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-bgp-prefix/scripts/device_prefix_info.py" \
    --network-id 111 --device tok-br-ce --prefix 10.24.0.0/24
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network ID |
| `--device` | yes | Device name |
| `--prefix` | yes | CIDR (sent as a query param, URL-encoded) |
| `--snapshot-id` | no | Defaults to latest processed |

### `prefix_details.py`

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-bgp-prefix/scripts/prefix_details.py" \
    --network-id 111 --device tok-br-ce --prefix 10.24.0.0/24
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network ID |
| `--prefix` | yes | CIDR |
| `--device` | yes | Node device name |
| `--vrf` | no | Disambiguator when the device carries the prefix in multiple VRFs |
| `--snapshot-id` | no | Defaults to latest processed |

### `trace_prefix.py`

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-bgp-prefix/scripts/trace_prefix.py" \
    --network-id 111 --device tok-br-ce --prefix 10.24.0.0/24
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network ID |
| `--prefix` | yes | CIDR |
| `--device` | yes | Router (receiving device) whose perspective to trace |
| `--vrf` | no | Router VRF; default `default` |
| `--origin-device` | no | Origin device; auto-resolved from `search` when omitted (works for single-origin prefixes) |
| `--origin-vrf` | no | Origin VRF; default `default` |
| `--outcome` | no | `INSTALLED` (default), `NOT_PREFERRED`, or `FILTERED_OUT` — which received advertisement to trace |
| `--snapshot-id` | no | Defaults to latest processed |

## Gotchas

- **`search` is the keystone.** `prefix_details` needs a full `BgpNodeInfo` (`{device, vrf, locationId, routerId}`) — a bare `{device, vrf}` is rejected with a 500. The scripts handle this by round-tripping `search` to resolve `--device`/`--vrf` into the full node. If you call the raw endpoint yourself, send the complete object straight from a `search` result.
- **VRF is part of node identity.** The same prefix can live in `default` *and* `corporate` on one device (it does in net 111). `--device` alone may be ambiguous for `details`; `prefix_details.py` will tell you to add `--vrf`.
- **`router` / `originatedFrom` on trace are only `{device, vrf}`** — two fields, *not* the full `BgpNodeInfo`. The fourth required field is `outcome` (the trace targets one specific received advertisement). The full request DTO is exactly: `{prefix, router, originatedFrom, outcome}`.
- **Outcome enum is closed:** `INSTALLED`, `NOT_PREFERRED`, `FILTERED_OUT`. Anything else 400s.
- **An empty trace array is a real answer**, not an error: it means no path of that `outcome` reaches the router from that origin. Report it; don't retry blindly.
- **Control-plane, not data-plane.** `INSTALLED` here means "won BGP best-path and entered the RIB" — it does *not* prove end-to-end forwarding. Confirm reachability with `forward-path-analysis` when the question is "can traffic actually get there".
- **Prefix matching is exact (after normalization).** Searching `10.24.0.0/24` finds that prefix; it does not enumerate more-specifics. `device_prefix_info` does surface `moreSpecificInstalledRoutes` for the queried block.
- **All read-only.** Nothing here mutates a snapshot or a change-set. For what-if injection, switch to `forward-predict`.
```
