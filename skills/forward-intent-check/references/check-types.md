# Check Types — Deep Dive

Forward supports 5 types of checks (called "Verifications" in the UI). Each serves a different purpose in network validation.

## Path-based checks (Existential, Isolation, Reachability)

These three types all work by simulating packet flows through the network model, but they assert different outcomes:

### Existential

**Purpose:** Verify that specific traffic **IS allowed** between source and destination.

**When it passes:** At least one path exists and delivers the packet.

**When it fails:** All paths drop the packet, or no valid path exists.

**Use cases:**
- "Production app servers must be able to reach the database on port 5432"
- "Web tier can access API tier on HTTPS"
- "DR site can reach primary site for replication"

**Example:**
```bash
create_check.py --network-id NET_xyz --type Existential \
    --name "Prod → DB:5432" \
    --src-ip 10.1.0.0/16 --dst-ip 10.5.0.10 \
    --ip-proto tcp --dst-port 5432
```

### Isolation

**Purpose:** Verify that specific traffic **IS blocked** between source and destination.

**When it passes:** All paths drop the packet, or no valid path exists.

**When it fails:** At least one path delivers the packet.

**Use cases:**
- "DMZ must NOT reach internal management VLAN"
- "Guest WiFi isolated from corporate network"
- "Untrusted zone cannot access privileged resources"

**Example:**
```bash
create_check.py --network-id NET_xyz --type Isolation \
    --name "DMZ ⛔ mgmt" \
    --src-ip 10.10.0.0/16 --dst-ip 192.168.100.0/24
```

### Reachability

**Purpose:** Verify that traffic **gets delivered to its intended destination** (stricter than Existential).

**When it passes:** At least one path delivers to the exact destination.

**When it fails:** Paths exist but none reach the intended destination, or all drop.

**Use cases:**
- "Confirm backup path delivers to DR site (not just to the edge)"
- "Load balancer VIP resolves to correct backend pool"
- "Multicast RP reachability"

**Example:**
```bash
create_check.py --network-id NET_xyz --type Reachability \
    --name "DR reachability" \
    --src-ip 10.1.2.3 --dst-ip 10.99.0.10
```

### Pinning an endpoint to a device (ingress/egress sentinels)

For all three path-based types, `--src-ip` / `--dst-ip` accept a **bare device
name** as well as an IP/CIDR. A device name builds a `DeviceFilter` instead of a
`SubnetLocationFilter`: `--src-ip <device>` pins the **ingress** (`from`),
`--dst-ip <device>` pins the **egress** (`to`). Pinning the egress to a
plane-specific device converts a path-agnostic delivery check into a **plane /
migration sentinel** — it passes only while traffic actually leaves via that
device. See `references/location-filters.md` for the mechanism and a worked
LDP→SR migration example.

### Existential vs. Reachability — when to use which?

| Scenario | Use |
|---|---|
| "Can A reach B at all?" | Existential |
| "Does traffic reach B specifically, not just its subnet?" | Reachability |
| "Is there unintended reachability?" | Existential (or Isolation inverted) |
| "Load balancer delivers to correct backend" | Reachability |

## NQE checks

**Purpose:** Run a custom or library query as a check. The query returns results; if any rows appear (or if a specific condition is met), the check fails.

**When it passes:** Query returns zero rows (or indicator field marks passing).

**When it fails:** Query returns rows indicating violations.

**Use cases:**
- "Alert if any device has SSH on a non-standard port"
- "Ensure all BGP sessions are up"
- "No devices with SNMPv1/v2 enabled"
- Any custom policy expressible as an NQE query

**Example:**
```bash
# First, identify the query ID (from forward-nqe-query skill)
# Then create the check:
create_check.py --network-id NET_xyz --type NQE \
    --name "SSH port enforcement" \
    --query-id FQ_abc123...
```

**How to build NQE checks:**
1. Write and test the query via `forward-nqe-query` (or use a catalog query)
2. Ensure the query returns rows only when a violation occurs
3. Reference the query ID when creating the check

## Predefined checks

**Purpose:** Library of common checks for typical network designs. Think of these as "batteries included" for standard validations.

**When it passes:** The built-in rule is satisfied.

**When it fails:** The built-in rule is violated.

**Use cases:**
- BGP neighbor adjacency
- VLAN consistency
- MTU consistency
- Port channel consistency
- IP uniqueness
- Hostname consistency
- And ~30 more

**Example:**
```bash
# List available predefined checks
list_predefined.py

# Create a predefined check
create_check.py --network-id NET_xyz --type Predefined \
    --name "BGP adjacency" \
    --predefined-type BGP_NEIGHBOR_ADJACENCY
```

**Common predefined types:**
- `BGP_NEIGHBOR_ADJACENCY` — all BGP neighbors are in established state
- `BGP_ROUTER_ID` — router IDs are unique
- `IP_UNIQUENESS` — no duplicate IPs
- `VLAN_CONSISTENCY` — VLAN configs match across trunk links
- `MTU_CONSISTENCY` — MTU values align on connected interfaces
- `TRUNK_INTERFACE_WHITELIST` — only approved VLANs on trunks
- `VPC_PARAMETER_CONSISTENCY` — VPC peer parameters match

See `list_predefined.py` output for the full catalog.

## Comparison table

| Type | Asserts | Typical use | Input |
|---|---|---|---|
| Existential | Traffic is allowed | Positive reachability | 5-tuple |
| Isolation | Traffic is blocked | Security segmentation | 5-tuple |
| Reachability | Traffic reaches destination | End-to-end delivery | 5-tuple |
| NQE | Query returns no violations | Custom policy | Query ID |
| Predefined | Built-in rule satisfied | Standard validations | Type + params |

## Integration with path analysis

**Checks vs. ad-hoc path searches:**

| Use case | Tool |
|---|---|
| "Can A reach B right now?" | `forward-path-analysis` |
| "Ensure A can always reach B" | `forward-intent-check` (Existential) |
| "Why is this dropping?" | `forward-path-analysis` |
| "Alert if this starts dropping" | `forward-intent-check` (Existential) |
| "Find all policy violations between X and Y" | `forward-path-analysis` with `VIOLATIONS_ONLY` |
| "Continuously monitor for violations" | `forward-intent-check` (Existential or Isolation) |

**Recommended workflow:**
1. Use `forward-path-analysis` to validate behavior interactively
2. Once confirmed, codify as a check via `create_check.py`
3. The check automatically re-evaluates on every future snapshot

## Check lifecycle

1. **Creation:** check is defined on a snapshot
2. **Evaluation:** check runs immediately (synchronous)
3. **Propagation:** by default, check propagates to all future snapshots
4. **Re-evaluation:** check re-runs on every new snapshot
5. **Failure:** if a check fails, diagnosis is available via `get_check.py`
6. **Deletion:** check is deactivated for current and future snapshots

**Persistent vs. transient:**
- **Persistent** (default): check propagates forward to all future snapshots
- **Transient** (`--persistent false`): check evaluates once, doesn't propagate
