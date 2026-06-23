#!/usr/bin/env python3
"""Audit AS-path-prepend-based traffic steering, network-wide.

Reads every router's post-policy Adj-RIB-In (BGP RIB state) and finds prefixes
where an INACTIVE path is losing path selection *purely* because of AS-path
prepending — i.e. if you collapsed the artificial prepend, that path would win
or tie the active one.

This is the audit for prepend-based plane/path steering: each finding is a
prefix that is being held on one path only by prepend. In a dual-plane backbone
mid-migration, that is exactly the set of prefixes still pinned to the old plane.

The prepend lives in BGP RIB STATE here:
  device.bgpRib.afiSafis[].neighbors[].adjRibInPost.routes[].pathAttributes[].asPath.members
The forwarding table (AFT/FIB) does NOT carry AS_PATH, so it cannot show this.

Verdicts:
  WOULD-WIN  collapsed (de-prepended) path is strictly shorter than the active
             path → prepend is the *sole* reason it loses.
  WOULD-TIE  collapsed path equals the active path length → prepend is breaking
             an otherwise-even contest (other tie-breakers would then decide).
"""
import argparse
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401 — puts forward_client on sys.path
from forward_client import ForwardClient, ForwardError, emit_json, die

RIB_QUERY = """
foreach device in network.devices
foreach af in device.bgpRib.afiSafis
foreach nb in af.neighbors
foreach r in nb.adjRibInPost.routes
foreach pa in r.pathAttributes
select {
  device: device.name,
  vrf: r.vrf,
  prefix: r.prefix,
  recvFrom: nb.neighborAddress,
  asPath: pa.asPath.members,
  active: pa.activeRoute
}
"""


def collapse(seq):
    """Collapse consecutive duplicate ASes (the prepend) into one each."""
    out = []
    for a in seq or []:
        if not out or out[-1] != a:
            out.append(a)
    return out


def lead(seq):
    return seq[0] if seq else None


def prepended_as(seq):
    """The AS being artificially repeated (the one doing the prepending)."""
    for i in range(len(seq or []) - 1):
        if seq[i] == seq[i + 1]:
            return seq[i]
    return None


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--network-id", required=True)
    ap.add_argument("--snapshot-id", help="default: latest processed")
    ap.add_argument("--device", help="restrict to one observing device (post-filter)")
    ap.add_argument("--vrf", help="restrict to one VRF (post-filter)")
    ap.add_argument("--include-ties", action="store_true",
                    help="also report WOULD-TIE findings (default: WOULD-WIN only)")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    client = ForwardClient.from_env()
    if not args.snapshot_id:
        nets = client.get("/api/networks")
        net = next((n for n in nets if n["id"] == args.network_id), None)
        if not net:
            die(f"Network {args.network_id} not found")
        args.snapshot_id = str(net.get("latestProcessedSnapshotId", ""))
        if not args.snapshot_id:
            snaps = client.get(f"/api/networks/{args.network_id}/snapshots")
            snaps = snaps.get("snapshots", snaps) if isinstance(snaps, dict) else snaps
            proc = [s for s in snaps if s.get("state") == "PROCESSED"]
            if not proc:
                die(f"Network {args.network_id} has no processed snapshots")
            args.snapshot_id = max(proc, key=lambda s: int(s["id"]))["id"]

    print(f"Reading BGP RIB state (snapshot {args.snapshot_id})...", file=sys.stderr)
    body = {"query": RIB_QUERY.strip(),
            "queryOptions": {"offset": 0, "limit": 10000}}
    try:
        res = client.post("/api/nqe", body=body,
                          query={"networkId": args.network_id, "snapshotId": args.snapshot_id})
    except ForwardError as e:
        die(f"RIB query failed: {e}")
    rows = res.get("items", [])
    if args.device:
        rows = [r for r in rows if r["device"] == args.device]
    if args.vrf:
        rows = [r for r in rows if r["vrf"] == args.vrf]

    # group paths by (observing device, vrf, prefix)
    groups = defaultdict(list)
    for r in rows:
        groups[(r["device"], r["vrf"], r["prefix"])].append(r)

    findings = []
    for (device, vrf, prefix), paths in groups.items():
        actives = [p for p in paths if p["active"]]
        inactives = [p for p in paths if not p["active"]]
        if not actives or not inactives:
            continue
        best_active = min(actives, key=lambda p: len(p["asPath"] or []))
        a_len = len(best_active["asPath"] or [])
        for p in inactives:
            ap_members = p["asPath"] or []
            col = collapse(ap_members)
            has_prepend = len(ap_members) > len(col)
            if not has_prepend or len(ap_members) <= a_len:
                continue
            if len(col) < a_len:
                verdict = "WOULD-WIN"
            elif len(col) == a_len:
                verdict = "WOULD-TIE"
            else:
                continue  # collapsed still longer → not purely prepend
            if verdict == "WOULD-TIE" and not args.include_ties:
                continue
            findings.append({
                "device": device, "vrf": vrf, "prefix": prefix, "verdict": verdict,
                "activeFrom": best_active["recvFrom"], "activeAsPath": best_active["asPath"],
                "activeLeadAs": lead(best_active["asPath"]),
                "losingFrom": p["recvFrom"], "losingAsPath": ap_members,
                "losingLeadAs": lead(ap_members),
                "prependedAs": prepended_as(ap_members),
                "prependCount": len(ap_members) - len(col),
            })

    findings.sort(key=lambda f: (f["device"], f["vrf"], f["prefix"]))

    if args.json:
        emit_json({"snapshotId": args.snapshot_id, "findingCount": len(findings),
                   "findings": findings})
        return

    if not findings:
        print("No prefixes are losing purely on AS-path prepend "
              "(no prepend-only steering found).", file=sys.stderr)
        return

    print(f"\n{len(findings)} prefix path(s) losing purely on AS-prepend "
          f"(snapshot {args.snapshot_id}):\n")
    print(f"{'observer':<12} {'vrf':<8} {'prefix':<16} {'verdict':<10} "
          f"{'prepAS':<7} {'xN':<3} losing-asPath")
    for f in findings:
        print(f"{f['device']:<12} {f['vrf']:<8} {f['prefix']:<16} {f['verdict']:<10} "
              f"{str(f['prependedAs']):<7} {f['prependCount']:<3} {f['losingAsPath']}")

    # steering summary: which AS is self-prepending to suppress its own paths
    by_as = defaultdict(lambda: defaultdict(int))
    for f in findings:
        by_as[f["prependedAs"]][f["verdict"]] += 1
    print("\nsteering summary (AS self-prepending to suppress its own path):")
    for asn, verd in sorted(by_as.items(), key=lambda x: -sum(x[1].values())):
        tot = sum(verd.values())
        detail = ", ".join(f"{v} {k}" for k, v in sorted(verd.items()))
        print(f"  AS{asn}: {tot} prefix-path(s) suppressed  ({detail})")


if __name__ == "__main__":
    main()
