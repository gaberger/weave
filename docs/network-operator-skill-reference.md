# AI Network Operator Skill — Reference Guide

Research-backed specification for building an AI network operator as weave skills.  
Sources: RFCs (IETF), vendor design guides (Cisco/Arista/Juniper/Nokia), MANRS, RPKI, ETSI ENI, ITU-T Y.3172, IETF NMOP WG.

---

## Architecture Overview

The AI network operator decomposes into three layers, each governed by distinct standards:

```
Layer A — Static Correctness (NQE / Digital Twin)
  Governing: RFC 8969 (service/network/device intent model), RFC 8345 (topology)
             IETF NMOP SIMAP draft (multi-layer correlation context)
  What: Config and state vs. declared intent on every snapshot
  How:  Forward NQE queries — the natural home for ALL checks here

Layer B — Anomaly Detection (Streaming Telemetry)
  Governing: RFC 8641 (YANG-Push), IETF NMOP anomaly-architecture/-semantics/-lifecycle
             ITU-T Y.3172 (ML pipeline), ETSI ENI GS ENI 005 (OODA loops)
  What: BGP flaps, interface drops, churn events BETWEEN snapshots
  How:  gNMI/OpenConfig or YANG-Push → Kafka → ML detectors
  Note: NQE CANNOT see transient events between snapshots

Layer C — Remediation (NETCONF/CLI with human gate)
  Governing: RFC 6241 (NETCONF), RFC 8040 (RESTCONF), NMOP incident-yang draft
  What: Push corrective configs after Layer B detects + Layer A provides context
  How:  NETCONF atomic commit/rollback; CLI as fallback
```

**Key integration pattern**: When Layer B detects an anomaly, it triggers a targeted NQE
query (Layer A) to provide structural context before any Layer C remediation is attempted.
This "NQE-as-context-provider" pattern is documented in IETF NMOP anomaly architecture.

**Production validation**: Swisscom has run this architecture monitoring 13,000+ L3 VPNs
since June 2024 (NMOP anomaly lifecycle draft, Appendix).

---

## Vendor Parameter Reference

Cross-vendor parameters for SR-MPLS domains. Inconsistency in SRGB is the most common
multi-vendor interop failure mode (RFC 8402: anycast groups with mismatched SRGBs
route to wrong nodes; debugging is extremely difficult).

### SRGB (Segment Routing Global Block)

| Vendor     | Default SRGB Base | Range  | Notes                                      |
|------------|-------------------|--------|--------------------------------------------|
| Cisco IOS-XR | 16,000          | 8,000  | Strongly recommends keeping default        |
| Nokia SR OS  | No default       | —      | Common examples use 16,000 to match IOS-XR |
| Juniper JunOS | No default      | —      | Canonical docs: 800,000 / 40,000 range     |
| Arista EOS   | **900,000**      | 65,536 | Platform default; must be explicit in multi-vendor |

SRLB (adjacency SIDs): Cisco IOS-XR default 15,000–15,999.

### BGP Timers

| Vendor     | Keepalive | Hold  | Recommended approach              |
|------------|-----------|-------|-----------------------------------|
| Cisco IOS-XR | 60s     | 180s  | Leave at default; use BFD instead |
| Nokia SR OS  | 30s     | 90s   | Leave at default; use BFD         |
| Juniper JunOS | 30s    | 90s   | Set `minimum-hold-time 20`        |
| Arista EOS   | 60s     | 180s  | Reduce + BFD for overlay; LFS handles underlay |

**All vendors agree**: Tune BFD, not BGP timers, for fast failure detection.

### BFD Timers

| Profile      | Tx/Rx  | Multiplier | Detection | Requirement                     |
|--------------|--------|------------|-----------|---------------------------------|
| Aggressive   | 50ms   | 3          | 150ms     | HW/NPU offload mandatory        |
| Standard     | 100ms  | 3          | 300ms     | HW offload recommended          |
| Conservative | 300ms  | 3          | 900ms     | Safe for software BFD at scale  |
| WAN          | 1000ms | 3          | 3000ms    | Avoids false positives on WAN   |

Cisco IOS-XR: 50ms with NPU echo mode; 300ms+ for software at scale.  
Juniper: 100ms distributed (line-card), 300ms RE-based.  
Nokia: 100ms with CPM-NP; 10ms possible but rarely warranted.  
Arista: BFD not recommended on directly-connected links with LFS (10/40/100G) — LFS handles it.

