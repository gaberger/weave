# Reports (generated, not committed)

This directory holds **generated** Forward report artifacts (CVE audits, tables, diagrams).
They are point-in-time snapshots of live data, so they are **git-ignored** — regenerate them
rather than committing.

## Regenerate the prospect CVE-disposition report (network 212984)

```bash
# 1) Narrative (report_doc, compliance-audit template — proper section headings)
python3 skills/forward-vulnerability/scripts/cve_disposition.py --network-id 212984 \
  | python3 - <<'PY' \
  | python3 skills/forward-report-doc/scripts/render.py --format markdown --template compliance-audit \
  > docs/reports/cve-audit-212984.md
import json,sys
f=json.load(sys.stdin); s=f["summary"]; bd=s["byDisposition"]
print(json.dumps({"title":"CVE Disposition Audit — network 212984","sections":[
 {"title":"Scope","body":f"Forward evaluated {s['totalCvesEvaluated']} CVEs (snapshot {f['snapshotId']})."},
 {"title":"Findings","body":f"IMPACTED {bd['IMPACTED']} · POTENTIALLY_IMPACTED {bd['POTENTIALLY_IMPACTED']} · NOT_IMPACTED {bd['NOT_IMPACTED']} · NOT_EVALUATED {bd['NOT_EVALUATED']}; coverage {s['coveragePct']}%."},
]}))
PY

# 2) Filtered-out crit/high CVEs as a table (markdown or html)
python3 skills/forward-vulnerability/scripts/cve_disposition.py --network-id 212984 \
  --disposition not-impacted --severity CRITICAL --severity HIGH \
  | python3 - <<'PY' \
  | python3 skills/forward-report-table/scripts/render.py --format html --sort Severity \
  > docs/reports/cve-filtered-out-212984.html
import json,sys
a=json.load(sys.stdin); rows=[]
for c in a["cves"]:
    ob=(c.get("osBreakdown") or [{}])[0]
    rows.append({"CVE":c["cve"],"Severity":c["severity"],"Score":c.get("maxScore"),"OS":ob.get("os"),
                 "Devices":sum((ob.get("deviceCounts") or {}).values()),"Reason":c.get("reason")})
print(json.dumps(rows))
PY
```

Or just ask through chat: *"write up the CVE audit for network 212984 as a report and list the
filtered-out critical/high CVEs with their reasons"* — the `forward-report` skill does the same.
