## Tagging Strategies — Best Practices

Device tags are your metadata layer for Forward Networks. This guide covers naming conventions, color schemes, and workflow patterns that scale.

## Tag naming conventions

### 1. Use descriptive, consistent prefixes

Prefixes help organize tags and make them scannable in lists:

| Prefix | Purpose | Examples |
|---|---|---|
| `CVE-` | Vulnerability tracking | `CVE-2024-HIGH`, `CVE-CRITICAL` |
| `STIG-` | Compliance tracking | `STIG-FAIL`, `STIG-CAT-I` |
| `LOC-` | Location-based | `LOC-NYC`, `LOC-ATL`, `LOC-EU-WEST` |
| `PRIORITY-` | Remediation priority | `PRIORITY-P0`, `PRIORITY-P1` |
| `ROLE-` | Device function | `ROLE-EDGE`, `ROLE-CORE`, `ROLE-ACCESS` |
| `VENDOR-` | Vendor grouping | `VENDOR-CISCO`, `VENDOR-JUNIPER` |
| `STATUS-` | Lifecycle status | `STATUS-PROD`, `STATUS-STAGING`, `STATUS-DECOMM` |
| `RISK-` | Risk level | `RISK-HIGH`, `RISK-MEDIUM`, `RISK-LOW` |

**Why prefixes matter:** Without them, tags like "HIGH", "NYC", "CISCO" become ambiguous. `PRIORITY-HIGH` vs. `CVE-HIGH` vs. `RISK-HIGH` makes intent clear.

### 2. Use ALL-CAPS for consistency

**Recommended:** `CVE-CRITICAL`, `LOC-NYC`, `ROLE-EDGE`

**Avoid:** `cve-critical`, `Loc-NYC`, `role_edge` (mixed case/separators)

**Rationale:** Tag names are case-insensitive in Forward, but ALL-CAPS makes them visually distinct from device names in lists.

### 3. Keep names short but meaningful

**Good:** `CVE-2024-HIGH` (specific, scannable)

**Too long:** `CRITICAL-VULNERABILITY-CVE-2024-REQUIRES-IMMEDIATE-PATCHING` (verbose, hard to read)

**Too short:** `C1` (cryptic, requires context)

**Rule of thumb:** 8-20 characters. If longer, consider using tag notes/descriptions instead.

### 4. Avoid ambiguous names

**Ambiguous:**
- `HIGH` — high what? Priority? Severity? Risk?
- `PATCH` — needs patching? Is patched? Patch applied?
- `OLD` — old OS version? Old device? Scheduled for replacement?

**Clear:**
- `PRIORITY-HIGH`, `CVE-HIGH`, `RISK-HIGH`
- `NEEDS-PATCHING`, `PATCHED-2024-05`
- `OS-EOL`, `HW-EOL`, `SCHEDULED-DECOMM`

### 5. Use dates for time-bounded tags

When tracking remediation waves or time-sensitive issues:

**Examples:**
- `CVE-2024-05-WAVE1` (first remediation wave in May 2024)
- `PATCHED-2024-05-01` (patched on May 1, 2024)
- `AUDIT-2024-Q2` (tagged during Q2 2024 audit)

**Format:** `YYYY-MM` or `YYYY-MM-DD` for sortability.

## Color schemes

Colors appear in topology diagrams and device lists. Use them to convey meaning at a glance.

### Standard color palette

| Color | Hex | Use case |
|---|---|---|
| **Red** | `#ff0000` | Critical, high-priority, vulnerable, urgent |
| **Orange** | `#ff8800` | Medium-priority, warning, requires attention |
| **Yellow** | `#ffff00` | Low-priority, watch, informational |
| **Green** | `#00ff00` | Compliant, remediated, verified, good state |
| **Blue** | `#0064a0` | Informational, location-based, neutral |
| **Purple** | `#8800ff` | Special projects, experimental, non-production |
| **Gray** | `#808080` | Disabled, archived, decommissioned, inactive |

### Priority-based color coding

**Remediation priority tags:**
- `PRIORITY-P0` → Red (`#ff0000`) — emergency, patch today
- `PRIORITY-P1` → Orange (`#ff8800`) — urgent, patch this week
- `PRIORITY-P2` → Yellow (`#ffff00`) — important, patch this month
- `PRIORITY-P3` → Blue (`#0064a0`) — routine, patch next cycle

**Diagram interpretation:** A topology with many red devices = critical work needed. Shrinking red over time = remediation progress.

### Vulnerability severity color coding

**CVE severity tags:**
- `CVE-CRITICAL` → Red (`#ff0000`)
- `CVE-HIGH` → Orange (`#ff8800`)
- `CVE-MEDIUM` → Yellow (`#ffff00`)
- `CVE-LOW` → Blue (`#0064a0`)

### Compliance status color coding

**STIG/compliance tags:**
- `STIG-FAIL` → Red (`#ff0000`) — failing controls
- `STIG-PARTIAL` → Orange (`#ff8800`) — some controls failing
- `STIG-PASS` → Green (`#00ff00`) — all controls passing
- `STIG-NOT-SCANNED` → Gray (`#808080`) — not yet audited