### MTU

| Vendor     | GigE+ interface MTU | MTU counting |
|------------|---------------------|--------------|
| Cisco IOS-XR | mtu 9014 = 9000-byte IP MTU | Includes 14-byte Ethernet header |
| Cisco IOS    | ip mtu 9000         | IP MTU directly                  |
| Nokia SR OS  | 9212 bytes          | GigE+ hardware max               |
| Arista EOS   | 9214 bytes          | Platform max; AVD default 9000   |
| Juniper      | 9192 bytes          | Common jumbo value               |

**MPLS MTU formula** (RFC 3032 + RFC 4459):
```
interface_mtu >= ip_mtu + (label_stack_depth × 4)
# Standard L3VPN (2 labels):       ip_mtu + 8
# SR-MPLS L3VPN + TI-LFA (5 labels): ip_mtu + 20
# EVPN VXLAN:                       ip_mtu + 50
```

### QoS Models

| Vendor     | Queue model  | Key DSCP assignments                             |
|------------|--------------|--------------------------------------------------|
| Cisco IOS-XR | 4-class or 8-class SP | Voice=EF(46), Video=AF41(34), Call-sig=CS3(24)* |
| Nokia SR OS  | 8 fixed FCs  | nc/h1/ef/h2/l1/af/l2/be; EXP 7→nc, 5→ef       |
| Juniper JunOS | 4-class default | be/ef/af/nc; up to 8 on MX/PTX            |
| Arista EOS   | Per policy   | RFC 4594-based with operator customization       |

*Cisco uses CS3 for call-signaling instead of RFC 4594's CS5 — a common interop trap.

---

## Check Catalog

### Category 1: Segment Routing Integrity

Priority: implement these first — SR SID misconfigurations cause silent traffic misrouting.

| Check ID | RFC | Severity | Description | NQE concept |
|----------|-----|----------|-------------|-------------|
| SR-01 | RFC 8402 | CRITICAL | Prefix-SID collision (same SID, different prefix) | `foreach prefix where prefixSID: assert SID unique across domain` |
| SR-02 | RFC 8402 | HIGH | SRGB inconsistent across SR domain nodes | `foreach device: assert srgb.base == domain_base AND srgb.range == domain_range` |
| SR-03 | RFC 8660 | HIGH | SRGB base overlaps reserved labels (0–15) | `foreach device: assert srgb.base >= 16` |
| SR-04 | RFC 8660 | HIGH | SRGB ranges overlap within a multi-range SRGB | `foreach device: check each SRGB range pair for overlap` |
| SR-05 | RFC 8667 | HIGH | SR Algorithm 0 (SPF) missing from SR-Algorithm TLV | `foreach sr_device: assert 0 in isis.srAlgorithms` |
| SR-06 | RFC 8667 | HIGH | Prefix-SID uses algorithm not advertised by that node | `foreach prefix: assert prefixSID.algorithm in device.srAlgorithms` |
| SR-07 | RFC 8667 | HIGH | R-flag not set on IS-IS redistributed prefix-SID | `foreach redistributedPrefix: assert prefixSID.rFlag == true` |
| SR-08 | RFC 8665 | HIGH | Duplicate Prefix-SID sub-TLVs for same <prefix,topo,algo> | `foreach ospf: alert if same (prefix,topology,algorithm) has >1 Prefix-SID — all will be silently ignored` |
| SR-09 | RFC 8665 | HIGH | NP-flag not set on OSPF inter-area/redistributed prefix | `foreach interAreaPrefix: assert prefixSID.npFlag == true` |
| SR-10 | RFC 8661 | HIGH | No SRMS present when non-SR nodes exist in domain | `if any device where !srCapable: assert domain.srmsPresent` |
| SR-11 | RFC 8661 | HIGH | SR-LDP interworking not configured on boundary node | `foreach device where hasSRNeighbors AND hasLDPNeighbors: assert srLdpInterworking.enabled` |
| SR-12 | RFC 8402 | HIGH | Domain boundary not filtering external SR segment labels | `foreach borderRouter: assert externalSRLabelFilter configured` |
| SR-13 | RFC 8667 | MEDIUM | Adjacency SID without P-flag where persistence required | `foreach adjSID where persistenceRequired: assert pFlag == true` |
| SR-14 | RFC 5305 | MEDIUM | TE Router ID TLV missing on TE-capable IS-IS node | `foreach device where isis.teCapable: assert isis.teRouterID exists` |

