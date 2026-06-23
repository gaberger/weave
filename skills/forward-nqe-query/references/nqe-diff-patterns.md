# NQE Diff Patterns — Change Detection Workflows

NQE diff is Forward's **temporal query primitive** — it compares query results between two snapshots and identifies ADDED, DELETED, and MODIFIED rows. This guide covers common patterns and workflows.

## Core concept: ChangeType annotation

When you run `diff_query.py`, the API injects a `ChangeType` column into every result row:

| ChangeType | Meaning |
|---|---|
| `ADDED` | Row appears in 'after' snapshot but NOT in 'before' |
| `DELETED` | Row appears in 'before' snapshot but NOT in 'after' |
| `MODIFIED` | Row exists in both snapshots but at least one value changed |

**Key insight:** The API computes this server-side by comparing row *identity* (primary key fields) and *values* (data fields). You don't have to manually JOIN or diff — Forward handles it.

## Pattern 1: Root cause analysis (troubleshooting)

**Scenario:** "It worked at 9am, broke at 10am — what changed?"

**Workflow:**
1. Identify the "last known good" snapshot (before 9am)
2. Identify the "broken" snapshot (after 10am)
3. Run diff on relevant queries (interfaces, BGP, routes, ACLs)
4. Filter to DELETED and MODIFIED rows
5. Investigate devices/configs that changed

**Example: Interface outage**

```bash
# Compare interface status before/after
diff_query.py --query-id FQ_interface_status \
    --before-snapshot <good> --after-snapshot <broken> \
    --change-type DELETED --change-type MODIFIED
```

**What to look for:**
- **DELETED interfaces** = went down (status changed from up to down)
- **MODIFIED interfaces** = speed/duplex/errors changed
- Large number of changes on one device = device-specific issue
- Changes across multiple devices = network-wide event (routing, spanning-tree)

**Next steps:**
- For DELETED interfaces: `forward-device-config` to check if interface was `shutdown`
- For MODIFIED with errors: `forward-nqe-query` to pull error counters detail
- For routing-related: `diff_query.py` on routing table or BGP neighbors

---

## Pattern 2: Change validation (maintenance window)

**Scenario:** "We applied configs at 2am — did they take effect correctly?"

**Workflow:**
1. Snapshot before change window (baseline)
2. Snapshot after change window (result)
3. Diff on queries that should reflect the changes
4. Verify ADDED/MODIFIED rows match expectations
5. Flag unexpected DELETED rows (regressions)

**Example: VLAN addition**

```bash
# Compare VLAN list before/after maintenance
diff_query.py --query-id FQ_vlan_list \
    --before-snapshot <pre-change> --after-snapshot <post-change>
```

**What to validate:**
- **ADDED VLANs** = new VLANs you intended to create
- **MODIFIED VLANs** = name/description changes you intended
- **DELETED VLANs** = VLANs you intended to remove (or regressions if unexpected)

**Red flags:**
- ADDED rows you didn't expect = typo in config, wrong device
- DELETED rows you didn't expect = config overwrite, rollback
- Zero ADDED rows when you expected changes = config didn't apply

**Next steps:**
- If changes missing: `forward-device-config` to check if config was committed
- If unexpected changes: `diff_query.py` on device config or running-config-hash
- If validation passes: create `forward-intent-check` to monitor for drift

---

## Pattern 3: Drift detection (over time)

**Scenario:** "What's changing in our network week over week?"

**Workflow:**
1. Compare snapshots days/weeks apart
2. Run diff on baseline queries (devices, routes, VLANs, ACLs)
3. Identify patterns: growth, churn, configuration drift
4. Prioritize investigation based on change volume

**Example: Routing table churn**

```bash
# Compare routes Monday vs. Friday
diff_query.py --query-id FQ_routing_table \
    --before-snapshot <monday> --after-snapshot <friday> \
    --sort-by-change
```

**What to look for:**
- **High ADDED/DELETED count** = routing instability (flapping, BGP issues)
- **High MODIFIED count** = metric/next-hop changes (ECMP rebalancing)
- **Consistent ADDED routes** = network growth (new subnets, branches)
- **Consistent DELETED routes** = network contraction (decommissioning)

**Interpretation:**
- 10-20% churn = normal (BGP route updates, link flaps)
- 50%+ churn = investigate (major routing event, config change)
- 100% churn (all routes MODIFIED) = device reboot or process restart