### Location-based color coding

**If using colors for locations**, choose visually distinct hues:
- `LOC-NYC` → Blue (`#0064a0`)
- `LOC-ATL` → Green (`#008800`)
- `LOC-SFO` → Purple (`#8800ff`)
- `LOC-LON` → Orange (`#ff8800`)

**Alternative:** Use the same color (Blue `#0064a0`) for all location tags — they're informational, not status-based.

## Tagging workflows

### Workflow 1: Vulnerability remediation lifecycle

**Stages:**
1. **Discovery**: scan finds vulnerable devices → tag `CVE-2024-HIGH`
2. **Prioritization**: assess exploitability → add `PRIORITY-P0` or `PRIORITY-P1`
3. **Remediation**: patch device → remove `CVE-2024-HIGH`, add `PATCHED-2024-05`
4. **Verification**: confirm patch → remove `PRIORITY-P0`, keep `PATCHED-2024-05` for history

**Tags in use:**
- `CVE-2024-HIGH` (Red) — currently vulnerable
- `PRIORITY-P0` (Red) — needs immediate attention
- `PATCHED-2024-05` (Green) — patched in May 2024

**Benefits:**
- Diagram shows shrinking red (vulnerable) and growing green (patched)
- Filter to `CVE-2024-HIGH` to see remaining work
- Filter to `PATCHED-2024-05` to see completed work
- Historical record of remediation timeline

### Workflow 2: Compliance tracking

**Stages:**
1. **Baseline**: all devices compliant → no tags
2. **Drift detection**: STIG scan finds violators → tag `STIG-FAIL`
3. **Remediation**: fix config → remove `STIG-FAIL`
4. **Re-scan**: verify compliance → confirm tag removal

**Tags in use:**
- `STIG-FAIL` (Red) — currently failing STIG controls
- `STIG-CAT-I` (Red) — Category I (most severe) violations
- `STIG-CAT-II` (Orange) — Category II violations
- `STIG-CAT-III` (Yellow) — Category III violations

**Benefits:**
- Zero `STIG-FAIL` tags = compliant network
- Track violator count over time
- Prioritize Cat I violations (critical)

### Workflow 3: Change management

**Stages:**
1. **Pre-change**: tag devices in scope → `CHANGE-2024-05-15`
2. **Change window**: apply configs
3. **Validation**: verify intent checks pass
4. **Rollback or commit**: if success, remove tag; if failure, escalate

**Tags in use:**
- `CHANGE-2024-05-15` (Blue) — devices in today's change
- `CHANGE-ROLLBACK` (Red) — devices that need rollback
- `CHANGE-SUCCESS` (Green) — devices where change succeeded

**Benefits:**
- Clear scope: which devices were touched?
- Failure tracking: which devices need rollback?
- Historical record: devices changed on specific date

### Workflow 4: Progressive remediation

**Stages:**
1. **Discovery**: 100 devices need patching → tag `NEEDS-PATCHING`
2. **Wave 1**: patch 20 devices → move to `WAVE1-COMPLETE`
3. **Wave 2**: patch 30 devices → move to `WAVE2-COMPLETE`
4. **Wave 3**: patch remaining 50 → move to `WAVE3-COMPLETE`
5. **Completion**: all devices patched → remove all wave tags, add `PATCHED-2024-05`

**Tags in use:**
- `NEEDS-PATCHING` (Red) — not yet patched
- `WAVE1-COMPLETE` (Green) — patched in wave 1
- `WAVE2-COMPLETE` (Green) — patched in wave 2
- `WAVE3-COMPLETE` (Green) — patched in wave 3

**Benefits:**
- Track progress across multiple remediation waves
- Identify which wave a device was part of
- Measure remediation velocity (devices/wave)

## Tag lifecycle management

### When to create tags

✅ **Do create tags for:**
- **Active issues**: vulnerabilities, policy violations, errors
- **Remediation tracking**: work-in-progress, completed work
- **Risk categories**: high/medium/low risk devices
- **Location/function**: permanent categorization

❌ **Don't create tags for:**
- **One-time queries**: if you'll only use it once, query directly
- **Transient state**: ephemeral conditions (ARP entries, temp metrics)
- **Redundant info**: data already in device name/model/location

### When to remove tags

Remove tags when:
1. **Issue resolved**: vulnerability patched, compliance restored
2. **Device decommissioned**: no longer exists in network
3. **Tag obsolete**: better tag created, original no longer needed
4. **Historical cutoff**: old date-based tags (`PATCHED-2023-01` can be removed after a year)

**Cleanup best practice:** Monthly review of tags. Remove tags with zero devices or tags older than retention policy.

### Tag expiration strategy

For time-bounded tags, establish expiration policies:

| Tag type | Retention | Reason |
|---|---|---|
| Vulnerability tags | Until remediated | Ongoing tracking |
| Compliance tags | Until resolved | Ongoing tracking |
| Remediation wave tags | 6 months | Historical reference |
| Change tags | 3 months | Historical reference |
| Patched tags | 1 year | Historical reference |