### Category 2: BGP Session Health

| Check ID | RFC | Severity | Description | NQE concept |
|----------|-----|----------|-------------|-------------|
| BGP-01 | RFC 4271 | HIGH | BGP neighbor not Established and not admin-shutdown | `foreach bgpNeighbor where state != "Established" and !adminShutdown` |
| BGP-02 | RFC 4271 | CRITICAL | BGP NEXT_HOP not reachable in RIB | `foreach bgpRib where nhReachable == false and bestPath == true` |
| BGP-03 | RFC 4271 | CRITICAL | AS_PATH contains local AS (loop) | `foreach bgpRib where asPath contains localAS` |
| BGP-04 | RFC 4271 | HIGH | LOCAL_PREF present on eBGP received route | `foreach bgpRib[eBGP] where localPref != null` |
| BGP-05 | RFC 4271 | HIGH | Hold time < 3 seconds (RFC minimum) | `foreach bgpNeighbor where negotiatedHoldTime > 0 and negotiatedHoldTime < 3` |
| BGP-06 | RFC 4760 | HIGH | AFI/SAFI activated but not negotiated with peer | `foreach bgpNeighbor where activatedAF not in negotiatedCapabilities` |
| BGP-07 | RFC 7607 | CRITICAL | AS 0 in received AS_PATH | `foreach bgpRib where asPath contains "0"` |
| BGP-08 | RFC 4456 | HIGH | Route reflector missing cluster-ID | `foreach device where rrEnabled: assert clusterId != null` |
| BGP-09 | RFC 4456 | HIGH | Only one route reflector in a cluster (SPOF) | `foreach rrCluster where rrCount < 2` |
| BGP-10 | RFC 4456 | HIGH | ORIGINATOR_ID matches local router (route back to originator) | `foreach bgpRib where originatorId == localRouterId` |
| BGP-11 | RFC 4456 | MEDIUM | Duplicate cluster-ID across different clusters | `foreach pair(rrA,rrB) where clusterId matches but cluster differs` |
| BGP-12 | RFC 9234 | HIGH | eBGP neighbor without peer-role configured (OTC blind) | `foreach bgpNeighbor[eBGP] where peerRole == null` |
| BGP-13 | RFC 9234 | CRITICAL | Route with OTC attribute advertised to non-customer peer | `foreach advertisedRoute where otcAttribute and peerRole in ["peer","provider"]` |
| BGP-14 | RFC 8327 | HIGH | GSHUT community (65535:0) received but LOCAL_PREF not 0 | `foreach bgpRib where communities contains "65535:0" and localPref != 0` |
| BGP-15 | RFC 7938 | CRITICAL | Duplicate ASN assigned to multiple DC fabric nodes | `foreach pair(A,B) where localAS matches and role in ["leaf","spine"]` |
| BGP-16 | RFC 7938 | HIGH | iBGP session in a pure eBGP DC fabric | `foreach bgpNeighbor[fabricDevice] where peerType == "iBGP"` |
| BGP-17 | RFC 5880/5882 | HIGH | eBGP session without BFD (hold timer = 180s sole failover) | `foreach bgpNeighbor[eBGP] where bfdEnabled == false` |
| BGP-18 | RFC 5882 | HIGH | BFD session Down but BGP still Established | `foreach bgpNeighbor where bfdState == "Down" and bgpState == "Established"` |
| BGP-19 | RFC 5880 | MEDIUM | BFD detection time > 3000ms (slow failover) | `foreach bfdSession where (tx * multiplier) > 3000` |

### Category 3: BGP Security and Prefix Filtering