**Next steps:**
- High churn: `diff_query.py` on BGP neighbors to check peer stability
- Unexpected DELETED routes: `forward-path-analysis` to check reachability impact
- Growth trends: plan capacity expansion

---

## Pattern 4: Regression detection (security/policy)

**Scenario:** "Did any security controls get weakened?"

**Workflow:**
1. Baseline snapshot (known-good security posture)
2. Current snapshot
3. Diff on security-relevant queries (ACLs, firewall rules, open services)
4. Filter to DELETED or MODIFIED rows
5. Investigate if weakening was intentional

**Example: ACL deny rule count**

```bash
# Compare ACL deny counts before/after
diff_query.py --query-id FQ_acl_deny_count \
    --before-snapshot <baseline> --after-snapshot <current> \
    --change-type MODIFIED
```

**What to look for:**
- **MODIFIED with decreased deny count** = ACL rules removed (potential regression)
- **DELETED ACLs** = entire ACL removed (major regression)
- **ADDED permit rules** = new access granted (review for over-permissiveness)

**Red flags:**
- Deny count dropped to zero = ACL disabled or removed
- Permit count increased significantly = broad access grant
- Firewall rule order changed = shadowing or bypass risk

**Next steps:**
- For regressions: `forward-device-config` to see exact ACL changes
- For exploitability: `forward-path-analysis` to check if new paths exist
- For enforcement: `forward-intent-check` Isolation check to ensure blocking holds

---

## Pattern 5: Compliance drift (policy violations)

**Scenario:** "Did new devices appear that violate our baseline?"

**Workflow:**
1. Baseline snapshot (compliant state)
2. Current snapshot
3. Diff on compliance queries (SSH config, SNMP, AAA, NTP)
4. Filter to ADDED rows
5. Remediate new violators

**Example: Non-standard SSH configuration**

```bash
# Compare devices with non-standard SSH
diff_query.py --query-id FQ_ssh_non_standard \
    --before-snapshot <baseline> --after-snapshot <current> \
    --change-type ADDED
```

**What to look for:**
- **ADDED devices** = new devices with policy violations
- **DELETED devices** = violations remediated (good!)
- **MODIFIED devices** = configuration drifted from compliant to non-compliant

**Response:**
- ADDED violators: immediate remediation (config push, change control)
- High ADDED count: onboarding process isn't enforcing baseline
- Pattern of ADDED then DELETED: manual drift then manual fix (automate!)

**Next steps:**
- For ADDED violators: `forward-device-config` to get config snippet
- For remediation: generate config stanzas, validate with `forward-predict`
- For prevention: document baseline, add to onboarding checklist, create `forward-intent-check` NQE check

---

## Advanced patterns

### Pattern 6: Cross-query correlation

**Scenario:** "BGP peers went down — did routes disappear?"

**Workflow:**
1. Diff BGP neighbor query → identify DELETED peers
2. Diff routing table query → identify DELETED routes
3. Correlate: do deleted routes correspond to peer IPs?

```bash
# Step 1: Which BGP peers went down?
diff_query.py --query-id FQ_bgp_neighbors \
    --before-snapshot <before> --after-snapshot <after> \
    --change-type DELETED

# Step 2: Which routes disappeared?
diff_query.py --query-id FQ_routing_table \
    --before-snapshot <before> --after-snapshot <after> \
    --change-type DELETED
```

**Analysis:** If peer X went down and routes via X disappeared, that's expected. If routes disappeared but peers are up, that's a routing protocol issue (filters, policy).

### Pattern 7: Device-scoped diff

**Scenario:** "What changed on device rtr-01 specifically?"

**Workflow:**
1. Run diff on a query with parameters scoped to the device
2. Or post-process results to filter to that device

```bash
# If query supports deviceName parameter
diff_query.py --query-id FQ_device_config_hash \
    --before-snapshot <before> --after-snapshot <after> \
    --params '{"deviceName": "rtr-01"}'
```

**Use case:** Targeted troubleshooting after a device reload or config push.

### Pattern 8: Diff-then-path-trace

**Scenario:** "ACLs changed — is reachability still intact?"

**Workflow:**
1. Diff ACL query → identify MODIFIED ACLs
2. For each modified ACL, use `forward-path-analysis` to check if critical flows still work
3. Or create `forward-intent-check` Existential checks to continuously monitor

