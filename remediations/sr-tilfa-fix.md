# Remediation Plan — SR Backbone TI-LFA Fast-Reroute

**Finding:** `nqe/sr-tilfa-coverage.nqe` — 16 IS-IS SR core links across all 8 SR nodes
have no TI-LFA protection (no per-interface `isis ti-lfa` and no global
`fast-reroute ti-lfa`). A link/node failure falls back to full IGP reconvergence
(seconds), not sub-50ms reroute.

**Network:** 111 (Dual-Backbone) · snapshot 155 · all nodes Arista EOS (cEOSLab)
**Scope:** 8 SR nodes, all running `router isis Gandalf`:
`s-p-ny`, `s-p-lon`, `s-p-tok`, `s-pe-ny`, `s-pe-lon`, `s-pe-tok`, `s-rr-ny`, `s-rr-lon`

> Status: **PLAN ONLY — no devices touched, no Forward model changed.**

## Why the global form

`fast-reroute ti-lfa mode link-protection level-2` under the IGP address-family
protects every IS-IS interface at once — 8 stanzas close all 16 gaps, and any new
core link inherits protection automatically (vs. 16 per-interface lines that must
be maintained). `timers local-convergence-delay protected-prefixes` suppresses
micro-loops during reconvergence (per the SR research deliverable).

## Config to apply (identical on all 8 nodes — `router isis Gandalf`)

```
router isis Gandalf
   timers local-convergence-delay protected-prefixes
   address-family ipv4 unicast
      fast-reroute ti-lfa mode link-protection level-2
```

### Per-device (EOS config session)

Apply on each of: s-p-ny, s-p-lon, s-p-tok, s-pe-ny, s-pe-lon, s-pe-tok, s-rr-ny, s-rr-lon

```
configure
router isis Gandalf
   timers local-convergence-delay protected-prefixes
   address-family ipv4 unicast
      fast-reroute ti-lfa mode link-protection level-2
end
write memory
```

## Verify (after a fresh snapshot)

```
run_query.py --network-id 111 --query-file nqe/sr-tilfa-coverage.nqe
# expect: 0 rows (violation==true count -> 0)
```
On-device: `show isis ti-lfa path` / `show isis segment-routing tunnel`.

## Rollback

```
configure
router isis Gandalf
   no address-family ipv4 unicast fast-reroute ti-lfa mode link-protection level-2
   no timers local-convergence-delay protected-prefixes
end
```

## Notes / out of scope

- **MTU 1370** (`nqe/mtu-consistency.nqe` flags `violation:true`, base < 1500) is
  *uniform* across all 32 core links — treat as "confirm intent," not auto-fix.
- TI-LFA on EOS is IS-IS-only; the LDP/OSPF backbone (`l-*`) uses LFA/other FRR and
  is not in scope for this change.
