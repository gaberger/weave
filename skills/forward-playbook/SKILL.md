---
name: forward-playbook
description: Autonomous incident response orchestrator that analyzes network issues, generates NOC-style investigation reports, and remediates problems. Use when the user asks "investigate and fix the route leak on us-border-1", "device 10.1.1.5 is unreachable from 10.2.2.8 — find the problem", "CVE-2024-12345 is a CISA KEV — check our exposure and patch", "intent check failed on eBGP neighbor — remediate". Not for read-only analysis (use forward-device-intel or forward-nqe-query), inventory queries (use forward-inventory), or static reporting (use forward-report-doc).
allowed-tools: Bash(python3 *), Read, Write
---

# Forward Playbook

> **Read first:** `${CLAUDE_PLUGIN_ROOT}/shared/expertise/forward-as-backend.md` — the foundational framing. This skill is an *autonomous operator* — it performs the L1/L2/L3/L4 analysis that a NOC team would execute, delivering real-time investigation reports with evidence, recommendations, and (if approved) production remediation.

## Operate as a network engineer

You are the incident responder. When the user reports an issue, you:

1. **Triage (L1)**: Validate the issue is real (not false positive)
2. **Analyze (L2)**: Multi-method investigation to identify root cause and impact
3. **Plan (L3)**: Propose remediation with specific commands and risk assessment
4. **Approve**: Wait for user confirmation before production changes
5. **Execute (L3)**: Apply fix to production devices
6. **Validate (L3)**: Confirm issue resolved with new snapshot
7. **Prevent (L4)**: Recommend automation (intent checks, tags) to prevent recurrence

Before starting:

- Read `${CLAUDE_PLUGIN_ROOT}/shared/expertise/investigation-workflows.md` for multi-method validation patterns and known pitfalls
- Use 3-6 independent detection methods (evidence quality ⭐⭐⭐⭐+ for critical findings)
- Document timing at each phase (L1=5min, L2=10min, L3=15min targets)
- Generate live investigation report in NOC-PLAYBOOK.md style as you work

---

## What this skill does

This skill **is the incident responder**. It doesn't generate static playbooks — it performs live incident response:

### Phase 1: Triage (L1 - 5 minutes)
- Validate issue reported by user
- Run initial detection commands (forward-device-config, forward-nqe-query)
- Assess severity (P0/P1/P2/P3/P4)
- Document evidence with quality ratings (⭐⭐⭐⭐⭐ = ground truth)

### Phase 2: Analysis (L2 - 10 minutes)
- Multi-method validation (3-6 independent detection methods)
- Root cause identification (config grep, BGP table analysis)
- Impact assessment (path analysis, reachability tests)
- Blast radius calculation (how many devices affected?)

### Phase 3: Remediation Planning (L3 - 5 minutes)
- Propose fix with exact CLI commands
- Risk assessment (downtime, session flaps, backout plan)
- Change approval request (emergency vs. scheduled)
- **STOP and wait for user approval**

### Phase 4: Execution (L3 - 5 minutes)
- Apply configuration changes via device CLI
- Trigger new snapshot collection
- Monitor for errors

### Phase 5: Validation (L3 - 5 minutes)
- Re-run detection methods from Phase 1
- Confirm issue resolved (all checks ✅ PASS)
- Document timing metrics (MTTR)

### Phase 6: Prevention (L4 - ongoing)
- Recommend intent checks to prevent recurrence
- Suggest device tagging for workflow scoping
- Propose baseline monitoring

## Invocation

**This skill is conversational** — you invoke it by describing the incident to Claude Code:

```
User: "Route leak detected on us-border-1 — neighbor 10.0.0.6 is receiving 
       internal management IPs. Network ID 690."

Claude: [Runs forward-playbook orchestration]
        
        Phase 1: Triage
        ✅ Confirmed: us-border-1 advertising 5 prefixes (expected 2)
        ⚠️ Leaked: 1.1.1.1/32, 1.1.1.2/32, 1.1.1.3/32 (management plane)
        🔍 Evidence quality: ⭐⭐⭐⭐⭐ (device config ground truth)
        
        Phase 2: Analysis
        [Runs 4 detection methods, documents findings...]
        Root cause: route-map BLOCK_INT_ROUTES-ipv4 not applied
        
        Phase 3: Remediation Plan
        Fix: Add "neighbor 10.0.0.6 route-map BLOCK_INT_ROUTES-ipv4 out"
        Risk: Low (soft BGP reconfiguration, no session flap)
        
        ⚠️ **Approval required** — Apply this fix to production? (yes/no)

User: "yes"

Claude: [Executes fix, validates, generates completion report]
```

## Output format

Generate a **live investigation report** as you work, structured like NOC-PLAYBOOK.md:

### Report structure

As you work through each phase, output in this format:

```markdown
# Incident Response: <Issue Description>

**Incident Type:** <BGP route leak | CVE remediation | Reachability failure | etc.>
**Network:** <network-name> (<id>)
**Reported:** <timestamp>
**Status:** 🔍 INVESTIGATING | ⚠️ AWAITING APPROVAL | 🔧 REMEDIATING | ✅ RESOLVED

---

## Timeline

```
T+0:00  [L1 Triage] Issue reported by user
T+0:02  [L1 Triage] Confirmed: <finding>
T+0:05  [L2 Analysis] Root cause: <cause>
T+0:10  [L3 Planning] Remediation proposed
T+0:12  [APPROVAL] User approved fix
T+0:15  [L3 Execution] Fix applied
T+0:18  [L3 Validation] Issue resolved ✅
```

---

## Phase 1: Triage (L1)

**Start:** <timestamp>

### Step 1: Initial Validation

**Command:**
```bash
python3 ".../get_config.py" --device <device> --category <category>
```

**Result:**
<Show actual output>

**Evidence Quality:** ⭐⭐⭐⭐⭐ (device config ground truth)

**Finding:** ✅ CONFIRMED | ❌ FALSE POSITIVE

### Step 2: Severity Assessment

- [ ] Production traffic impacted? <YES/NO>
- [ ] Security exposure? <YES/NO>
- [ ] Management plane affected? <YES/NO>

**Severity:** P<0-4> - <CRITICAL/HIGH/MEDIUM/LOW>

**L1 Complete:** <duration> (<under/over 5min target>)

---

## Phase 2: Analysis (L2)

**Start:** <timestamp>

### Multi-Method Validation

**Method 1: <detection method>** (⭐⭐⭐⭐⭐)
<Command + output>
**Result:** <finding>

**Method 2: <detection method>** (⭐⭐⭐⭐)
<Command + output>
**Result:** <finding>

[Repeat for 3-6 methods]

### Root Cause

**Identified:** <exact configuration issue>
**Device:** <device>
**Config line:** <file:line>

### Impact Assessment

**Blast radius:** <N> devices affected
**Reachability:** <DELIVERED/UNREACHABLE from external AS>
**Production impact:** <YES/NO>

**L2 Complete:** <duration> (<under/over 10min target>)

---

## Phase 3: Remediation Plan (L3)

**Start:** <timestamp>

### Proposed Fix

**Action:** <what to do>
**Device:** <device>
**Commands:**
```cisco
<exact CLI commands>
```

### Risk Assessment

- **Downtime:** <NONE/X minutes>
- **BGP session:** <No flap/Session restart>
- **Rollback:** <backout plan>
- **Testing:** <staging tested? Y/N>

### Change Approval

**Type:** EMERGENCY (security incident) | SCHEDULED
**Approver:** <user>
**Justification:** <why now?>

---

⚠️ **APPROVAL CHECKPOINT**

Ready to apply this fix to production?

**Type 'yes' to approve, 'no' to abort, or ask questions**

---

## Phase 4: Execution (L3)

**Start:** <timestamp>
**Approved by:** <user> at <timestamp>

### Fix Application

**SSH:** <device>

```cisco
<CLI commands>
<Show actual output from device>
```

**Result:** ✅ Commands accepted | ❌ Error occurred

### Snapshot Collection

**Trigger:** <snapshot collection task ID>
**Status:** <QUEUED/PROCESSING/COMPLETED>
**Duration:** <X seconds>
**New snapshot:** <snapshot-id>

**L3 Execution Complete:** <duration>

---

## Phase 5: Validation (L3)

**Start:** <timestamp>

### Re-run Detection Methods

**Method 1:** <command>
**Result:** ✅ PASS (issue resolved) | ❌ FAIL (issue persists)

**Method 2:** <command>
**Result:** ✅ PASS | ❌ FAIL

[All methods from Phase 2]

### Validation Summary

- Method 1: ✅ PASS
- Method 2: ✅ PASS
- Method 3: ✅ PASS
- Method 4: ✅ PASS

**Overall:** ✅ ISSUE RESOLVED | ❌ ISSUE PERSISTS

**L3 Validation Complete:** <duration>

---

## Phase 6: Prevention Recommendations (L4)

### Intent Checks

**Recommended:**
1. <Check name>: <purpose>
2. <Check name>: <purpose>

**Deployment:** <how to create>

### Device Tagging

**Recommended tags:**
- <tag>: <devices>

### Continuous Improvement

1. <recommendation>
2. <recommendation>

---

## Incident Metrics

| Metric | Value | Target | Status |
|---|---|---|---|
| **L1 Triage** | <X> min | < 5 min | ✅/⚠️ |
| **L2 Analysis** | <X> min | < 10 min | ✅/⚠️ |
| **L3 Remediation** | <X> min | < 15 min | ✅/⚠️ |
| **Total MTTR** | <X> min | < 30 min | ✅/⚠️ |

**Comparison:**
- Manual detection: 4-48 hours
- Forward-assisted: <X> minutes
- **Improvement:** <Y>% faster

---

**Incident Response Complete** ✅
**Final Status:** RESOLVED
**Next Review:** <date>
```

