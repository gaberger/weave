# Intent Check Creation - Examples and Troubleshooting

## Quick Start

### Example 1: Route Leak Prevention (Most Common)

**Scenario:** You just fixed a route leak between US, EU, and JP regions. Create checks to prevent regression.

**Step 1: Create regions config**
```bash
cat > regions.json <<EOF
{
  "US": {
    "loopbacks": "1.1.1.0/24",
    "internal": "10.200.0.0/16"
  },
  "EU": {
    "loopbacks": "2.2.2.0/24",
    "internal": "10.201.0.0/16"
  },
  "JP": {
    "loopbacks": "3.3.3.0/24",
    "internal": "10.202.0.0/16"
  }
}
EOF
```

**Step 2: Create checks**
```bash
python3 create_intent_checks.py \
  --network-id 863 \
  --preset route-leak-prevention \
  --config regions.json
```

**What gets created:** 12 isolation checks
- US loopbacks → EU isolation
- US internal → EU isolation
- US loopbacks → JP isolation
- US internal → JP isolation
- EU loopbacks → US isolation
- EU internal → US isolation
- EU loopbacks → JP isolation
- EU internal → JP isolation
- JP loopbacks → US isolation
- JP internal → US isolation
- JP loopbacks → EU isolation
- JP internal → EU isolation

---

### Example 2: BGP Session Connectivity

**Scenario:** You activated new links between border routers. Create checks to monitor BGP connectivity.

**Step 1: Create border routers config**
```bash
cat > border-routers.json <<EOF
{
  "us-border-1": "1.1.1.1",
  "eu-border-1": "2.2.2.1",
  "jp-border-1": "3.3.3.1"
}
EOF
```

**Step 2: Create checks**
```bash
python3 create_intent_checks.py \
  --network-id 863 \
  --preset bgp-sessions \
  --config border-routers.json
```

**What gets created:** 6 existential checks (bidirectional)
- us-border-1 → eu-border-1 BGP session (TCP 179)
- eu-border-1 → us-border-1 BGP session (TCP 179)
- us-border-1 → jp-border-1 BGP session (TCP 179)
- jp-border-1 → us-border-1 BGP session (TCP 179)
- eu-border-1 → jp-border-1 BGP session (TCP 179)
- jp-border-1 → eu-border-1 BGP session (TCP 179)

---

### Example 3: Single Custom Check

**Scenario:** You want to verify specific traffic is blocked.

```bash
python3 create_intent_checks.py \
  --network-id 863 \
  --type Isolation \
  --name "US DMZ → EU internal isolation" \
  --src-ip 192.168.100.0/24 \
  --dst-ip 10.201.0.0/16 \
  --priority HIGH \
  --note "DMZ traffic should not reach EU internal network"
```

---

## Troubleshooting

### Issue 1: "No hosts matching the alias"

**Error:**
```
❌ Failed to create check: HTTP 400 - "No hosts matching the alias: ..."
```

**Cause:** Forward Networks intent checks require host aliases to be defined in the network model. This is common in:
- Virtual lab environments (EVE-NG, CML, netlab)
- Networks without device aliases configured
- New networks without full discovery

**Solution A: Configure host aliases in Forward UI**
1. Navigate to Network Settings
2. Add device aliases for source/destination IPs
3. Re-run check creation

**Solution B: Use NQE-based compliance checks instead**

For route leak prevention, create an NQE query that detects missing route-maps:

```graphql
// Detect eBGP neighbors without route-maps
foreach device in network.devices
where device.name matches /.*-border-.*/
select {
  device: device.name,
  neighbor: bgpNeighbor.neighborAddress,
  missingRouteMap: true
}
from bgpNeighbor in device.bgp.neighbors
where bgpNeighbor.peerType == "EBGP" &&
      !bgpNeighbor.outboundRouteMap
```

Save this as a custom NQE query and run on every snapshot.

**Solution C: Use validate_all.py for manual validation**

Instead of automated intent checks, run validation after each snapshot:
```bash
python3 validate_all.py \
  --network-id 863 \
  --snapshot-id <NEW_ID> \
  --config validation_matrix.yml
```

---

### Issue 2: Checks created but showing FAIL

**Symptom:** All checks created successfully, but they're in FAIL state.

**Cause:** The current snapshot may still have the issue (e.g., route leak still exists).

**Solution:**
1. Verify your fix is actually applied:
   ```bash
   python3 validate_all.py --network-id 863 --config validation_matrix.yml
   ```

2. Check snapshot state:
   ```bash
   python3 forward-inventory/list_snapshots.py --network-id 863 --limit 5
   ```
   Ensure snapshot state is `PROCESSED` and `advancedReachabilityState` is `PROCESSED`.

3. If fix is applied but checks still fail:
   - Check IP ranges in config file (typos?)
   - Verify snapshot ID (using correct snapshot?)
   - Check Forward UI for check details

---

### Issue 3: Too many checks created

**Symptom:** `route-leak-prevention` preset creates 12+ checks, cluttering the UI.

**Solution:** Create selective checks instead of comprehensive:

```bash
# Only block US → EU
python3 create_intent_checks.py --network-id 863 \
  --type Isolation \
  --name "US → EU isolation" \
  --src-ip 10.200.0.0/16 \
  --dst-ip 10.201.0.0/16 \
  --priority HIGH

# Only block EU → US
python3 create_intent_checks.py --network-id 863 \
  --type Isolation \
  --name "EU → US isolation" \
  --src-ip 10.201.0.0/16 \
  --dst-ip 10.200.0.0/16 \
  --priority HIGH
```

---

### Issue 4: Checks not re-evaluating on new snapshots

**Symptom:** Created checks with `--persistent true` but they don't re-evaluate.

**Cause:** Check may be disabled or snapshot not fully processed.

**Solution:**
1. Verify check is enabled in Forward UI
2. Check snapshot processing state:
   ```bash
   python3 forward-inventory/list_snapshots.py --network-id 863 --limit 1
   ```
3. Manually trigger check evaluation (Forward UI)

---

## Best Practices

### 1. Start Small
Don't create all checks at once. Start with 2-3 critical checks:
- One isolation check (route leak prevention)
- One existential check (BGP session connectivity)

Verify they work before creating more.

### 2. Use Descriptive Names
Good: `"US loopbacks → EU isolation"`
Bad: `"check1"`

Names appear in alerts - make them actionable.

### 3. Set Appropriate Priorities
- **HIGH**: Isolation checks (security/policy violations)
- **MEDIUM**: Existential checks (functional connectivity)
- **LOW**: Nice-to-have validations

Priority affects alert routing in monitoring systems.

### 4. Document Why
Always use `--note` to explain check purpose:
```bash
--note "Prevents route leaks after 2026-05-12 incident (snapshot 2047)"
```

Future you (or your successor) will thank you.

### 5. Test Before Production
Create checks on a test snapshot first:
```bash
python3 create_intent_checks.py \
  --network-id 863 \
  --snapshot-id 2057 \
  --type Isolation \
  ...
```

Verify they pass/fail as expected before making persistent.

---

## When to Create Checks

### ✅ CREATE CHECKS:
- After fixing a route leak
- After activating a new link
- After adding BGP sessions
- After changing ACLs/firewall rules
- After network segmentation changes
- After compliance remediation

### ❌ DON'T CREATE CHECKS:
- For one-off investigations
- For temporary test scenarios
- When topology is rapidly changing
- Before understanding the issue

---

## Alternative Approaches

If intent checks don't work for your environment:

### Approach 1: NQE-based Compliance Checks
Create custom NQE queries that detect configuration errors:
- Missing route-maps on eBGP sessions
- ACL missing from interfaces
- BGP sessions in wrong VRF
- Etc.

Run queries on every snapshot via automation.

### Approach 2: Config Diff Monitoring
Compare snapshot configs and alert on specific changes:
```bash
python3 forward-nqe-query/diff_query.py \
  --network-id 863 \
  --before-snapshot 2057 \
  --after-snapshot 2058 \
  --query-id FQ_bgp_config
```

Alert if route-maps are removed.

### Approach 3: Manual Validation
Run `validate_all.py` as part of change workflow:
```bash
# In CI/CD pipeline after config push
python3 validate_all.py \
  --network-id 863 \
  --config validation_matrix.yml || exit 1
```

---

## Reference: Check Types

### Isolation Checks
**Purpose:** Verify traffic IS blocked  
**Use for:** Route leak prevention, segmentation, security policy  
**Example:** US internal prefixes should NOT reach EU

### Existential Checks
**Purpose:** Verify traffic IS allowed  
**Use for:** Connectivity validation, service availability  
**Example:** BGP sessions (border routers should reach each other)

### Priority Levels
- **HIGH:** Critical security/policy violations (e.g., route leaks)
- **MEDIUM:** Functional connectivity (e.g., BGP sessions)
- **LOW:** Nice-to-have validations (e.g., backup paths)

---

## FAQ

**Q: How long does check creation take?**  
A: 10-60 seconds per check (depends on network size). Creating 12 checks = ~5 minutes.

**Q: Do checks cost API calls?**  
A: Yes. Each check creation + each re-evaluation = 1 API call. Plan accordingly.

**Q: Can I bulk-delete checks?**  
A: Use `forward-intent-check/list_checks.py` + `delete_check.py` in a loop.

**Q: How do I know if a check is working?**  
A: Check should PASS on snapshot where issue is fixed, FAIL on snapshot where issue exists.

**Q: What happens if Forward UI changes?**  
A: These scripts use Forward API v4. Future API changes may require updates.

---

## Getting Help

If checks aren't working:
1. Check this troubleshooting guide
2. Verify environment variables (FORWARD_API_KEY, etc.)
3. Check Forward UI for check details
4. Run with `--debug` flag (when available)
5. Check Forward documentation
6. Contact Forward support

---

**Remember:** Intent checks are continuous monitoring. Create them AFTER fixing an issue to prevent regression, not BEFORE discovering the issue.
