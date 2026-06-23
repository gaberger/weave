# Playbook Design Guide

Effective operational playbooks bridge the gap between individual Forward capabilities and complete incident response workflows. This guide teaches you how to design playbooks that accelerate detection, triage, remediation, and prevention.

---

## Core Principles

### 1. Role-Based Organization

Structure playbooks by operational tier:

| Tier | Role | Expertise | Time Budget | Decision Authority |
|---|---|---|---|---|
| **L1** | NOC Operator | Alert response | 5 minutes | Escalate or close |
| **L2** | Network Engineer | Analysis & diagnosis | 10 minutes | Recommend remediation |
| **L3** | Senior Network Engineer | Fix implementation | 15 minutes | Emergency change approval |
| **L4** | Network Architect | Prevention design | Ongoing | Long-term strategy |

**Why:** Each tier has different skills, access levels, and decision-making authority. Playbooks should respect these boundaries.

---

### 2. Evidence-Driven Progression

Every step should produce observable evidence:

```
Alert → Validate (evidence: command output) → Analyze (evidence: root cause) → 
Fix (evidence: config change) → Verify (evidence: new snapshot)
```

**Bad example:**
```
"Check if route-map is missing"  ← No guidance on HOW to check
```

**Good example:**
```
Run: get_config.py --device X --category ebgp_advr_routes
Expected: 2 prefixes
If you see >2: ESCALATE (evidence of leak)
```

---

### 3. Time Boxing

Set explicit time targets for each phase:

- **L1 Triage:** 5 minutes (validate + escalate)
- **L2 Analysis:** 10 minutes (root cause + impact)
- **L3 Remediation:** 15 minutes (fix + validate)
- **Total MTTR:** 30 minutes (for P1 incidents)

**Why:** Time pressure focuses attention. If L2 analysis exceeds 10 minutes, either the playbook is incomplete or the incident is more complex than expected.

---

### 4. Clear Escalation Triggers

Don't say "escalate if bad" — define "bad" objectively:

**Vague:**
```
Escalate if this looks serious
```

**Specific:**
```
Escalate to L2 if:
- Internal management IPs (1.1.1.0/24) are leaked
- OR external AS can route to leaked IPs
- OR production traffic is impacted
```

---

### 5. Validation Checkpoints

After every action, verify success:

| Phase | Action | Validation |
|---|---|---|
| **L1 Triage** | Count advertised prefixes | Expected: 2, Actual: 5 → FAIL |
| **L2 Analysis** | Run path analysis | forwardingOutcome: DELIVERED → FAIL |
| **L3 Fix** | Add route-map | BGP session up + only 2 routes → PASS |
| **L4 Prevention** | Deploy intent check | Check fires on next snapshot → PASS |

**Format:** Always use ✅ PASS / ❌ FAIL / ⚠️ WARN markers.

---

## Playbook Structure

### Section 1: Header

```markdown
# NOC Playbook: <Incident Type>

**Incident Type:** <type>
**Network:** <network-name> (<id>)
**Scenario:** <1-sentence description>
**Severity Classification:** <P0-P4>
```

**Why:** Responders need to know what this playbook covers and when to use it.

---

### Section 2: Timeline

```markdown
## Incident Timeline & Escalation

```
T+0:00  [L1 NOC] Alert received
T+0:05  [L1 NOC] Escalate to L2
T+0:15  [L2 NetEng] Escalate to L3
T+0:30  [L3 Sr.NetEng] Fix validated
```
```

**Why:** Sets expectations. If you're at T+20 and still in L2 analysis, you're behind schedule.

---

### Section 3: L1 NOC Triage

**Goal:** Validate alert and escalate with evidence

**Steps:**
1. **Receive Alert** — show alert format, channel, payload
2. **Initial Validation** — run 1-2 commands to confirm not false positive
3. **Assess Severity** — checklist for P0/P1/P2/P3/P4
4. **Escalate** — message template with all evidence

**Time Target:** 5 minutes

**Example:**
```markdown
### Step 2: Initial Validation (2 minutes)

**Command:**
```bash
python3 ".../get_config.py" --device us-border-1 --category ebgp_advr_routes
```

**Expected:** 2 prefixes
**If you see 5+ prefixes:** ESCALATE (evidence of leak)

**L1 Observation:**
```
CONFIRMED: us-border-1 advertising 5 prefixes instead of 2
Leaked: 1.1.1.1/32, 1.1.1.2/32, 1.1.1.3/32
```
```

---

### Section 4: L2 NetEng Analysis

**Goal:** Identify root cause and recommend remediation

**Steps:**
1. **Receive Escalation** — understand what L1 found
2. **Deep Dive** — 3-5 analysis commands
3. **Impact Assessment** — who is affected? what's reachable?
4. **Root Cause** — what config is wrong?
5. **Escalate** — provide remediation plan to L3

**Time Target:** 10 minutes