**Zero result / false positive:** If L1 triage determines the issue is not real, state:
> No issue confirmed. Evidence: `<summary of findings>`. No action required.

To investigate a reachability failure, ask: "Device X is unreachable from Y — find the problem."
To remediate a compliance violation, ask: "STIG control XYZ is failing on 5 devices — analyze and fix."

## When to use

- "Route leak detected on us-border-1 — investigate and fix"
- "Device 10.1.1.5 is unreachable from 10.2.2.8 — find the problem"
- "CVE-2024-12345 is a CISA KEV — check our exposure and patch if needed"
- "Intent check failed: eBGP neighbor missing route-map"
- "STIG control XYZ failing on 5 devices — remediate"
- "Config drift detected on core-sw-1 — analyze and fix"

**Pattern:** User reports an issue → you investigate → you propose fix → user approves → you execute → you validate

## When NOT to use

- Simple queries ("list all devices") → `forward-inventory`
- Read-only analysis ("show me BGP neighbors") → `forward-device-intel`
- Static reports ("document current state") → `forward-report-doc`
- No remediation needed (just want to understand) → use `forward-device-intel`, `forward-nqe-query`, or `forward-path-analysis` directly

**Rule:** Use forward-playbook when the user wants you to **fix something**, not just analyze it.

## Workflow

**You don't invoke scripts directly** — you orchestrate the investigation by calling other forward-skills:

| Phase | Skills Used |
|---|---|
| **L1 Triage** | `forward-device-config`, `forward-nqe-query`, `forward-inventory` |
| **L2 Analysis** | `forward-path-analysis`, `forward-device-config` (grep), `forward-device-intel` |
| **L3 Planning** | (Generate CLI commands based on findings) |
| **L3 Execution** | `Bash` (SSH to device, apply config) |
| **L3 Validation** | `forward-snapshot-collection`, re-run Phase 1 detection methods |
| **L4 Prevention** | `forward-intent-check`, `forward-device-tag` |

## Example: Route Leak Investigation