| Check ID | RFC/Source | Severity | Description | NQE concept |
|----------|-----------|----------|-------------|-------------|
| SEC-01 | RFC 7454 | HIGH | No inbound prefix filter on eBGP session | `foreach bgpNeighbor[eBGP] where inboundFilter == null` |
| SEC-02 | RFC 7454 | HIGH | No outbound prefix filter on eBGP session | `foreach bgpNeighbor[eBGP] where outboundFilter == null` |
| SEC-03 | RFC 7454 | HIGH | No max-prefix limit on eBGP session | `foreach bgpNeighbor[eBGP] where maxPrefix == null` |
| SEC-04 | RFC 7454 | MEDIUM | max-prefix set to warning-only (no enforcement) | `foreach bgpNeighbor where maxPrefixAction == "warning-only"` |
| SEC-05 | RFC 7454 | MEDIUM | No AS path length filter on eBGP | `foreach bgpNeighbor[eBGP] where asPathLengthFilter == null` |
| SEC-06 | RFC 7454 | MEDIUM | Private ASN in AS_PATH from eBGP peer | `foreach bgpRib[eBGP] where asPath intersects privateASNs` |
| SEC-07 | RFC 6811 | CRITICAL | RPKI-invalid route installed as best path | `foreach bgpRib where rpkiState == "INVALID" and bestPath == true` |
| SEC-08 | RFC 6811 | HIGH | RPKI not enabled on eBGP device | `foreach device[eBGP] where rpkiEnabled == false` |
| SEC-09 | RFC 6811 | HIGH | RPKI RTR session not Established | `foreach device where rpkiEnabled and rtrSessionState != "Established"` |
| SEC-10 | RFC 5082 | HIGH | No TTL security (GTSM) on directly-connected eBGP | `foreach bgpNeighbor[eBGP] where ttlSecurity == false and !ebgpMultihop` |
| SEC-11 | RFC 5925 | HIGH | No TCP-AO or MD5 auth on eBGP session | `foreach bgpNeighbor[eBGP] where tcpAO == null and tcpMD5 == null` |
| SEC-12 | BOGON | CRITICAL | Bogon prefix accepted from eBGP peer | `foreach bgpRib[eBGP] where prefix in bogonList` |
| SEC-13 | BOGON | CRITICAL | Local device advertising bogon to eBGP peer | `foreach advertisedRoute[eBGP] where prefix in bogonList` |
| SEC-14 | MANRS | HIGH | No bogon filter configured on eBGP session | `foreach bgpNeighbor[eBGP] where bogonFilterApplied == false` |
| SEC-15 | RFC 1997 | HIGH | NO_EXPORT (65535:65281) present on eBGP advertised route | `foreach advertisedRoute[eBGP] where communities contains "65535:65281"` |
| SEC-16 | RFC 1997 | CRITICAL | NO_ADVERTISE (65535:65282) route being advertised to any peer | `foreach advertisedRoute where communities contains "65535:65282"` |
| SEC-17 | RFC 7999 | HIGH | Blackhole community (65535:666) without null route installed | `foreach bgpRib where communities contains "65535:666" and !nullRouteInstalled` |
| SEC-18 | RFC 7999 | MEDIUM | Blackhole community without NO_EXPORT (risk of leak) | `foreach bgpRib where communities contains "65535:666" and !"65535:65281" in communities` |
| SEC-19 | RFC 6996 | HIGH | Documentation ASN (64496–64511, 65536–65551) in production | `foreach bgpNeighbor where remoteAS in docASNRanges` |

### Category 4: IGP Health (IS-IS / OSPF)

| Check ID | RFC | Severity | Description | NQE concept |
|----------|-----|----------|-------------|-------------|
| IGP-01 | RFC 2328 | HIGH | OSPF adjacency not in Full/2-Way state | `foreach ospfNeighbor where state not in ["Full","2-Way"]` |
| IGP-02 | RFC 2328 | HIGH | OSPF Hello/Dead interval mismatch on link | `foreach ospfLink: assert local.helloInterval == remote.helloInterval` |
| IGP-03 | RFC 2328 | HIGH | OSPF area type mismatch (stub vs non-stub) | `foreach ospfArea: assert all members have same stub config` |
| IGP-04 | RFC 2328 | HIGH | Duplicate OSPF Router ID in area | `foreach pair(A,B) where ospf.routerID matches` |
| IGP-05 | RFC 5340 | HIGH | OSPFv3 Instance ID mismatch on link | `foreach ospfv3Link: assert localInstanceID == remoteInstanceID` |
| IGP-06 | RFC 5340 | HIGH | OSPFv3 Router ID is 0.0.0.0 (reserved) | `foreach device where ospfv3.routerID == "0.0.0.0"` |
| IGP-07 | RFC 7775 | HIGH | L1 route leaked to L2 without up/down bit set | `foreach route where originLevel=="L1" and advertisedToL2 and !upDownBit` |
| IGP-08 | RFC 8405 | MEDIUM | IGP SPF timers not following RFC 8405 defaults | `foreach igp: verify spfInitial==50ms, spfIncr==200ms, spfMax==5000ms` |
| IGP-09 | RFC 5305 | MEDIUM | TE-capable IS-IS node missing TE Router ID TLV | `foreach device where isis.teCapable: assert isis.teRouterID exists` |

