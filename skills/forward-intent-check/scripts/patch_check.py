#!/usr/bin/env python3
"""Patch an existing check's metadata (note / tags / priority / name).

Forward checks are IMMUTABLE — the API has no PUT/PATCH (returns HTTP 405). This
script emulates an update with a **POST-replacement-then-DELETE-old** sequence:

  1. POST a new check carrying the SAME definition + the patched metadata
  2. DELETE the old check id
  3. If the delete fails (e.g. the check is referenced by a scorecard), the new
     check is rolled back (deleted) so you are never left with a duplicate.

Because of this, **the check id changes** on every patch. Definitions are NOT
patchable here (a different definition is a different check — use create_check.py).

Selection (combine freely; all are AND-ed):
  --check-id ID         one or more explicit ids
  --match-name SUBSTR   name contains SUBSTR (case-insensitive)
  --match-tag TAG       check currently carries TAG
  --status STATUS       PASS / FAIL / ERROR / TIMEOUT

Patches:
  --set-note TEXT       replace the note/intent description
  --add-tag TAG         add tag(s), merged with existing (repeatable)
  --remove-tag TAG      drop tag(s) (repeatable)
  --set-tags T [T ...]  replace the entire tag list (overrides add/remove)
  --priority P          LOW / MEDIUM / HIGH / NOT_SET
  --set-name NAME       rename (path-based checks only)

Nothing is written without --execute (default is a dry-run preview).
"""
import argparse
import sys

import _bootstrap  # noqa: F401 — puts forward_client on sys.path
from forward_client import ForwardClient, ForwardError, emit_json, die


def resolve_snapshot(client, network_id, snapshot_id):
    """Latest PROCESSED snapshot if not given (also avoids the 'no processed
    snapshots' false-negative some sibling scripts hit on PREDICT-only tips)."""
    if snapshot_id:
        return snapshot_id
    data = client.get(f"/api/networks/{network_id}/snapshots")
    snaps = data.get("snapshots", []) if isinstance(data, dict) else data
    processed = [s for s in snaps if s.get("state") == "PROCESSED"]
    if not processed:
        die(f"Network {network_id} has no PROCESSED snapshots")
    # ids are numeric strings; newest = max
    return max(processed, key=lambda s: int(s["id"]))["id"]


def list_checks(client, snapshot_id):
    data = client.get(f"/api/snapshots/{snapshot_id}/checks")
    return data.get("checks", data) if isinstance(data, dict) else data


def select(checks, args):
    ids = set(args.check_id or [])
    out = []
    for c in checks:
        if ids and c["id"] not in ids:
            continue
        if args.match_name and args.match_name.lower() not in c["name"].lower():
            continue
        if args.match_tag and args.match_tag not in (c.get("tags") or []):
            continue
        if args.status and c.get("status") != args.status:
            continue
        # if no selector at all, refuse (avoid patching the whole network by accident)
        if not (ids or args.match_name or args.match_tag or args.status):
            continue
        out.append(c)
    return out


def new_tags(existing, args):
    if args.set_tags is not None:
        return list(dict.fromkeys(args.set_tags))  # de-dupe, keep order
    tags = list(existing or [])
    for t in (args.add_tag or []):
        if t not in tags:
            tags.append(t)
    for t in (args.remove_tag or []):
        if t in tags:
            tags.remove(t)
    return tags


def patched_body(check, args):
    """Build the replacement POST body from the old check + requested patches."""
    body = {"name": args.set_name or check["name"], "definition": check["definition"]}
    note = args.set_note if args.set_note is not None else check.get("note")
    if note:
        body["note"] = note
    tags = new_tags(check.get("tags"), args)
    if tags:
        body["tags"] = tags
    prio = args.priority or check.get("priority")
    if prio and prio != "NOT_SET":
        body["priority"] = prio
    return body


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--network-id", required=True)
    ap.add_argument("--snapshot-id", help="default: latest PROCESSED")
    ap.add_argument("--check-id", action="append", help="explicit id (repeatable)")
    ap.add_argument("--match-name", help="name contains (case-insensitive)")
    ap.add_argument("--match-tag", help="currently carries this tag")
    ap.add_argument("--status", choices=["PASS", "FAIL", "ERROR", "TIMEOUT"])
    ap.add_argument("--set-note")
    ap.add_argument("--add-tag", action="append")
    ap.add_argument("--remove-tag", action="append")
    ap.add_argument("--set-tags", nargs="+")
    ap.add_argument("--priority", choices=["LOW", "MEDIUM", "HIGH", "NOT_SET"])
    ap.add_argument("--set-name")
    ap.add_argument("--persistent", default="true")
    ap.add_argument("--execute", action="store_true", help="apply (default: dry-run)")
    ap.add_argument("--json", action="store_true", help="emit machine-readable result")
    args = ap.parse_args()

    if not any([args.set_note is not None, args.add_tag, args.remove_tag,
                args.set_tags is not None, args.priority, args.set_name]):
        die("nothing to patch — supply at least one of --set-note/--add-tag/"
            "--remove-tag/--set-tags/--priority/--set-name")

    client = ForwardClient.from_env()
    snap = resolve_snapshot(client, args.network_id, args.snapshot_id)
    targets = select(list_checks(client, snap), args)

    if not targets:
        die("no checks matched the selectors (need at least one selector; "
            "--check-id / --match-name / --match-tag / --status)")

    print(f"snapshot {snap}: {len(targets)} check(s) matched", file=sys.stderr)
    persistent = args.persistent.lower() in ("true", "1", "yes")

    if not args.execute:
        for c in targets:
            b = patched_body(c, args)
            print(f"  • {c['id']} {c['name']}", file=sys.stderr)
            print(f"      note: {b.get('note', '')[:100]}", file=sys.stderr)
            print(f"      tags: {b.get('tags', [])}  priority: {b.get('priority', 'NOT_SET')}",
                  file=sys.stderr)
        print("\n(dry run — re-run with --execute)", file=sys.stderr)
        return

    results = []
    ok = skipped = 0
    for c in targets:
        old_id = c["id"]
        body = patched_body(c, args)
        try:
            created = client.post(f"/api/snapshots/{snap}/checks", body=body,
                                  query={"persistent": persistent})
        except ForwardError as e:
            skipped += 1
            print(f"  ✗ {old_id} {c['name']}: recreate failed: {str(e)[:140]}",
                  file=sys.stderr)
            results.append({"oldId": old_id, "ok": False, "error": str(e)})
            continue
        new_id = created.get("id")
        try:
            client.delete(f"/api/snapshots/{snap}/checks/{old_id}")
        except ForwardError as e:
            # roll back the replacement so we don't leave a duplicate behind
            try:
                client.delete(f"/api/snapshots/{snap}/checks/{new_id}")
            except ForwardError:
                pass
            skipped += 1
            print(f"  ⚠ {old_id} {c['name']}: old delete blocked ({str(e)[:80]}); "
                  f"rolled back new {new_id} — left unchanged", file=sys.stderr)
            results.append({"oldId": old_id, "ok": False, "error": str(e),
                            "rolledBack": True})
            continue
        ok += 1
        print(f"  ✓ {old_id} → {new_id}  {body['name']}", file=sys.stderr)
        results.append({"oldId": old_id, "newId": new_id, "ok": True,
                        "status": created.get("status")})

    print(f"\npatched={ok} skipped={skipped}", file=sys.stderr)
    if args.json:
        emit_json({"snapshotId": snap, "patched": ok, "skipped": skipped,
                   "results": results})


if __name__ == "__main__":
    main()