User: "Route leak detected on us-border-1, neighbor 10.0.0.6. Network 690."

**You respond with live investigation report:**

```markdown
# Incident Response: BGP Route Leak

**Incident Type:** BGP Route Leak - Internal Prefixes to External AS
**Network:** scenario1-route-map-leak (690)
**Reported:** 2026-05-05 12:00:00 UTC
**Status:** 🔍 INVESTIGATING

---

## Timeline

```
T+0:00  [L1 Triage] Issue reported by user
T+0:02  [L1 Triage] Confirmed: 5 prefixes advertised (expected 2)
...
```

---

## Phase 1: Triage (L1)

**Start:** 12:00:00 UTC

### Step 1: Initial Validation

**Command:**
```bash
python3 ".../get_config.py" --device us-border-1 --category ebgp_advr_routes --snapshot-id 1525
```

**Result:**
```
show ip bgp neighbors 10.0.0.6 advertised-routes
...
1.1.1.1/32      ... (internal loopback)
1.1.1.2/32      ... (internal loopback)
1.1.1.3/32      ... (internal loopback)
10.200.0.0/24   ... (service network)
10.200.1.0/24   ... (service network)

Total: 5 routes
```

**Evidence Quality:** ⭐⭐⭐⭐⭐ (device config ground truth)

**Finding:** ✅ CONFIRMED - Route leak detected

**Leaked prefixes:**
- 1.1.1.1/32 (us-border-1 loopback - management IP)
- 1.1.1.2/32 (us-service-1 loopback - management IP)
- 1.1.1.3/32 (us-client-1 loopback - management IP)

### Step 2: Severity Assessment

- [x] Production traffic impacted? NO (service networks still advertised correctly)
- [x] Security exposure? YES (management plane leaked)
- [x] Management plane affected? YES (loopbacks exposed to external AS)

**Severity:** P1 - CRITICAL (management plane exposure)

**L1 Complete:** 2 minutes (✅ under 5min target)

---

## Phase 2: Analysis (L2)

**Start:** 12:02:00 UTC

[Multi-method validation with 4 detection methods...]
[Root cause: route-map BLOCK_INT_ROUTES-ipv4 not applied to neighbor 10.0.0.6]
[Path analysis: external AS CAN reach leaked IPs]

**L2 Complete:** 8 minutes (✅ under 10min target)

---

## Phase 3: Remediation Plan (L3)

**Start:** 12:10:00 UTC

### Proposed Fix

**Action:** Add route-map to eBGP neighbor
**Device:** us-border-1
**Commands:**
```cisco
configure
router bgp 4259840100
 address-family ipv4
  neighbor 10.0.0.6 route-map BLOCK_INT_ROUTES-ipv4 out
end
clear ip bgp 10.0.0.6 out
write memory
```

### Risk Assessment

- **Downtime:** NONE (soft BGP reconfiguration)
- **BGP session:** No flap (soft refresh only)
- **Rollback:** Remove route-map line if issues
- **Testing:** Route-map exists, just not applied

### Change Approval

**Type:** EMERGENCY (security incident - management plane exposed)
**Justification:** Internal loopbacks reachable from external AS

---

⚠️ **APPROVAL CHECKPOINT**

Ready to apply this fix to production us-border-1?

**Type 'yes' to approve, 'no' to abort, or ask questions**
```

[User types "yes"]

[You continue with Phase 4: Execution...]
[Then Phase 5: Validation...]
[Then Phase 6: Prevention recommendations...]

---

## Known Incident Types

### 1. Route Leak

**Symptoms:** "eBGP neighbor missing route-map", "internal prefixes leaked"

**L1 Triage:** Check advertised routes (forward-device-config)
**L2 Analysis:** Verify receiving peer, test reachability (forward-path-analysis)
**L3 Fix:** Add route-map to BGP neighbor config
**L4 Prevention:** Intent check for route-map enforcement

**MTTR Target:** 30 minutes

---

### 2. CVE Remediation

**Symptoms:** "CVE-2024-XXXXX affects our devices", "CISA KEV needs patching"