### Category 5: LDP Health

| Check ID | RFC | Severity | Description | NQE concept |
|----------|-----|----------|-------------|-------------|
| LDP-01 | RFC 5036 | HIGH | LDP session missing for IGP neighbor | `foreach device where ldp.enabled: assert ldpSession exists for each igpNeighbor` |
| LDP-02 | RFC 7552 | HIGH | LDP-IGP sync not enabled on LDP interface | `foreach interface where ldp.enabled and igp.enabled: assert ldpIgpSync.enabled` |
| LDP-03 | RFC 7552 | HIGH | LDP-IGP sync hold timer is 0 (sync disabled) | `foreach interface where ldpIgpSync.enabled: assert holdTimer > 0` |
| LDP-04 | RFC 5036 | MEDIUM | LDP transport address differs from router-id | `foreach device: assert ldp.transportAddress == routerID` |

### Category 6: L3VPN Integrity

| Check ID | RFC | Severity | Description | NQE concept |
|----------|-----|----------|-------------|-------------|
| VPN-01 | RFC 4364 | CRITICAL | VRF RT asymmetry (export RT not imported by any remote VRF) | `foreach vrf: assert (vrf.exportRT ∩ anyRemoteVRF.importRT) != ∅` |
| VPN-02 | RFC 4364 | CRITICAL | Duplicate RD on same PE across different VRFs | `foreach pe: assert all VRF RDs are unique` |
| VPN-03 | RFC 4364 | HIGH | VPNv4/VPNv6 routes in BGP RIB not installed in VRF | `foreach pe,vrf: count(bgpVPNv4 filtered by importRT) == count(vrf.rib)` |
| VPN-04 | RFC 4364 | HIGH | Multi-homed CE missing Site of Origin community | `foreach pe_ce_session where ceHasBackupPE: assert sooConfigured` |
| VPN-05 | RFC 4364 | MEDIUM | VPNv4 AFI active without MPLS forwarding enabled | `foreach device where bgpAF contains "VPNv4" and !mplsEnabled` |

### Category 7: EVPN Consistency

| Check ID | RFC | Severity | Description | NQE concept |
|----------|-----|----------|-------------|-------------|
| EVPN-01 | RFC 7432 | CRITICAL | ESI collision (same ESI on PEs not sharing that segment) | `foreach esi where esi != 0: assert assigned to exactly expected PEs` |
| EVPN-02 | RFC 7432 | HIGH | Duplicate RD across EVPN MAC-VRFs on same PE | `foreach pe: assert all evpn mac-vrf RDs are unique` |
| EVPN-03 | RFC 7432 | HIGH | Multiple PEs advertising same MAC without MAC Mobility community | `foreach mac where type2Routes > 1: assert all carry MAC Mobility community` |
| EVPN-04 | RFC 7432 | HIGH | DF election inconsistency (>1 DF or 0 DF for same ESI+VLAN) | `foreach (esi,vlan): assert exactly one DF PE` |
| EVPN-05 | RFC 7432 | MEDIUM | Sticky MAC receiving a move advertisement | `foreach type2Route where stickyBit and seqNum > 0` |
| EVPN-06 | RFC 8365 | MEDIUM | EVPN-VXLAN with 4-byte AS using auto-derived RT (unsupported) | `foreach device where localAS > 65535 and evpn.rtAuto == true` |

### Category 8: MTU Consistency

| Check ID | RFC | Severity | Description | NQE concept |
|----------|-----|----------|-------------|-------------|
| MTU-01 | RFC 4459 | HIGH | MPLS interface MTU insufficient for label stack | `foreach interface where mpls.enabled: assert mtu >= ipMtu + (labelDepth * 4)` |
| MTU-02 | RFC 4459 | HIGH | MTU mismatch on MPLS LSP path | `foreach lsp: assert min(interface.mtu for interface in path) >= 1508` |
| MTU-03 | RFC 5340 | HIGH | IPv6 interface MTU below minimum (1280 bytes) | `foreach interface where ipv6.enabled: assert mtu >= 1280` |
| MTU-04 | RFC 2328 | HIGH | OSPF MTU mismatch causing Exchange/Loading stall | `foreach ospfNeighbor where state in ["Exchange","Loading"]: check MTU symmetry` |
| MTU-05 | Vendor | MEDIUM | Core MPLS interface not set to jumbo MTU | `foreach coreInterface where mpls.enabled: assert mtu >= 9000` |

