---
name: forward-predict
description: Manage Forward Networks Predict overrides — BGP-advertisement injections layered on a change-set sandbox. Use when the user asks "predict what happens if X advertises Y", "add a BGP advertisement to the change-set", "list overrides on CHG-7", "remove the predicted route on us-border-1", or "show me the change-set". Not for path searches against a change-set (use forward-path-analysis), reading device state (use forward-device-intel or forward-nqe-query), or device config (use forward-device-config).
allowed-tools: Bash(python3 *), Read
---

# Forward Predict

> **Read first:** `${CLAUDE_PLUGIN_ROOT}/shared/expertise/forward-as-backend.md` — the foundational framing. Predict is the substrate's *what-if* projection — change-set overrides layered on a snapshot. Use it as the validation step *after* root-cause is identified, not as the starting point of an investigation.

## Operate as a network engineer

Predict is the *validate-the-fix* step in an investigation — most useful **after** you've identified a root cause via the other skills, not as a starting point.

- Read `${CLAUDE_PLUGIN_ROOT}/shared/expertise/investigation-workflows.md` (especially the closing section of Workflow 3 — *Reachability failure*) for the canonical chain: path-trace → root-cause → propose fix → add Predict override → re-run path-analysis with `--changeset` → confirm fix.
- For routing-protocol context (what a BGP advertisement means, how it's evaluated, what next-hop / community / origin choices imply), read `${CLAUDE_PLUGIN_ROOT}/shared/expertise/config-syntax.md` (BGP section).

---

Wraps the Forward Predict endpoints that mutate a **change-set** — a sandbox layered on a snapshot. v1 covers BGP-advertisement injection; future versions can grow link-state perturbations and ACL overrides under the same skill.

A change-set looks like:

```json
{
  "id": "CHG-7",
  "name": "Analysis 006",
  "networkId": "346",
  "snapshotId": "691",
  "deviceToChanges": {
    "us-border-1": {
      "addedAdvertisements": [
        {"type":"EBGP","nextHop":"10.0.0.34","origin":"IGP",
         "asPath":[4259971172],"externalPeer":"10.0.0.34",
         "prefix":"10.202.0.0/24","vrf":"default"}
      ],
      "hasConfig": false
    }
  }
}
```

## Invocation

Run from the user's cwd so `.env` auto-loads. Do NOT `source .env` or export creds manually. Do not narrate which script you're about to run.

```bash
# Inspect a change-set (full record incl. metadata + every device's overrides)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-predict/scripts/get_changeset.py" \
    --network-id NET_xyz --changeset-id CHG-XXX

# Flat list of just the BGP advertisements (all devices, or filter to one)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-predict/scripts/list_advertisements.py" \
    --network-id NET_xyz --changeset-id CHG-XXX
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-predict/scripts/list_advertisements.py" \
    --network-id NET_xyz --changeset-id CHG-XXX --device us-border-1 --json

# Add one advertisement
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-predict/scripts/add_advertisement.py" \
    --network-id NET_xyz --changeset-id CHG-XXX --device us-border-1 \
    --prefix 10.202.0.0/24 --next-hop 10.0.0.34 --external-peer 10.0.0.34 \
    --vrf default --type EBGP --origin IGP --as-path 4259971172

# Preview the request without sending it
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-predict/scripts/add_advertisement.py" \
    --network-id NET_xyz --changeset-id CHG-XXX --device us-border-1 \
    --prefix 10.202.0.0/24 --next-hop 10.0.0.34 --external-peer 10.0.0.34 \
    --as-path 4259971172 --dry-run

# Remove one advertisement (round-trips the change-set to find the exact record)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-predict/scripts/remove_advertisement.py" \
    --network-id NET_xyz --changeset-id CHG-XXX --device us-border-1 \
    --prefix 10.202.0.0/24 --yes
# Add disambiguators if multiple ads share --prefix:
#   --next-hop 10.0.0.34 --external-peer 10.0.0.34 --vrf default --type EBGP

# Bulk add from a file (per-device wrapper form is preferred)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-predict/scripts/import_advertisements.py" \
    --network-id NET_xyz --changeset-id CHG-XXX --input-file ./predicts.json
```

## Output format

Never paste raw JSON. Lead with a verdict, not a dump.

### `get_changeset.py`

```markdown
Lead with one line:

    Change-set <id> "<name>" on network <networkId> (snapshot <snapshotId>) — <N> device(s) with overrides, last updated <updatedAt>.

Then per device, one line each:
    <device>: <K> added BGP advertisement(s)[, hasConfig=true]
```

Zero result: "Change-set <id> exists but has no device overrides."

To inspect the individual advertisements, ask: "List the BGP overrides on change-set CHG-XXX."

### `list_advertisements.py`

```markdown
Summarize as:

    <N> added BGP advertisement(s) across <D> device(s) in <changesetId>:
      <device>:
        <type> vrf=<vrf> prefix=<prefix> nextHop=<nh> peer=<peer> as-path=[<csv>]

If --json was passed, only the JSON array is emitted — relay it as a fenced block.
```

Zero result: "No added BGP advertisements in change-set <id>[ on <device>]."

To run a path search using this change-set, ask: "Trace the path from 10.1.0.1 to 10.202.0.1 using change-set CHG-XXX."

### `add_advertisement.py`

```markdown
On success:

    Added <type> <prefix> via <nextHop> (peer <externalPeer>, vrf <vrf>) on <device> in change-set <changesetId>.

If the response is empty 2xx, the script emits {"added": true, "echo": <body>} — say so explicitly.
On 4xx, surface the server's detail string verbatim — it identifies which field failed validation.
```

To verify the change-set after adding, ask: "Show me change-set CHG-XXX."

### `remove_advertisement.py`

```markdown
On success:

    Removed <type> <prefix> via <nextHop> on <device> in change-set <changesetId>.

If the lookup matched zero or multiple records, the script exits non-zero with the candidates printed to stderr — relay those so the user can re-issue with extra disambiguators.
```

To confirm removal, ask: "List the BGP overrides on change-set CHG-XXX."

### `import_advertisements.py`

```markdown
Summarize as:
    Imported <K>/<N> Predict BGP advertisements into <changesetId> (<M> failed).
For each failed row, surface row index, device, and the server error string.
```

Zero result (all failed): "All <N> advertisements failed to import into <changesetId>. First error: <error>."

To verify what was imported, ask: "List the BGP overrides on change-set CHG-XXX."

## When to use

- "Predict the impact if `us-border-1` advertised `10.202.0.0/24` from peer `10.0.0.34`."
- "List the BGP overrides on change-set CHG-7."
- "Show me change-set CHG-7."
- "Remove the predicted route for `10.202.0.0/24` on `us-border-1`."
- "I have a JSON file of 30 hypothetical advertisements — load them into CHG-7."

## When NOT to use

- **Creating, listing, or deleting change-sets themselves.** This skill assumes the change-set already exists. Create one in the UI (or a future skill) and pass `--changeset-id`.
- **Running a path search against a change-set** → `forward-path-analysis` (pass the change-set / snapshot scope).
- **Reading actual device BGP state** (RIB, peerings) → `forward-device-intel` or `forward-nqe-query`.
- **Editing device configs** → `forward-device-config`. (`hasConfig: true` on a change-set is a different override channel that's out of scope here for v1.)

## Scripts

| Script | Purpose |
|---|---|
| `add_advertisement.py` | Add a single BGP advertisement to a change-set device |
| `get_changeset.py` | Fetch the full change-set record (metadata + all device overrides) |
| `import_advertisements.py` | Bulk-add BGP advertisements from a JSON file |
| `list_advertisements.py` | List all BGP advertisements in a change-set, optionally filtered to one device |
| `remove_advertisement.py` | Remove a BGP advertisement from a change-set device |

### `add_advertisement.py`

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-predict/scripts/add_advertisement.py" \
    --network-id NET_xyz --changeset-id CHG-XXX --device us-border-1 \
    --prefix 10.202.0.0/24 --next-hop 10.0.0.34 --external-peer 10.0.0.34 \
    --vrf default --type EBGP --origin IGP --as-path 4259971172
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network ID |
| `--changeset-id` | yes | Change-set ID, e.g. `CHG-7` |
| `--device` | yes | Origin device name, e.g. `us-border-1` |
| `--prefix` | yes | CIDR, e.g. `10.202.0.0/24` |
| `--next-hop` | yes | Next-hop IP address |
| `--external-peer` | yes | External peer IP address |
| `--vrf` | no | VRF name; default `default` |
| `--type` | no | `EBGP` or `IBGP`; default `EBGP` |
| `--origin` | no | `IGP`, `EGP`, or `INCOMPLETE`; default `IGP` |
| `--as-path` | no | Comma-separated ASNs; asdot notation accepted (e.g. `65000.36`) |
| `--local-pref` | no | Integer or `""` to omit |
| `--med` | no | Integer or `""` to omit |
| `--dry-run` | no | Print request body without calling the API |

### `get_changeset.py`

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-predict/scripts/get_changeset.py" \
    --network-id NET_xyz --changeset-id CHG-XXX
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network ID |
| `--changeset-id` | yes | Change-set ID, e.g. `CHG-7` |
| `--view` | no | `draft` (default) or `saved` — mirrors the UI draft/saved toggle |

### `import_advertisements.py`

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-predict/scripts/import_advertisements.py" \
    --network-id NET_xyz --changeset-id CHG-XXX --input-file ./predicts.json
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network ID |
| `--changeset-id` | yes | Change-set ID, e.g. `CHG-7` |
| `--input-file` | yes | Path to JSON file; array of per-device wrapper objects or flat advertisement objects |
| `--dry-run` | no | Print request bodies without calling the API |
| `--continue-on-error` | no | Keep going after a failed POST; records per-row errors in the summary |

Input file formats:
- **Per-device wrapper (preferred):** `[{"device": "us-border-1", "advertisements": [{...}, ...]}, ...]`
- **Flat:** `[{"device": "us-border-1", "vrf": "default", "type": "EBGP", "prefix": "...", ...}, ...]`

### `list_advertisements.py`

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-predict/scripts/list_advertisements.py" \
    --network-id NET_xyz --changeset-id CHG-XXX
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network ID |
| `--changeset-id` | yes | Change-set ID, e.g. `CHG-7` |
| `--device` | no | Filter output to one device's advertisements |
| `--view` | no | `draft` (default) or `saved` |
| `--json` | no | Emit only the raw JSON array (no human summary header) |

### `remove_advertisement.py`

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-predict/scripts/remove_advertisement.py" \
    --network-id NET_xyz --changeset-id CHG-XXX --device us-border-1 \
    --prefix 10.202.0.0/24 --yes
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network ID |
| `--changeset-id` | yes | Change-set ID, e.g. `CHG-7` |
| `--device` | yes | Device holding the advertisement |
| `--prefix` | yes | CIDR of the advertisement to remove |
| `--yes` | yes* | Required to execute removal (destructive operation) |
| `--next-hop` | no | Disambiguator if multiple advertisements share `--prefix` |
| `--external-peer` | no | Disambiguator |
| `--vrf` | no | Disambiguator |
| `--type` | no | `EBGP` or `IBGP`; disambiguator |
| `--dry-run` | no | Show matched record and the request that would be sent, without calling the API |

## Gotchas

- **Empty-string sentinels.** Unset `localPref` / `med` MUST be sent as `""`, not `null` and not omitted. The body shape mirrors what the UI sends; deviating gets you a 400.
- **4-byte ASNs are normal.** `4259971172` (= asdot `65000.36`, hex `0xFDE60024`) is a valid AS-path entry. Don't strip or downcast.
- **No id on advertisements.** The server identifies them by content. `remove_advertisement.py` round-trips the change-set to find the exact record before issuing `action=remove`. If multiple match, narrow with `--next-hop`, `--external-peer`, `--vrf`, or `--type`.
- **No upsert.** Re-adding an identical advertisement may 4xx. Use `list_advertisements.py` first if you're not sure.
- **Removal is destructive.** `remove_advertisement.py` requires `--yes`; `--dry-run` will show the matched record and the request that *would* be sent.
- **`--dry-run` does not call the API** — it cannot detect server-side rejections (e.g. unknown device name on the network). For full validation, run for real against a throwaway change-set.
- **`hasConfig: true` is a different override channel** (config replacement, not BGP injection) and is out of scope for v1 of this skill. Do not infer that adding a BGP advertisement flips `hasConfig`.
- **Predict ≠ live network.** Nothing this skill writes touches device runtime state. The change-set has to be evaluated (path search, reachability run, etc.) for the prediction to materialize as a result.
- **Predict models *advertisements*, not *policy*.** v1 injects/removes BGP advertisements only — it cannot model a change whose effect comes from **config/policy** (a `route-map` / `local-preference` / `prefix-list` / `allowas-in` that re-selects an *existing* route). A per-prefix path move that depends on local-pref or a route-map will look like "Predict isn't working" because the advertisement is already present and only the policy decides the winner. For policy-driven what-ifs, change the config on the live device and re-snapshot, then validate with a real path search / intent check — not Predict.
- **Body shape reference.** The server accepts and returns this exact shape — note empty-string sentinels, not `null` / omission, for unset numeric fields:

```json
{
  "vrf":          "default",
  "externalPeer": "10.0.0.34",
  "type":         "EBGP",
  "prefix":       "10.202.0.0/24",
  "nextHop":      "10.0.0.34",
  "origin":       "IGP",
  "localPref":    "",
  "asPath":       [4259971172],
  "med":          ""
}
```

Validation enforced client-side before any POST: `prefix` parses as a valid CIDR; `nextHop` and `externalPeer` parse as IPs; `type` ∈ {`EBGP`, `IBGP`}; `origin` ∈ {`IGP`, `EGP`, `INCOMPLETE`}; `asPath` is a list of 32-bit ASNs (asdot `65000.36` accepted); `localPref` / `med` are integer strings or `""`.