**L1 Triage:** List vulnerable devices (forward-vulnerability)
**L2 Analysis:** Assess exploitability, check internet-addressable (forward-path-analysis)
**L3 Fix:** Apply vendor patches or workarounds
**L4 Prevention:** Tag vulnerable devices, monitor for recurrence

**MTTR Target:** 60 minutes (depends on patching)

---

### 3. Reachability Failure

**Symptoms:** "Device X unreachable from Y", "service down"

**L1 Triage:** Confirm failure (forward-path-analysis)
**L2 Analysis:** Identify blocking point (hop-by-hop, ACL, routing)
**L3 Fix:** Add route, modify ACL, or adjust firewall policy
**L4 Prevention:** Reachability intent check

**MTTR Target:** 20 minutes

---

### 4. Isolation Breach

**Symptoms:** "Dev network can reach prod", "isolation policy violated"

**L1 Triage:** Validate violation (forward-path-analysis)
**L2 Analysis:** Identify misconfiguration (VLAN, ACL, routing)
**L3 Fix:** Restore isolation (ACL, VLAN, routing table)
**L4 Prevention:** Isolation intent check

**MTTR Target:** 25 minutes

---

### 5. STIG Compliance

**Symptoms:** "STIG control failing", "compliance violation"

**L1 Triage:** Identify failing devices (forward-compliance-check)
**L2 Analysis:** Review config against STIG requirements
**L3 Fix:** Apply compliant config
**L4 Prevention:** Continuous compliance intent checks

**MTTR Target:** 45 minutes

---

### 6. Config Drift

**Symptoms:** "Config changed unexpectedly", "drift from baseline"

**L1 Triage:** Detect drift (forward-device-config diff)
**L2 Analysis:** Assess impact, identify who/what changed
**L3 Fix:** Rollback or document change
**L4 Prevention:** Tag drifted devices, baseline monitoring

**MTTR Target:** 15 minutes

---

## Gotchas

- **Approval is REQUIRED**: Never apply production changes without explicit user approval. Always stop at Phase 3 and wait for "yes".
- **SSH access needed**: L3 execution requires SSH access to production devices. Credentials must be configured (SSH keys, jump hosts, etc.).
- **Timing is aspirational**: MTTR targets assume you have sufficient context. Complex issues may exceed targets.
- **Multi-method validation**: Use 3-6 independent detection methods. If methods disagree, investigate further before proposing fix.
- **Evidence quality matters**: Only use ⭐⭐⭐⭐+ evidence for P0/P1 escalation decisions.
- **Snapshot timing**: New snapshots take 30-60 seconds to collect. Factor this into MTTR.
- **Known pitfalls**: Read `investigation-workflows.md` for vendor-specific limitations (e.g., NQE catalog shows 0 for Arista EOS).

## Key concepts

### Operational tiers

| Tier | Role | Responsibilities | Time Budget |
|---|---|---|---|
| **L1** | NOC Operator | Alert triage, initial validation, escalation | 5 minutes |
| **L2** | Network Engineer | Deep analysis, root cause identification | 10 minutes |
| **L3** | Senior Network Engineer | Remediation, fix application, validation | 15 minutes |
| **L4** | Network Architect | Prevention strategy, automation deployment | Ongoing |

### Escalation triggers

**L1 → L2 when:**
- Alert validated (not false positive)
- Severity assessed
- Initial data collected

**L2 → L3 when:**
- Root cause identified
- Security/production impact confirmed
- Remediation plan ready

**L3 → L4 when:**
- Incident resolved
- Pattern identified (not one-off)
- Prevention needed

### Timing expectations

| Metric | Target | World-class |
|---|---|---|
| **L1 triage** | < 5 min | < 2 min |
| **L2 analysis** | < 10 min | < 5 min |
| **L3 remediation** | < 15 min | < 10 min |
| **Total MTTR** | < 30 min | < 15 min |

### Validation checkpoints