### Category 9: Convergence and Resilience

| Check ID | RFC | Severity | Description | NQE concept |
|----------|-----|----------|-------------|-------------|
| CONV-01 | RFC 9855 | HIGH | Prefix without FRR backup (no LFA or TI-LFA) | `foreach prefix in rib: assert lfa_next_hop != null or ti_lfa_repair_list != null` |
| CONV-02 | RFC 7130 | HIGH | LAG member without micro-BFD session | `foreach lagMember: assert microBfd.state == "Up"` |
| CONV-03 | RFC 5882 | MEDIUM | IGP core link without BFD | `foreach coreLink where role in ["backbone","transit"]: assert bfd.enabled` |
| CONV-04 | RFC 4090 | MEDIUM | RSVP-TE protected LSP missing bypass tunnel at PLR | `foreach protectedLsp, foreach plr: assert plr.bypassTunnel exists` |
| CONV-05 | RFC 5880 | MEDIUM | BFD detection time > 1000ms on core link | `foreach bfdSession where isCorLink and detectionTime > 1000ms` |

---

## Implementation Phasing

### Phase 1 — Config-only checks (no RIB access, highest signal/noise ratio)

These checks query device configuration only — available on every Forward Networks snapshot
and have low false-positive rates.

1. SEC-01/02/03 — Missing prefix/max-prefix filters on eBGP
2. SEC-10/11 — No GTSM or auth on eBGP
3. SEC-14 — No bogon filter configured
4. SR-02 — SRGB inconsistency across domain
5. SR-05 — SR Algorithm 0 missing
6. SR-10 — No SRMS when non-SR nodes present
7. BGP-08/09 — RR missing cluster-ID or single RR
8. BGP-15 — Duplicate ASNs in DC fabric
9. LDP-02/03 — LDP-IGP sync disabled
10. VPN-05 — VPNv4 AFI without MPLS

### Phase 2 — Protocol state correlation

These require access to routing table / protocol state (bgpNeighborState, bgpRib, ospfNeighbor).

1. BGP-01 — Sessions not Established
2. BGP-02/03 — NEXT_HOP unreachable, AS_PATH loop
3. BGP-07 — AS 0 in AS_PATH
4. SEC-07 — RPKI-invalid best path
5. SEC-12/13 — Bogon in RIB or being advertised
6. SEC-15/16 — NO_EXPORT / NO_ADVERTISE violated
7. BGP-18 — BFD down, BGP still Established
8. IGP-01/02/03 — OSPF adjacency problems
9. LDP-01 — Missing LDP sessions for IGP neighbors
10. VPN-01/02/03 — RT asymmetry, duplicate RD, missing VRF routes

### Phase 3 — Cross-domain policy correctness

Require correlating config model against RIB (e.g., community policy enforcement).

1. BGP-14 — GSHUT community not setting LOCAL_PREF=0
2. SEC-17/18 — Blackhole community without null route / without NO_EXPORT
3. BGP-13 — OTC attribute advertised to non-customer peer
4. SEC-04 — max-prefix warning-only
5. EVPN-01/04 — ESI collision, DF inconsistency
6. VPN-04 — Multi-homed CE missing SOO

---

## Checks Requiring External Enrichment

These cannot be answered from the Forward Networks digital twin alone:

| Check | External source needed |
|-------|----------------------|
| RPKI ROA validation | RPKI RTR cache or Cloudflare RPKI API |
| IRR prefix list derivation | RIPE NCC, ARIN, RADB WHOIS/query APIs |
| MANRS Action 3 (AS contact registered) | IRR/WHOIS lookup |
| BGP-12 documentation ASN in AS_PATH | BGP RIB enrichment (Forward NQE has AS_PATH if device reports it) |

---

## Key RFC Quick Reference

