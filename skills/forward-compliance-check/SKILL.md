---
name: forward-compliance-check
description: Run STIG compliance checks against a Forward network snapshot. Use when the user asks "run STIGs for Cisco IOS", "check DISA STIG compliance", "find Cat I violations", "audit our Palo Altos". Filters the NQE catalog to the /Security/STIGs/* subtree and runs matched queries in bulk. Not for tracing flows (use forward-path-analysis) or inspecting device state (use forward-device-intel).
allowed-tools: Bash(python3 *), Read
---

# Forward Compliance Check

> **Read first:** `${CLAUDE_PLUGIN_ROOT}/shared/expertise/forward-as-backend.md` — the foundational framing. Compliance scanning is the substrate's *bulk-rule* projection — ~1700 STIG queries already modeled in Forward. When the user says "are we compliant" / "find Cat I violations" / "audit the firewalls", default to running the scan against the pinned snapshot, not to listing what STIGs exist.

## Operate as a network engineer

Compliance scanning is rarely the whole answer — a violation usually wants follow-up: *what does the offending config actually look like, is it exploitable in practice, what's the corrective stanza?* Before single-shotting a STIG run:

- Read `${CLAUDE_PLUGIN_ROOT}/shared/expertise/investigation-workflows.md` (Workflow 2 — *Policy / compliance violation*) for the recommended chain: scan → fetch violating stanza → optionally confirm exploitability with `forward-path-analysis` → propose vendor-specific fix.
- For interpreting the violating config and proposing the fix, read `${CLAUDE_PLUGIN_ROOT}/shared/expertise/config-syntax.md` — it covers vendor syntax, routing-protocol conventions, and the security baselines (mgmt plane, control plane, AAA, SNMPv3) that STIGs actually encode.

---

Forward's NQE catalog contains ~1771 STIG (Security Technical Implementation Guide) queries, organized by vendor and platform:

| Vendor | STIG query count |
|---|---|
| Cisco | 950 |
| Juniper | 511 |
| F5 | 182 |
| Palo Alto Networks | 114 |

STIG queries in the catalog use two row dialects — the script detects per-query which is in use:

1. **`rows-on-violation`** (Cisco, Juniper, F5 legacy): a row appears only when failing. `violationRowCount == rowCount`.
2. **`indicator-field`** (Palo Alto, newer controls): one row per audited device with a boolean `violation` / `passes` / `compliant` field. `violationRowCount == len([r for r in rows if r.violates])`.

Trust the script's `violationRowCount` — do not assume `rowCount` equals violations.

## Invocation

Run from the user's cwd so the script auto-loads `.env`. Do NOT `source .env` or export creds manually. Do not narrate. Always `--dry-run` first to preview query count before committing to a long sweep.

```bash
# 1. Preview what would run (offline — no API calls)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-compliance-check/scripts/stig_sweep.py" \
    --vendor Cisco --platform "Cisco IOS Router RTR" --dry-run

# 2. Run a capped sweep (safe default = 50 queries)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-compliance-check/scripts/stig_sweep.py" \
    --network-id <id> --vendor Cisco --platform "Cisco IOS Router RTR"

# 3. Full vendor audit (EXPLICIT opt-in, slow — 30+ min for Cisco)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-compliance-check/scripts/stig_sweep.py" \
    --network-id <id> --vendor Juniper --limit-queries 0
```

## Output format

Never paste raw JSON. Lead with the pass/fail verdict, then details.

### Dry-run output

```markdown
**<N> STIGs matched** (vendor=<V>, platform=<P>) — no queries executed.

If ≤ 20, list the paths verbatim as a bullet list.
If > 20, show top 10, then: `...and <k> more. Run without --dry-run to execute (will cap at --limit-queries=50).`
```

### Real sweep output

Summary placeholders below (`<queries_with_violations>`, `<dialects.*>`, …) live in the envelope's `meta`; per-control records (`violationRowCount`, `items`, …) live in `data.results`.

```markdown
**<executed>/<selected> STIGs run** · <queries_with_violations> failing · <total_violation_rows> total violation rows · <api_errors> errors

*(Dialect mix: <dialects.rows-on-violation> legacy, <dialects.indicator-field> indicator-field, <dialects.inverted-indicator-field> inverted — only mention this line if both dialects appear and the ratio is non-trivial.)*

Table of failing controls, sorted by **violationRowCount** desc:

| STIG | violations | sample failing device |

- **Use `violationRowCount`, not `rowCount`.** For `indicator-field` dialect they differ.
- STIG = tail of the path (control code + V-ID), e.g. `CISC-RT-000400 V-216588`
- sample failing device = for `rows-on-violation`: first deviceName in `items`. For `indicator-field`: first row where the indicator marks a violation.
- Only include rows where `violationRowCount > 0`.
- Truncate to top 20 failing controls; if more, append: `...and <k> more failing controls (say "show all failures" to expand)`.

Below the table, one section per top-3 failing control:

> **<control>**
> Description: *<pull from path or from get_query_source if cheap>*
> Failing devices (sample): `<d1>, <d2>, <d3>`

Do not dump the `items` array. Do not show passing controls individually — just include them in the summary numerator.

If every failing control on a given platform trips the **same set of devices**, call that out explicitly — it usually means baseline configuration drift, not N independent findings.

If `api_errors > 0`, list the first 3 errors with their control path so the user can investigate.

Close with a next step phrased as a user prompt — not a command. Examples:
- *"To read the exact check behind a failure, ask: **Show me the source for `&lt;control-path&gt;`.**"* (handled by `forward-nqe-query`)
- *"To see the failing rows for one control, ask: **Run query &lt;FQ_id&gt; against network &lt;id&gt;.**"* (handled by `forward-nqe-query`)
- *"To expand from one platform to a full vendor audit, ask: **Run all Cisco STIGs for network &lt;id&gt;.**"* (this skill, `--limit-queries 0`)
```

See `references/interpreting-stig-results.md` for deeper interpretation rules.

## When to use

- "Run STIG compliance for network X"
- "Show me Cisco IOS Router STIG violations"
- "Audit our F5 devices"
- "How many STIGs do we fail network-wide?"

## When NOT to use

- Individual STIG control → `forward-nqe-query`
- Custom policy checks (not DISA STIGs) → write an NQE query via `forward-nqe-query`
- Non-security queries (L3, L2, Cloud, etc.) → `forward-nqe-query`

## Scripts

| Script | Purpose |
|---|---|
| `stig_sweep.py` | Run filtered STIG queries and aggregate pass/fail |

### stig_sweep.py

Runs a filtered subset of STIG queries sequentially, aggregates pass/fail.

```bash
# Preview which STIGs would run (does NOT execute)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-compliance-check/scripts/stig_sweep.py" \
    --vendor Cisco --platform "Cisco IOS Router RTR" --dry-run

# Run a sweep capped at 50 queries (safe default)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-compliance-check/scripts/stig_sweep.py" \
    --network-id NET_xyz --vendor Cisco --platform "Cisco IOS Router RTR"

# Full vendor audit — EXPLICITLY opt into all queries (slow!)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-compliance-check/scripts/stig_sweep.py" \
    --network-id NET_xyz --vendor Juniper --limit-queries 0
```

### Filters

| Flag | Effect |
|---|---|
| `--vendor V` | Match `/Security/STIGs/V/*` (e.g. `Cisco`, `Juniper`, `F5`, `Palo Alto Networks`) |
| `--platform P` | Match `/Security/STIGs/*/P/*` (exact platform name, e.g. `Cisco IOS Router RTR`) |
| `--path-contains S` | Additional substring filter on the full path |
| `--limit-queries N` | Cap total queries (default 50; `0` = no cap — explicit opt-in) |
| `--dry-run` | List matched STIGs, don't execute |

### Output shape

The script emits the weave skill envelope on stdout: `{"ok": true, "schema": 1, "data": ..., "meta": ...}` on success, `{"ok": false, "schema": 1, "error": {"code", "message", "hint?"}}` on failure. Exit code reflects whether the skill *ran*, not whether the data is clean — a sweep that finds violations still exits 0.

`meta` carries the run summary (counts, dialect mix); `data.results` holds the per-query records. A `--dry-run` puts the matched queries in `data.queries` and the `mode`/`matched`/`selected` counts in `meta`.

```json
{
  "ok": true,
  "schema": 1,
  "data": {
    "results": [
      {
        "path": "/Security/STIGs/Cisco/Cisco IOS Router RTR/CISC-RT-000400 V-216588",
        "queryId": "FQ_978e7fd839cb3656e0f57ae5e36aa72da713d454",
        "durationSec": 2.14,
        "rowCount": 3,
        "violationRowCount": 3,
        "detectionMethod": "rows-on-violation",
        "indicatorField": null,
        "items": [ { "...": "..." } ]
      },
      {
        "path": "/Security/STIGs/Palo Alto Networks/.../PANW-NM-000001",
        "queryId": "FQ_...",
        "durationSec": 1.82,
        "rowCount": 4,
        "violationRowCount": 0,
        "detectionMethod": "indicator-field",
        "indicatorField": "violation",
        "items": [ { "device": "fw01", "violation": false } ]
      }
    ]
  },
  "meta": {
    "matched": 60,
    "selected": 50,
    "executed": 50,
    "api_errors": 0,
    "queries_with_violations": 12,
    "total_violation_rows": 87,
    "dialects": { "rows-on-violation": 38, "indicator-field": 12 }
  }
}
```

On failure (e.g. filters match nothing, or creds are missing):

```json
{
  "ok": false,
  "schema": 1,
  "error": {
    "code": "EMPTY",
    "message": "no STIG queries matched your filters",
    "hint": "loosen --vendor/--platform/--path-contains, or run --dry-run to preview"
  }
}
```

Error codes: `EMPTY` (no STIGs matched), `NOT_FOUND` (catalog unavailable), `INPUT` (missing `--network-id` outside `--dry-run`), `AUTH` (missing/invalid creds).

See `references/interpreting-stig-results.md` for how to read these.

## Gotchas

- **Very slow**: 50 STIGs serially, ~2-5s each = 2-5 minutes. A full vendor sweep (950 Cisco STIGs) can take ~30 minutes. Warn the user before kicking off anything > 50.
- **Row count ≠ violation count**: each row is usually *one failing device*. Three rows across one query means three devices failed that control. The summary's `total_violation_rows` is a sum, not a distinct count.
- **Rows vary by query**: STIG queries return different column shapes. Don't assume a specific column exists — emit the row verbatim and let the caller interpret.
- **Opt-in full sweep**: `--limit-queries 0` is the only way to run everything. This is intentional — a default unbounded sweep would be a footgun.
- **Sequential, not parallel**: v1 runs STIGs one at a time. If throughput matters, split into multiple `stig_sweep.py` runs with different `--path-contains` filters and run them in separate shells.