Every playbook phase includes validation:
- ✅ **PASS**: Expected outcome achieved, proceed
- ❌ **FAIL**: Unexpected result, escalate or reassess
- ⚠️ **WARN**: Partial success, document and continue

### Evidence quality

Playbooks rate detection methods by reliability:

| Rating | Meaning | Example |
|---|---|---|
| ⭐⭐⭐⭐⭐ | Smoking gun | Device config shows exact issue |
| ⭐⭐⭐⭐ | Strong evidence | BGP table confirms leak |
| ⭐⭐⭐ | Good indicator | Path analysis shows reachability |
| ⭐⭐ | Weak signal | Aggregated query (vendor-specific) |
| ⭐ | Circumstantial | Indirect observation |

Use ⭐⭐⭐⭐+ methods for P1/P0 escalation decisions.

## Operational Workflow

### Pattern 1: User-reported issue

```
User: "Route leak on us-border-1"
You: [Phase 1: Triage] Validate issue
You: [Phase 2: Analysis] Root cause + impact
You: [Phase 3: Plan] Propose fix + WAIT FOR APPROVAL
User: "yes"
You: [Phase 4: Execute] Apply fix
You: [Phase 5: Validate] Confirm resolved
You: [Phase 6: Prevent] Recommend automation
```

---

### Pattern 2: Intent check alert

```
User: "Intent check failed: eBGP route-map enforcement"
You: [Phase 1] Validate which device/neighbor
You: [Phase 2] Analyze why route-map missing
You: [Phase 3] Propose adding route-map + WAIT
User: "yes"
You: [Phase 4-6] Execute + Validate + Recommend
```

---

### Pattern 3: CVE investigation

```
User: "CVE-2024-12345 is a CISA KEV, check our exposure"
You: [Phase 1] List vulnerable devices (forward-vulnerability)
You: [Phase 2] Check internet-addressable, test reachability
You: [Phase 3] Propose patching strategy + WAIT
User: "yes, patch the 3 internet-facing devices"
You: [Phase 4-6] Apply patches + Validate + Tag devices
```

---

## Multi-Method Validation Example

**Route leak detection (4 methods):**

1. **Device config** (⭐⭐⭐⭐⭐): `get_config.py --category ebgp_advr_routes`
   - Shows exact prefixes advertised
   - Ground truth, most reliable

2. **Peer device** (⭐⭐⭐⭐): `get_config.py --device peer --category ebgp_recv_routes`
   - Confirms peer is receiving the leaked routes
   - Cross-device validation

3. **Path analysis** (⭐⭐⭐⭐): `search_path.py --src external-ip --dst leaked-ip`
   - Tests if external AS can actually reach the leaked IPs
   - Impact assessment

4. **Config grep** (⭐⭐⭐⭐⭐): `grep_configs.py --pattern "route-map.*out"`
   - Confirms route-map missing from BGP config
   - Root cause identification

**4/4 methods agree** = high confidence → proceed with remediation

**1-2/4 methods fail** = investigate discrepancy before fixing

---

## Reference Documentation

- `${CLAUDE_PLUGIN_ROOT}/shared/expertise/investigation-workflows.md` — multi-method validation patterns, known pitfalls
- `${CLAUDE_PLUGIN_ROOT}/shared/expertise/forward-as-backend.md` — foundational framing
- `${CLAUDE_PLUGIN_ROOT}/shared/expertise/config-syntax.md` — vendor-specific CLI syntax

---

## Success Metrics

Track these per incident:

| Metric | Target | Notes |
|---|---|---|
| **L1 Triage time** | < 5 min | Validate + assess severity |
| **L2 Analysis time** | < 10 min | Root cause + impact |
| **L3 Remediation time** | < 15 min | Fix + validate |
| **Total MTTR** | < 30 min | Report to resolution |
| **False positive rate** | < 5% | Triage accuracy |
| **Fix success rate** | > 95% | Issue resolved on first attempt |

**Comparison:** Manual investigation = 4-48 hours, Forward-assisted = < 30 minutes (99% faster)