**Example:**
```markdown
### Step 7: Test Reachability (2 minutes)

**Command:**
```bash
python3 ".../search_path.py" --src-ip 2.2.2.1 --dst-ip 1.1.1.1
```

**Expected:**
```json
{"forwardingOutcome": "UNREACHABLE"}
```

**If DELIVERED:** ⚠️ **CRITICAL** — external AS can reach internal management plane
**Severity Escalation:** P2 → P1
```

---

### Section 5: L3 Sr.NetEng Remediation

**Goal:** Apply fix and validate

**Steps:**
1. **Receive Escalation** — review remediation plan
2. **Approve Change** — document change request
3. **Apply Fix** — show CLI commands with expected output
4. **Trigger Snapshot** — collect new snapshot
5. **Validate** — 4-5 validation checks (config, BGP table, reachability, etc.)
6. **Escalate to L4** — request prevention strategy

**Time Target:** 15 minutes

**Example:**
```markdown
### Step 12: Apply Fix (5 minutes)

**CLI Commands:**
```cisco
configure
router bgp 4259840100
 address-family ipv4
  neighbor 10.0.0.6 route-map BLOCK_INT_ROUTES-ipv4 out
end
clear ip bgp 10.0.0.6 out
write memory
```

**Verify:**
```cisco
show ip bgp summary | grep 10.0.0.6
```

**Expected:** Prefix count reduced from 5 to 2

**✅ PASS** / **❌ FAIL**
```

---

### Section 6: L4 NetArch Prevention

**Goal:** Deploy automation to prevent recurrence

**Steps:**
1. **Post-Incident Review** — what went wrong?
2. **Deploy Tags** — categorize devices by role
3. **Create Intent Checks** — continuous monitoring
4. **Configure Alerting** — route to appropriate channels
5. **Continuous Improvement** — pre-commit hooks, baselines, checklists

**Time Target:** Ongoing (30 minutes to deploy initial checks)

**Example:**
```markdown
### Step 18: Create Intent Checks

**Intent Check: eBGP Route-Map Enforcement**

Verify all eBGP neighbors on "ebgp-speaker" tagged devices have outbound route-maps.

**Deploy via Forward UI** (intent checks not yet API-exposed)

**Alert on:** CRITICAL failures → Slack #network-alerts + PagerDuty
```

---

### Section 7: Quick Reference Cards

One-page summaries for each tier:

```markdown
### L1 NOC Card

**When you see:** Intent check failure alert

**Do this:**
1. Run advertised routes query
2. Count prefixes (expected vs actual)
3. Escalate if internal IPs leaked

**Commands:**
```bash
get_config.py --device X --category ebgp_advr_routes
```
```

**Why:** Printable cards for NOC desks or SOC dashboards.

---

### Section 8: Success Criteria

```markdown
## Success Criteria

### Operational Excellence
- [ ] L1 can triage in < 5 minutes
- [ ] L2 can analyze in < 10 minutes
- [ ] L3 can remediate in < 15 minutes
- [ ] MTTR < 30 minutes

### Training Goals
- [ ] All L1 trained on alert triage
- [ ] Quarterly incident drills
```

**Why:** Measurable targets for continuous improvement.

---

## Evidence Quality Ratings

Use ⭐ ratings (1-5) to indicate reliability:

| Rating | Meaning | Example |
|---|---|---|
| ⭐⭐⭐⭐⭐ | Smoking gun | Device config shows exact issue |
| ⭐⭐⭐⭐ | Strong evidence | BGP table confirms leak |
| ⭐⭐⭐ | Good indicator | Path analysis shows reachability |
| ⭐⭐ | Weak signal | Aggregated query (vendor-specific) |
| ⭐ | Circumstantial | Indirect observation |

**Use ⭐⭐⭐⭐+ for P1 escalation decisions.**

**Example:**
```markdown
### Method 1: Check Advertised Routes (⭐⭐⭐⭐⭐)

**Why 5 stars:** Device CLI output is ground truth. If BGP table shows 5 routes advertised, they ARE advertised.

**Command:** get_config.py --category ebgp_advr_routes
```

---

## Known Pitfalls Section

Document vendor-specific limitations and workarounds discovered during real scenarios:

**Example:**
```markdown
### ⚠️ Known Pitfalls (from scenario testing)

**DO NOT rely on:**
- ❌ NQE catalog "Advertised Prefix Count" — shows 0 for Arista EOS devices
- ❌ Security matrix without external zones — won't catch cross-AS leaks
- ❌ BGP session status alone — session can be up while leaking routes

**DO use:**
- ✅ Device config category `ebgp_advr_routes` (ground truth)
- ✅ Path analysis to confirm exploitability
- ✅ Config grep for missing route-maps
```

**Why:** Prevents wasted time on methods that don't work.

---

## Command Formatting

Always show:
1. **Full command** with absolute path (for copy-paste)
2. **Expected output** (so responder knows what "good" looks like)
3. **Decision criteria** (when to escalate, when to proceed)

