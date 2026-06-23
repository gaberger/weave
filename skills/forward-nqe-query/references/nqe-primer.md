# NQE Primer (for Claude)

A minimal primer for reasoning about NQE (Network Query Engine). This file is intentionally small — the **authoritative source of NQE syntax is the query catalog itself**. When writing or adapting a query, always inspect real sources first.

## What NQE is

- A functional-style query language over Forward's parsed network model.
- Runs against a **snapshot** — it's a point-in-time view of every device's state.
- Returns tabular data (columns + rows). Every query declares what columns it produces.
- Server-side execution; the client sends a POST and waits for the whole result.

## What NQE is NOT

- It is not SQL, not SPL/Splunk, not KQL. Don't try to translate from them.
- It is not a streaming language — no real-time, no subscriptions.
- It is not a write path — NQE cannot modify device state.

## The correct way to write a custom query

Do NOT attempt to write NQE from your training data — syntax has evolved and you will hallucinate. Instead:

```
1. search_catalog.py <keywords>                    # find a similar query
2. get_query_source.py --path <path> --head        # read its source
3. Adapt the source. Keep the same column shape where possible.
4. run_query.py --query-file adapted.nqe --limit 50
```

Step 2 gives you ground truth — the real, working syntax for the exact patterns you need.

## Common catalog categories (counts as of bundled snapshot)

| Category | Count | Typical use |
|---|---|---|
| `Security` | 1771 | STIG compliance checks by vendor/model (dominated by DISA STIGs) |
| `vendor-specific` | 22 | Vendor-peculiar state (e.g. Cisco SmartLicense) |
| `Interfaces` | 17 | Interface state, errors, descriptions |
| `L3` | 17 | Routing state: BGP, OSPF, static, route tables |
| `External` | 14 | External integrations |
| `Cloud` | 14 | AWS / Azure / GCP specifics |
| `Devices` | 9 | Device-level health, config snapshots |
| `L2` | 8 | VLANs, MAC, STP |
| `Hosts` | 4 | Hosts / endpoints |
| `Discovery` | 2 | Discovery status |

A query path like `/Security/STIGs/Cisco/Cisco IOS Router RTR/CISC-RT-000400 V-216588` is:
`<category>/<framework>/<vendor>/<platform>/<STIG control>`.

## Parameters

Some catalog queries take parameters (e.g. `deviceName`, `vrfName`). The parameter names and types are declared in the query source — always inspect before running:

```bash
get_query_source.py --path "/L3/..." --head    # look for a `parameters` block
run_query.py --query-id FQ_… --param deviceName=core-rtr-01
```

Parameter coercion in `run_query.py`:
- `true`/`false` → boolean
- pure digits → int
- digits with `.` → float
- everything else → string

Use `--params-json '{"foo": [1,2,3]}'` for anything more complex.

## Response shape

`run_query.py` returns the server's JSON verbatim. Typical shape:

```json
{
  "items": [ { "col1": "...", "col2": "..." }, ... ],
  "totalCount": 123,
  "hasMore": false
}
```

Do not rely on specific field names — different queries return different column sets. The structure is stable; the columns are query-defined.

## Anti-patterns to avoid

- Running a full-catalog STIG sweep without warning the user (30-120s on large networks).
- Setting `--limit 0` for exploratory queries — a dumped 10k-row result floods context.
- Assuming a catalog query works against any snapshot — some require specific vendors present.
- Writing custom NQE without first reading a real example from the catalog.
