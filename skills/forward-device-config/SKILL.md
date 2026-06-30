---
name: forward-device-config
description: Retrieve raw device configs, config stanzas, grep across devices, and diff between snapshots from Forward snapshot files. Use when the user asks "the running config", "the interface block", "paste the access-list", "the `router bgp` stanza", "what's in $device's config", "search configs for X", "what changed between snapshots". Returns literal CLI text (IOS/EOS/Junos/PAN-OS), not Forward's parsed model. Not for parsed device state (use forward-device-intel) or reachability (use forward-path-analysis).
allowed-tools: Bash(python3 *), Read
---

# Forward Device Config

> **Read first:** `${CLAUDE_PLUGIN_ROOT}/shared/expertise/forward-as-backend.md` — the foundational framing. Forward is the *data substrate*; this skill is the raw-config-text projection of that substrate. When the user says "show me the config" / "paste the BGP block" / "what's in `<device>`", default to calling this skill, not to asking which device they mean (call `forward-overview.py` first if the network/snapshot isn't pinned).

## Operate as a network engineer

Before extracting or interpreting config text:

- For multi-step asks (config-mismatch, policy-violation, reachability-failure), **read `${CLAUDE_PLUGIN_ROOT}/shared/expertise/investigation-workflows.md` first** to plan the right chain of skill calls instead of single-shotting.
- When *interpreting* config (vs. just fetching it) — including BGP/OSPF/IS-IS/EVPN/MPLS stanzas, ACL/policy ordering, vendor-specific gotchas, or best-practice baselines — read `${CLAUDE_PLUGIN_ROOT}/shared/expertise/config-syntax.md`. It covers IOS / IOS-XE / IOS-XR / NX-OS / EOS / Junos / PAN-OS / FortiOS / ASA / Check Point and cloud constructs, plus routing-protocol conventions.

---

Fetches raw device configuration text from Forward's per-snapshot file store. These are the literal bytes the collector scraped off the device — `show running-config` for Cisco/Arista, `show configuration` for Junos, XML exports for PAN-OS.

Different API surface from `forward-device-intel`: that skill returns Forward's **parsed** model (tabular, structured). This skill returns **raw text** (the CLI output, verbatim).

## Invocation

Run from the user's cwd so the scripts auto-load `.env`. Do NOT `source .env` or export creds manually. Do not narrate which script you're about to run.

```bash
# 1. Discover what files exist in a snapshot
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-config/scripts/list_configs.py" \
    --snapshot-id <snap-id> --device <name-substring> --category configuration

# 2. Fetch a full running-config (auto-detects cisco/junos/xml)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-config/scripts/get_config.py" \
    --snapshot-id <snap-id> --device <hostname>

# 3. Extract a Cisco/EOS stanza (indent-based)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-config/scripts/get_config.py" \
    --snapshot-id <snap-id> --device <hostname> --stanza "interface Vlan200"

# 4. Extract a Junos stanza (curly-brace-based — same flag, auto-detected)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-config/scripts/get_config.py" \
    --snapshot-id <snap-id> --device <hostname> --stanza "^protocols bgp"

# 5. Extract from PAN-OS XML by XPath
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-config/scripts/get_config.py" \
    --snapshot-id <snap-id> --device <hostname> \
    --xpath ".//interface/ethernet/entry[@name='ethernet1/1']"

# 6. Same stanza across several devices — single bash loop
for d in sw1 sw2 sw3; do
    echo "! === $d ==="
    python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-config/scripts/get_config.py" \
        --snapshot-id <snap-id> --device "$d" --stanza "router bgp"
    echo
done

# 7. Regex across every device config in a snapshot
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-config/scripts/grep_configs.py" \
    --snapshot-id <snap-id> --pattern 'ip helper-address \S+' --context 1

# 8. Diff a device's config between two snapshots
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-config/scripts/diff_configs.py" \
    --snapshot-a <old> --snapshot-b <new> --device <hostname>
```

## Format handling

`get_config.py` auto-detects the config format on fetch and selects the right extractor:

| Format | Detection | Extraction |
|---|---|---|
| `cisco` (IOS / XE / NX / ASA / EOS / HP) | default | `--stanza REGEX` — indent-based blocks |
| `junos` (Juniper Junos) | first ~200 lines contain a line ending with `{` | `--stanza REGEX` — curly-brace-matched blocks |
| `xml` (PAN-OS, NX-API exports) | starts with `<?xml` or `<` | `--xpath EXPR` — ElementTree XPath |

Override with `--format cisco|junos|xml` if detection picks the wrong bucket.

## Output format

Never paste raw JSON. Config text should appear in fenced code blocks, never as prose.

**Script output contract.** Two scripts emit the standard weave JSON envelope on `--format json`-style machine output: `list_configs.py` and `grep_configs.py` print `{"ok":true,"schema":1,"data":…,"meta":…}` (the render fields below come from `data`/`meta`). The two text-primary scripts — `get_config.py` and `diff_configs.py` — keep emitting **raw config / diff text** to stdout (no envelope); on failure they write an `error [CODE]: …` line to stderr and exit non-zero (diff uses exit 2 for errors). Render the text scripts exactly as before; for the JSON scripts, pull counts from `meta` and rows from `data`.

### `list_configs.py`

Envelope: `data` is the list of file rows (`fileName`, `device`, `category`, `sizeBytes`); `meta` carries `snapshot_id`, `count`, `device_filter`, `category_filter`.

```markdown
**<meta.count> files** in snapshot `<id>`<, device matches `<filter>`>

| device | category | size |

- Group by device when more than one category per device is present.
- If the user only asked about one device, drop the table and list categories as bullets.
```

Zero results: "No `<category>` files found in snapshot `<id>`<, device filter: `<filter>`>. Try `list_configs.py` without `--category` to see what categories exist."

To explore a specific device's config, ask: "Show me the running config for `<device>`."

### `get_config.py` — full file

```markdown
**`<device>`** · running-config · <line-count> lines

```cisco
<full text, or first <max-lines> if truncated>
```

If truncated, add below the code block: *"Truncated at <max-lines>. Ask for the full config to see all <total> lines."*

- Use the vendor-appropriate language tag: `cisco` for IOS/XE/NX/ASA, `eos` or `cisco` for Arista, `junos` for Junos, `xml` for PAN-OS, `text` when unknown.
```

Zero results: state that the file was empty (the collector scraped nothing for that category) — not an error.

To extract a specific stanza, ask: "Show me the `interface Vlan200` stanza on `<device>`."

### `get_config.py --stanza` — Cisco or Junos stanzas

```markdown
**`<stanza-header>` stanzas** · snapshot `<id>` · <N> devices

```cisco
! === <device1> ===
interface Vlan200
   ip address ...

! === <device2> ===
interface Vlan200
   ip address ...
```

- One fenced block, multiple stanzas separated by the `! === <device> ===` banner for Cisco-family; use `# === <device> ===` for Junos.
- If the user asked across multiple devices, run the loop in a single Bash call (saves round-trips).
- If a device has no matching stanza, explicitly say so beneath the block: *"`<device>`: no matching stanza — likely different role."*
- Close with a useful observation if one stands out (identical stanzas = templated deployment; divergent = configuration drift; missing on subset = role difference).
```

Zero results: "No stanzas matched `/<regex>/` in `<device>`'s `<category>` config. The stanza header regex is case-sensitive by default."

To trace a flow using this config, ask: "Can `<A>` reach `<B>` on VLAN 200?"

### `get_config.py --xpath` — PAN-OS XML elements

```markdown
**XPath `<expr>`** · snapshot `<id>` · <N> matches from `<device>`

```xml
<entry name="ethernet1/1">
  <layer3>
    <ip>
      <entry name="10.0.0.1/24"/>
    </ip>
  </layer3>
</entry>
```

- Preserve the XML verbatim; don't prettify further than the script already did.
- If XPath returned zero elements, say so — point out whether the XPath is too specific or the element genuinely isn't there.
```

Zero results: "XPath `<expr>` matched zero elements in `<device>`'s config. The expression may be too specific or the element may not exist in this snapshot."

### `grep_configs.py`

Envelope: `data.matches` is the match list (`device`, `line`, `match`, `text`, `context`); `meta` carries `snapshot_id`, `pattern`, `category`, `devices_searched`, `devices_with_matches`, `match_count`.

```markdown
**<meta.match_count> matches** across <meta.devices_with_matches>/<meta.devices_searched> devices · pattern `<regex>`

Group by device. For each device:

> **`<device>`** · <k> matches
>
> ```
> line <N>: <matched line>
> line <N>: <matched line>
> ```

- If `--context` was non-zero, indent context lines beneath the match line.
- Cap display at 10 devices; if more, list the rest as a one-line device roster and say `...and <k> more devices with matches (ask "show all" to expand)`.
- If the same config fragment appears on every device, call that out (typical = baseline templated config; atypical = either missing entirely on some or copied accidentally).
- Close with a next-step hint when the match points somewhere actionable, e.g. *"To trace whether `<matched address>` is reachable, ask: **Can the management net reach &lt;ip&gt;?**"* (handled by `forward-path-analysis`).
```

Zero results: "Pattern `/<regex>/` matched no lines across <N> `<category>` configs in snapshot `<id>`."

To trace a flow involving a matched address, ask: "Can the management net reach `<matched-ip>`?"

### `diff_configs.py`

```markdown
**`<device>` config diff** · <snapshot-a> → <snapshot-b> · +<added> -<removed> lines

```diff
<unified diff body>
```

- Always render the body in a fenced block with the `diff` language tag.
- If the diff is empty, state: *"**No changes** to `<device>`'s `<category>` between `<snapshot-a>` and `<snapshot-b>`."* — don't show an empty code block.
- If the diff is > 200 lines, lead with a 3-5 line summary of the kinds of changes (e.g. "4 ACL entries added to `access-list 101`, BGP neighbor `10.0.0.1` removed, 2 interface description changes") BEFORE the full diff.
- Exit code 1 from the script indicates differences were found; 0 means no differences — don't treat exit 1 as an error.
```

Zero results: "**No changes** to `<device>`'s `<category>` config between `<snapshot-a>` and `<snapshot-b>`."

To validate whether a config change fixes a reachability problem, ask: "Does the new config allow `<A>` to reach `<B>`?"

### Next-step hints

Phrase as user prompts — never raw commands. Examples:

- *"To trace a flow using this config, ask: **Can &lt;A&gt; reach &lt;B&gt; on VLAN 200?**"* (handled by `forward-path-analysis`)
- *"To see Forward's parsed view of this interface, ask: **Show interface status for &lt;device&gt;.**"* (handled by `forward-device-intel`)
- *"To audit this config against a STIG, ask: **Run &lt;vendor&gt; STIGs for this network.**"* (handled by `forward-compliance-check`)

## When to use

- "Show me the running config for `<device>`"
- "Paste the `interface Vlan200` stanza from every client device"
- "What does `router bgp` look like on the spines?"
- "Give me ACL 101 from `<device>`"
- "Print the full config for `<device>`"
- "What changed in `<device>`'s config between last night and today?"

## When NOT to use

- Parsed interface/ARP/BGP state → `forward-device-intel`
- Running a query over the model → `forward-nqe-query`
- Reachability / path analysis → `forward-path-analysis`

## Scripts

| Script | Purpose |
|---|---|
| `list_configs.py` | List config files available in a snapshot (enumerate device/category combinations) |
| `get_config.py` | Fetch a full config or extract a stanza (Cisco/Junos) or XPath element (PAN-OS XML) |
| `grep_configs.py` | Regex-search across all device configs in a snapshot |
| `diff_configs.py` | Unified diff of a device's config between two snapshots |

### list_configs.py

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-config/scripts/list_configs.py" \
    --snapshot-id <snap-id>

python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-config/scripts/list_configs.py" \
    --snapshot-id <snap-id> --device <name-substring> --category configuration
```

| Flag | Required | Notes |
|---|---|---|
| `--snapshot-id` | yes | Snapshot to enumerate |
| `--device` | no | Case-insensitive substring filter on device name |
| `--category` | no | Filter by category (e.g. `configuration`, `version`). Default shows all. |
| `--limit` | no | Cap rows returned (0 = no cap; default 0) |

### get_config.py

```bash
# Full config
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-config/scripts/get_config.py" \
    --snapshot-id <snap-id> --device <hostname>

# Extract a stanza
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-config/scripts/get_config.py" \
    --snapshot-id <snap-id> --device <hostname> --stanza "^router bgp"

# Extract XML via XPath
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-config/scripts/get_config.py" \
    --snapshot-id <snap-id> --device <hostname> \
    --xpath ".//interface/ethernet/entry[@name='ethernet1/1']"
```

| Flag | Required | Notes |
|---|---|---|
| `--snapshot-id` | yes | Snapshot to fetch from |
| `--device` | yes (or `--file-name`) | Device hostname; combined with `--category` to form the file name |
| `--file-name` | yes (or `--device`) | Exact file name (e.g. `sw1,configuration.txt`). Mutually exclusive with `--device`. |
| `--category` | no | File category when using `--device` (default `configuration`) |
| `--format` | no | Override format detection: `auto` (default), `cisco`, `junos`, `xml` |
| `--stanza` | no | Extract stanzas whose header matches this regex (cisco/junos). Mutually exclusive with `--xpath`. |
| `--xpath` | no | Extract XML elements matching this XPath (xml format). Mutually exclusive with `--stanza`. |
| `--max-lines` | no | Truncate full-file output (default 200; 0 = no truncation). Ignored when `--stanza`/`--xpath` is set. |

### grep_configs.py

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-config/scripts/grep_configs.py" \
    --snapshot-id <snap-id> --pattern 'ip helper-address \S+' --context 1

python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-config/scripts/grep_configs.py" \
    --snapshot-id <snap-id> --pattern 'router bgp' --device spine --ignore-case
```

| Flag | Required | Notes |
|---|---|---|
| `--snapshot-id` | yes | Snapshot to search |
| `--pattern` | yes | Python regex (not grep syntax) |
| `--device` | no | Substring filter on device name (case-insensitive) |
| `--category` | no | File category to search (default `configuration`) |
| `--context` | no | Lines of context before and after each match (default 0) |
| `--ignore-case` | no | Case-insensitive match |
| `--max-matches-per-device` | no | Cap matches reported per device (default 20; 0 = no cap) |
| `--warn-at` | no | Emit stderr warning if device count exceeds this (default 20) |

### diff_configs.py

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-config/scripts/diff_configs.py" \
    --snapshot-a <old-snap-id> --snapshot-b <new-snap-id> --device <hostname>

# Summary only — no full diff body
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-config/scripts/diff_configs.py" \
    --snapshot-a <old-snap-id> --snapshot-b <new-snap-id> --device <hostname> --stat
```

| Flag | Required | Notes |
|---|---|---|
| `--snapshot-a` | yes | Baseline snapshot ID (older) |
| `--snapshot-b` | yes | Compare snapshot ID (newer) |
| `--device` | yes (or `--file-name`) | Device hostname; combined with `--category` to form the file name |
| `--file-name` | yes (or `--device`) | Exact file name. Mutually exclusive with `--device`. |
| `--category` | no | File category when using `--device` (default `configuration`) |
| `--context` | no | Unified-diff context lines (default 3) |
| `--stat` | no | Summary only (+added/-removed line counts), no diff body |

## Gotchas

- **Format detection uses a heuristic**. If a config is misclassified (e.g. an unusual vendor that happens to end lines with `{`), override with `--format cisco|junos|xml`. Auto-detection works on typical IOS, EOS, ASA, Junos, and PAN-OS configs.
- **`--stanza` is regex, not grep**. Use `^interface Vlan200$` for anchored matches. For Junos, the header of a stanza is the line ending in `{` — so `^protocols bgp` anchors to the nested block header.
- **XPath support is ElementTree-level**, not full XPath 1.0. Most common expressions work (`.//tag`, `tag[@attr='v']`, `tag[position()=1]`). Features like `text()` predicates and axis steps may not.
- **`grep_configs.py` is N API calls**. For a 200-device snapshot, that's 200 fetches; expect minutes. The script warns on stderr when device count > `--warn-at` (default 20). Narrow with `--device` or `--category` when you can.
- **`diff_configs.py` assumes both snapshots contain the same filename**. If a device was renamed or decommissioned between snapshots, the fetch will 404 — surface that to the user.
- **Category names vary**. The most common is `configuration`. Others seen in the wild: `version`, `interfaces`, `vlan`, `route`, `arp`. Use `list_configs.py --device <name>` (no `--category`) to enumerate for a given device before asking for the wrong one.
- **Snapshot-scoped**. Every call needs `--snapshot-id`. Get it from `forward-inventory` (list_snapshots.py `--latest`) if the user didn't provide one.
- **Large configs**. Full running-configs on a core device can be thousands of lines. Default `--max-lines 200` keeps output sane; bump with `--max-lines 0` for everything.
- **Filenames are literal**. The collector writes files named `{device},{category}.txt` — commas in filenames, URL-encoded in the API path. The script handles encoding; just pass `--device` / `--category`.
- **Empty file ≠ error**. An empty response is legitimate (the collector scraped nothing for that category). The script writes a stderr note and exits 0.