**Example:**
```markdown
**Command:**
```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-device-config/scripts/get_config.py" \
  --snapshot-id 1525 \
  --device us-border-1 \
  --category ebgp_advr_routes
```

**Expected Output:**
```
show ip bgp neighbors 10.0.0.6 advertised-routes
...
Total: 2 routes
```

**Decision:**
- If 2 routes: ✅ PASS (no leak)
- If >2 routes: ❌ FAIL → ESCALATE to L2
```

---

## Multi-Method Validation

For P1 incidents, use 3-6 independent detection methods:

**Example: Route Leak Detection**
1. **Device config** (⭐⭐⭐⭐⭐) — advertised routes
2. **Peer config** (⭐⭐⭐⭐) — received routes
3. **Path analysis** (⭐⭐⭐⭐) — reachability test
4. **Config grep** (⭐⭐⭐⭐⭐) — route-map presence

**Why:** 4/4 methods agreeing = high confidence. 1/4 failing = re-investigate.

---

## Template Variables

Use `{{variable}}` syntax for placeholders:

```markdown
**Device:** {{border_device}}
**Neighbor:** {{ebgp_neighbor}}
**Snapshot:** {{snapshot_id}}
```

The `generate_playbook.py` script replaces these at generation time.

**Common variables:**
- `{{network_id}}`
- `{{network_name}}`
- `{{snapshot_id}}`
- `{{border_device}}`
- `{{ebgp_neighbor}}`
- `{{ticket_id}}`
- `{{timestamp}}`

---

## When to Create a New Template

Create a new template when:
1. **Scenario repeats** — same incident type > 2 times
2. **Multi-step workflow** — requires 3+ Forward skills
3. **Clear tiers** — L1/L2/L3/L4 roles are distinct
4. **Prevention possible** — can deploy intent checks to prevent recurrence

**Don't create templates for:**
- One-off investigations
- Simple read-only queries
- Scenarios without clear escalation path

---

## Example: CVE Remediation Template

```markdown
# NOC Playbook: CVE Remediation

**Incident Type:** CVE Vulnerability (CISA KEV Priority)
**Severity:** P0-P2 (depends on CVE CVSS + exploit status)

---

## L1 NOC: Triage (5 min)

### Step 1: Receive CVE Alert
- CISA KEV published
- Vendor advisory released
- Automated scan detected

### Step 2: Check Vulnerability Impact
**Command:** list_vulnerabilities.py --internet-addressable --snapshot-id X

**Expected:** 0 devices (not affected)
**If >0 devices:** ESCALATE to L2

---

## L2 NetEng: Analysis (10 min)

### Step 3: Get CVE Details
**Command:** get_vulnerability.py --cve-id CVE-2024-XXXXX

### Step 4: Assess Exploitability
- Check CVSS score (9.0+ = CRITICAL)
- Check CISA KEV status (listed = P0)
- Check internet-addressable (yes = P0/P1)

### Step 5: Test Reachability
**Command:** search_path.py --src-ip 0.0.0.0/0 --dst-ip <device-mgmt-ip>

**If DELIVERED:** P0 CRITICAL → ESCALATE IMMEDIATELY

---

## L3 Sr.NetEng: Remediation (60 min)

### Step 6: Apply Patches
[Vendor-specific patch procedure]

### Step 7: Validate
[Check OS version post-patch]

---

## L4 NetArch: Prevention (30 min)

### Step 8: Tag Vulnerable Devices
**Command:** tag_devices.py --tag CVE-2024-XXXXX --devices <list>

### Step 9: Create Intent Check
Monitor for CVE recurrence on future snapshots
```

---

## Testing Your Playbook

Before production use:

1. **Dry-run validation:**
   ```bash
   validate_playbook.py --playbook route-leak.md --network-id X --dry-run
   ```

2. **Tabletop exercise:** Walk L1/L2/L3 teams through each step

3. **Real scenario test:** Trigger the condition in a lab and follow the playbook

4. **Time the workflow:** Did you hit the 5/10/15 minute targets?

5. **Iterate:** Add missing commands, clarify vague steps, document gotchas

---

## Publishing and Maintenance

- **Where to store:** Team wiki, SOC dashboard, printed quick-ref cards
- **Update frequency:** After every incident (capture new learnings)
- **Version control:** Git-track playbooks alongside network configs
- **Review cadence:** Monthly (check if commands still work, Forward API hasn't changed)

---

## Success Metrics

Track these for each playbook:

| Metric | Target |
|---|---|
| **L1 triage time** | < 5 min |
| **L2 analysis time** | < 10 min |
| **L3 remediation time** | < 15 min |
| **Total MTTR** | < 30 min |
| **False positive rate** | < 5% |
| **Escalation accuracy** | > 95% (L1 escalates when they should) |
| **Training time** | < 30 min to train new L1 operator |

---

**Next:** Read `tier-responsibilities.md` for detailed L1/L2/L3/L4 role definitions.