**Implementation:** Quarterly review, bulk remove expired tags.

## Anti-patterns (avoid these)

### 1. Tag explosion

**Problem:** Creating a new tag for every tiny variation.

**Bad:**
- `CVE-2024-12345`, `CVE-2024-12346`, `CVE-2024-12347` ... (100+ tags)

**Better:**
- `CVE-2024-CRITICAL`, `CVE-2024-HIGH` (severity-based)
- `CVE-2024-05-WAVE` (remediation-wave-based)

**Rule:** If you have >50 tags, you're likely over-tagging. Consolidate.

### 2. Redundant tags

**Problem:** Tagging information already captured elsewhere.

**Bad:**
- `VENDOR-CISCO` (vendor is in device metadata)
- `MODEL-ASA5515` (model is in device metadata)
- `OS-VERSION-9.8` (OS version is in device metadata)

**Better:** Use NQE queries to filter by vendor/model/OS. Reserve tags for *additional* metadata not in the model.

**Exception:** If you need to *scope* a workflow to a subset and that subset isn't easily expressible as an NQE filter, a tag is justified.

### 3. Stale tags

**Problem:** Tags that no longer reflect reality.

**Bad:**
- `NEEDS-PATCHING` tag on a device that was patched 6 months ago
- `VULNERABLE` tag on a device that no longer exists

**Fix:** Automate tag removal. When you patch a device, script should remove `NEEDS-PATCHING` and add `PATCHED-YYYY-MM`.

### 4. Ambiguous tags

**Problem:** Tags whose meaning isn't obvious.

**Bad:**
- `TODO`, `FIX`, `CHECK`, `URGENT` (vague)

**Better:**
- `PRIORITY-P0`, `CVE-CRITICAL`, `STIG-FAIL` (specific)

### 5. Using tags as notes

**Problem:** Encoding long descriptions in tag names.

**Bad:**
- `THIS-DEVICE-NEEDS-PATCHING-FOR-CVE-2024-12345-SEE-TICKET-INC-456`

**Better:**
- Tag: `CVE-2024-HIGH`
- Device notes field: "Vulnerable to CVE-2024-12345. Remediation tracked in INC-456."

**Reason:** Tags are for categorization, not documentation. Use device notes/descriptions for context.

## Integration with other Forward features

### Tags in NQE queries

```nqe
foreach device in network.devices
where "CVE-CRITICAL" in device.tags
select {
    device: device.name,
    vendor: device.platform.vendor,
    model: device.platform.model
}
```

**Use case:** Filter NQE queries to tagged devices.

### Tags in vulnerability scans

```bash
# Scope vulnerability scan to tagged devices
list_vulnerabilities.py --network-id NET_xyz --tag CVE-CRITICAL
```

**Use case:** Re-scan only devices that were previously vulnerable.

### Tags in diagram views

**Use case:** Color-code topology diagrams by tag. Red devices = critical, green = patched.

### Tags in intent checks (future)

**Use case:** Scope intent checks to tagged devices (e.g., "ensure these tagged devices can reach DB").

## Example tag hierarchy

Here's a complete tagging scheme for a mid-sized enterprise:

```
### Vulnerability tracking
CVE-CRITICAL        #ff0000
CVE-HIGH            #ff8800
CVE-MEDIUM          #ffff00
CVE-LOW             #0064a0

### Remediation priority
PRIORITY-P0         #ff0000
PRIORITY-P1         #ff8800
PRIORITY-P2         #ffff00
PRIORITY-P3         #0064a0

### Compliance
STIG-FAIL           #ff0000
STIG-CAT-I          #ff0000
STIG-CAT-II         #ff8800
STIG-CAT-III        #ffff00

### Remediation waves
WAVE1-PENDING       #ff8800
WAVE1-COMPLETE      #00ff00
WAVE2-PENDING       #ff8800
WAVE2-COMPLETE      #00ff00

### Locations
LOC-NYC             #0064a0
LOC-ATL             #0064a0
LOC-SFO             #0064a0

### Device roles
ROLE-EDGE           #8800ff
ROLE-CORE           #8800ff
ROLE-ACCESS         #8800ff

### Lifecycle status
STATUS-PROD         #00ff00
STATUS-STAGING      #ffff00
STATUS-DECOMM       #808080

### Internet exposure
INET-FACING         #ff0000
INET-ADDRESSABLE    #ff8800
```

**Total: ~25 tags** — manageable, expressive, color-coded.

## Summary: 10 tagging commandments

1. **Use descriptive prefixes** (`CVE-`, `LOC-`, `PRIORITY-`)
2. **Keep names short** (8-20 characters)
3. **Use ALL-CAPS** for consistency
4. **Assign meaningful colors** (Red = critical, Green = good)
5. **Create tags for active issues**, not historical trivia
6. **Remove tags when resolved** or obsolete
7. **Avoid redundant tags** (don't duplicate device metadata)
8. **Consolidate similar tags** (avoid tag explosion)
9. **Document tag meanings** (in a wiki or this file)
10. **Review quarterly** (clean up stale/unused tags)