```bash
# Step 1: Which ACLs changed?
diff_query.py --query-id FQ_acl_list \
    --before-snapshot <before> --after-snapshot <after> \
    --change-type MODIFIED

# Step 2: Trace critical flows (example)
forward-path-analysis --network-id NET_xyz \
    --src-ip 10.1.2.3 --dst-ip 10.5.0.10 --dst-port 443
```

**Analysis:** If flow now drops after ACL change, that's a regression. If flow still works, change was safe.

---

## Filtering and sorting strategies

### Filter by ChangeType

**Show only additions:**
```bash
diff_query.py ... --change-type ADDED
```

**Show only removals:**
```bash
diff_query.py ... --change-type DELETED
```

**Show changes and removals (exclude additions):**
```bash
diff_query.py ... --change-type DELETED --change-type MODIFIED
```

**Use case:** Focus on regressions (DELETED = something went away, MODIFIED = something changed).

### Sort by ChangeType

```bash
diff_query.py ... --sort-by-change
```

Groups results: ADDED, then DELETED, then MODIFIED. Useful for quickly scanning change categories.

### Combine with column filters

The API supports filtering on other columns too (not just ChangeType). Example:

```bash
# Show only MODIFIED rows where status != "up"
diff_query.py --query-id FQ_interface_status \
    --before-snapshot <before> --after-snapshot <after> \
    --change-type MODIFIED
# Then post-process JSON to filter status field
```

---

## Interpretation guidelines

### High change volume

| Change % | Interpretation | Action |
|---|---|---|
| < 10% | Normal churn (routing updates, ephemeral state) | Monitor |
| 10-50% | Significant change (config push, device reload) | Investigate |
| 50-90% | Major event (network reconfiguration, outage) | Root cause analysis |
| > 90% | Entire dataset changed (device migration, protocol restart) | Verify intentional |

### ChangeType patterns

| Pattern | Meaning | Example |
|---|---|---|
| All ADDED | New data appeared | New devices onboarded, new routes learned |
| All DELETED | Data disappeared | Devices down, routes withdrawn |
| Mix of all three | Complex change | Config push with adds/removes/modifications |
| High MODIFIED, low ADDED/DELETED | In-place updates | Metric changes, description updates |

### Zero changes

If `diff_query.py` returns zero rows:
- **Good:** Network is stable (for drift detection)
- **Bad:** Change didn't apply (for change validation)
- **Ambiguous:** Query doesn't capture the changed aspect (wrong query)

**Debugging zero-change results:**
1. Verify snapshots are different (check timestamps)
2. Run the query on each snapshot individually to see raw results
3. Check if query's WHERE clause filters out the changes
4. Try a broader query (e.g., entire config instead of one feature)

---

## Best practices

### 1. Choose the right query

- **Too broad:** "all device configs" → thousands of MODIFIED rows (noise)
- **Too narrow:** "BGP on device X" → might miss related changes on device Y
- **Just right:** "BGP neighbors network-wide" → focused on the relevant protocol

**Rule of thumb:** Start broad (category-level queries), narrow based on results.

### 2. Baseline early

For drift detection, establish a "known-good" baseline snapshot:
- After initial network deployment
- After major migration completes
- After successful audits/compliance validation

Store the snapshot ID for future comparisons.

### 3. Automate periodic diffs

Set up scheduled diffs for key queries:
- Weekly routing table diff (detect route churn)
- Daily security policy diff (detect unauthorized changes)
- Hourly interface status diff (detect flapping)

Use the results to feed alerting systems.

### 4. Combine with other skills

**NQE diff is the "what changed" primitive.** Chain it with:
- `forward-device-config` → "show me the config that changed"
- `forward-path-analysis` → "is reachability impacted?"
- `forward-intent-check` → "create a check to prevent this regression"
- `forward-predict` → "simulate a fix and diff the predicted state"

### 5. Document expected changes

For change windows, document expected ADDED/DELETED/MODIFIED rows:
- VLAN 100 should appear (ADDED)
- BGP peer 10.1.2.3 should go down (DELETED)
- Interface descriptions should update (MODIFIED)

Post-change, verify the diff matches expectations. Unexpected rows = investigation needed.

---

## Common queries to diff

