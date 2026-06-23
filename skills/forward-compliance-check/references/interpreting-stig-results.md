# Interpreting STIG Results (for Claude)

STIG queries are **inverse** — they return rows for **failures**, not successes. A query that produces zero rows means every device in scope passed that control.

## Reading `stig_sweep.py` output

```json
{
  "summary": {
    "matched": 950,
    "selected": 50,
    "executed": 50,
    "api_errors": 0,
    "queries_with_violations": 12,
    "total_violation_rows": 87
  },
  "results": [
    {
      "path": "/Security/STIGs/Cisco/Cisco IOS Router RTR/CISC-RT-000400 V-216588",
      "queryId": "FQ_...",
      "durationSec": 2.14,
      "rowCount": 3,
      "violationRowCount": 3,
      "detectionMethod": "rows-on-violation",
      "indicatorField": null,
      "items": [ ... ]
    },
    ...
  ]
}
```

- `matched` — how many STIGs matched the filters, before the `--limit-queries` cap.
- `selected` — how many actually scheduled to run (may be < matched due to cap).
- `executed` — how many actually ran (should equal `selected` unless interrupted).
- `queries_with_violations` — count of controls where at least one device failed.
- `total_violation_rows` — sum of rows across all failing queries. **This is not a distinct device count** — it's (controls × violating devices). Don't report this as "87 violations" without context.

## What a "pass" looks like

- `rowCount: 0` and no `error`: the control passed network-wide in this snapshot.
- A control that returned no data for any device is **not the same** as a passing control if the STIG expects to find evidence of a configuration. Read the query source (`forward-nqe-query/get_query_source.py`) if you need to distinguish "none fail" from "nothing applies."

## What a "fail" looks like

- `rowCount > 0`: at least one device failed. Each item typically contains the device name + the offending setting.
- Devices that aren't in scope for the STIG (wrong vendor/platform) won't appear. The catalog filters by hierarchy, not the query itself.

## How to summarize for the user

For a `stig_sweep.py` result, a useful one-shot summary is:

```
Ran 50 Cisco IOS Router RTR STIGs in 2 min 17 s.
12/50 controls had at least one violation, spanning 87 device-control pairs.
Top offenders:
  - CISC-RT-000400 V-216588: 3 devices
  - CISC-RT-000600 V-216590: 2 devices
  ...
```

Compute "top offenders" by sorting `results` by `violationRowCount` descending and taking the top N.

## When to dig deeper

- A query with `error` needs inspection — could be a missing permission, a malformed STIG for your snapshot version, or a server-side timeout.
- A sweep with `queries_with_violations == executed` means *everything* failed — usually a filter bug (wrong vendor) or a snapshot that hasn't been processed.
- `total_violation_rows` spiking compared to a prior sweep usually means a config change made multiple devices fail the same set of controls at once.