| RFC | Title | Key operator check |
|-----|-------|--------------------|
| RFC 4271 | BGP-4 | Session state, AS_PATH loop, NEXT_HOP reachability |
| RFC 4364 | BGP/MPLS IP VPNs (L3VPN) | RT symmetry, RD uniqueness, VRF route count |
| RFC 4456 | BGP Route Reflection | Cluster-ID, ORIGINATOR_ID, RR redundancy |
| RFC 4760 | Multiprotocol BGP | AFI/SAFI negotiation, VPNv4 requires MPLS |
| RFC 5036 | LDP | Session coverage, transport address consistency |
| RFC 5286 | LFA | FRR coverage per prefix |
| RFC 5880 | BFD | Timer negotiation, detection time limits |
| RFC 5882 | BFD Applications | eBGP requires BFD; IGP BFD on core links |
| RFC 6811 | RPKI Origin Validation | INVALID routes must not be best path |
| RFC 7130 | BFD on LAG | Micro-BFD per member link |
| RFC 7432 | BGP EVPN | ESI uniqueness, MAC mobility, DF election |
| RFC 7454 | BGP Operations & Security | Filters, max-prefix, auth — the BCP for eBGP |
| RFC 7490 | Remote LFA | PQ-node repair for coverage gaps |
| RFC 7552 | LDP-IGP Sync | Sync required to prevent black holes during LDP convergence |
| RFC 7607 | AS 0 Processing | AS 0 in AS_PATH is CRITICAL |
| RFC 7938 | BGP for Large-Scale DCs | Unique ASNs per leaf, eBGP-only fabric |
| RFC 7999 | Blackhole Community | 65535:666 + null route + NO_EXPORT |
| RFC 8201 | IPv6 PMTUD | 1280-byte minimum MTU |
| RFC 8212 | Default eBGP Policy | No implicit accept without explicit policy |
| RFC 8327 | Graceful Shutdown | 65535:0 → LOCAL_PREF 0 |
| RFC 8365 | EVPN for NVO3 | VXLAN EVPN, Local Bias for split-horizon |
| RFC 8402 | SR Architecture | Prefix-SID uniqueness, SRGB consistency |
| RFC 8405 | IGP SPF Back-Off | 50ms/200ms/5000ms SPF delay defaults |
| RFC 8641 | YANG-Push | Streaming telemetry source for Layer B |
| RFC 8660 | SR-MPLS Dataplane | SRGB reserved label check, neighbor SRGB for label computation |
| RFC 8661 | SR-LDP Interworking | SRMS requirement, SR-LDP boundary nodes |
| RFC 8667 | IS-IS SR Extensions | Algorithm 0 required, R-flag, SID uniqueness |
| RFC 8969 | YANG Network Automation | Three-layer intent model (service/network/device) |
| RFC 9234 | Route Leak Prevention | OTC attribute handling, peer-role configuration |
| RFC 9855 | TI-LFA | 100% FRR coverage with SR repair paths |
| RFC 4090 | RSVP-TE FRR | Bypass tunnel coverage at each PLR |
| RFC 4459 | MTU in Tunnels | MPLS MTU formula, PMTUD black hole prevention |
| RFC 3032 | MPLS Label Stack | 4 bytes per label, MTU implications |

---

## Weave Skill Architecture

Recommended structure for the AI network operator as weave skills:

```
skills/
  network-operator/
    bgp-health.mjs          # Phase 1+2 BGP checks (SEC-*, BGP-*)
    sr-integrity.mjs        # SR-MPLS domain consistency (SR-*)
    igp-health.mjs          # IS-IS/OSPF adjacency and config (IGP-*)
    ldp-coverage.mjs        # LDP session and sync (LDP-*)
    vpn-integrity.mjs       # L3VPN and EVPN consistency (VPN-*, EVPN-*)
    mtu-consistency.mjs     # MTU across MPLS paths (MTU-*)
    convergence-check.mjs   # FRR coverage, BFD, SPF timers (CONV-*)
    routing-security.mjs    # RPKI, MANRS, bogons (SEC-* security subset)

loops/
  network-operator-daily.mjs   # Schedule: run all Phase 1+2 checks per snapshot
  network-operator-alert.mjs   # Triggered: run targeted checks when anomaly signaled
```

Each skill follows the pattern:
1. Query Forward NQE for relevant device/protocol state
2. Apply RFC-mandated invariants from this catalog
3. Return structured findings with: check_id, severity, device, description, reference
4. High-severity findings trigger notification; all findings go to knowledge bundle

The `network-operator-alert` loop implements the Layer B → Layer A integration:
when a streaming telemetry anomaly is detected externally, it calls the targeted
NQE skill to provide structural context before any remediation is considered.