| Query type | Purpose | ChangeType focus |
|---|---|---|
| Interface status | Detect flapping, outages | DELETED (down), MODIFIED (errors) |
| BGP neighbors | Detect peer instability | DELETED (peers down), MODIFIED (state change) |
| Routing table | Detect route churn, convergence issues | ADDED/DELETED (routes appear/disappear) |
| VLAN list | Validate VLAN changes | ADDED (new VLANs), DELETED (removed VLANs) |
| ACL rules | Detect security regressions | DELETED (rules removed), MODIFIED (rules changed) |
| Device list | Detect new/removed devices | ADDED (onboarding), DELETED (decommissioning) |
| Config hash | Detect any config change | MODIFIED (config changed) |
| Running services | Detect new/disabled services | ADDED (service enabled), DELETED (service disabled) |

---

## Gotchas

### 1. Row identity (primary key)

NQE diff uses the query's implicit row identity to match rows between snapshots. If the query doesn't have a stable primary key, results can be misleading.

**Example:**
```nqe
foreach device in network.devices
select {
    name: device.name,
    interfaceCount: count(device.interfaces)
}
```

This query's row identity is `device.name`. If `interfaceCount` changes, the row is MODIFIED. If a device is added, the row is ADDED.

**Problem:** If the query returns unsorted results or uses timestamps, rows might appear as DELETED+ADDED instead of MODIFIED.

**Solution:** Ensure queries have stable identifiers (device name, interface name, etc.).

### 2. Large datasets

Diffing a query that returns 10,000 rows in each snapshot can be slow and produce massive change sets.

**Solution:**
- Use `--limit` to cap results (default 1000)
- Use `--change-type` to filter to only interesting changes
- Consider narrower queries (per-device, per-category)

### 3. Snapshot timing

If snapshots are taken seconds apart, you might see noise from:
- Ephemeral state (ARP, MAC tables)
- Metrics that fluctuate (packet counts, CPU)
- Transient routing updates

**Solution:** Compare snapshots that are meaningfully different (before/after change windows, day-to-day, week-to-week). Avoid diffing consecutive snapshots for high-churn data.

### 4. Query version drift

If the query definition changed between the two snapshots, the diff might be invalid.

**Solution:** Use `--commit-id` to pin to a specific query version, or ensure the query hasn't been modified.

---

## Example: Full troubleshooting workflow

**Scenario:** Production reports database unreachable as of 10:30am.

**Step 1: Identify snapshots**
```bash
# Last known good: 10:00am (snapshot 1234)
# Current broken: 10:45am (snapshot 1235)
```

**Step 2: Diff interface status**
```bash
diff_query.py --query-id FQ_interface_status \
    --before-snapshot 1234 --after-snapshot 1235 \
    --change-type DELETED --change-type MODIFIED
```

**Result:** No interface changes. Not a link failure.

**Step 3: Diff BGP neighbors**
```bash
diff_query.py --query-id FQ_bgp_neighbors \
    --before-snapshot 1234 --after-snapshot 1235 \
    --change-type DELETED --change-type MODIFIED
```

**Result:** No BGP changes. Not a routing failure.

**Step 4: Diff routing table**
```bash
diff_query.py --query-id FQ_routing_table \
    --before-snapshot 1234 --after-snapshot 1235 \
    --change-type DELETED | jq '.items[] | select(.prefix | contains("10.5.0.0"))'
```

**Result:** Route to DB subnet (10.5.0.0/24) was DELETED at 10:25am.

**Step 5: Investigate route deletion**
```bash
# Which device had the route?
forward-device-config --device <device-from-step-4> --search "10.5.0.0"
```

**Result:** Static route was removed in a config push.

**Step 6: Validate fix**
```bash
# Re-add static route, collect new snapshot (1236)
diff_query.py --query-id FQ_routing_table \
    --before-snapshot 1235 --after-snapshot 1236 \
    --change-type ADDED | jq '.items[] | select(.prefix | contains("10.5.0.0"))'
```

**Result:** Route re-appeared (ADDED). Reachability restored.

**Step 7: Create check to prevent regression**
```bash
forward-intent-check create --type Existential \
    --name "Prod → DB reachability" \
    --src-ip 10.1.0.0/16 --dst-ip 10.5.0.10 --dst-port 5432
```

**Outcome:** Root cause identified (config error), fix validated (route restored), prevention automated (intent check).

---

NQE diff is the **temporal lens** over your network. Use it to answer "what changed?" and "is this change safe?" — the two questions at the heart of every operational workflow.
