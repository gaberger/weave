---
name: forward-changeset
description: Create, manage, and version Forward Networks change-sets — the sandbox objects that hold Predict overrides. Use when the user asks "create a change-set", "list my change-sets", "rename change-set CHG-7", "commit the draft", "show version history", "restore to an earlier version", "edit CLI commands on a device", "run predictive analysis", or "show the directory structure". Not for adding or removing BGP advertisement overrides inside a change-set (use forward-predict), tracing paths against a change-set (use forward-path-analysis), or reading device state (use forward-device-intel or forward-nqe-query).
allowed-tools: Bash(python3 *), Read
---

# Forward Change-Set Management

A **change-set** is a named sandbox that sits on top of a snapshot. It holds:
- BGP advertisement overrides (inject / withdraw prefixes — managed by `forward-predict`)
- Device CLI command blocks (config edits applied during Predict modelling)
- A version history of committed checkpoints
- A directory path in the UI folder tree

This skill covers the **lifecycle** of change-sets: create, rename, delete, commit, version history, restore, device command editing, triggering predictive analysis, and directory navigation.

---

## Invocation

Run from the user's cwd so `.env` auto-loads. Do NOT `source .env` or export creds manually. Do not narrate which script you're about to run.

```bash
# List all change-sets on a network
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-changeset/scripts/list_changesets.py" \
    --network-id NET_xyz

# Create a new change-set on a snapshot
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-changeset/scripts/create_changeset.py" \
    --network-id NET_xyz --name "Analysis 007" --snapshot-id 691
# Optionally place it in a directory:
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-changeset/scripts/create_changeset.py" \
    --network-id NET_xyz --name "Analysis 007" --snapshot-id 691 --dir-path /team/q3

# Rename / update a change-set
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-changeset/scripts/update_changeset.py" \
    --network-id NET_xyz --changeset-id CHG-7 --name "Analysis 007 — final"

# Delete a change-set (destructive — requires --yes)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-changeset/scripts/delete_changeset.py" \
    --network-id NET_xyz --changeset-id CHG-7 --yes

# Commit the current draft state (creates a version checkpoint)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-changeset/scripts/commit_changeset.py" \
    --network-id NET_xyz --changeset-id CHG-7 --note "baseline before route injection"

# Show the commit history
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-changeset/scripts/get_version_history.py" \
    --network-id NET_xyz --changeset-id CHG-7

# Restore to an earlier commit (destructive — requires --yes)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-changeset/scripts/restore_commit.py" \
    --network-id NET_xyz --changeset-id CHG-7 --commit-id CMT-3 --yes

# Edit CLI commands on a specific device (inline)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-changeset/scripts/edit_commands.py" \
    --network-id NET_xyz --changeset-id CHG-7 --device us-border-1 \
    --commands "router bgp 65001
 neighbor 10.0.0.34 route-map INJECT out"
# From a file:
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-changeset/scripts/edit_commands.py" \
    --network-id NET_xyz --changeset-id CHG-7 --device us-border-1 \
    --commands-file ./border1_commands.txt

# Trigger a Predict run (models the change-set against a snapshot)
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-changeset/scripts/run_predict.py" \
    --network-id NET_xyz --changeset-id CHG-7 \
    --base-snapshot-id 691 --note "test route injection 2026-06-19"

# List the change-set directory tree
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-changeset/scripts/list_directories.py" \
    --network-id NET_xyz
```

All write/destructive scripts support `--dry-run` to preview the request body without calling the API.

---

## Output format

Never paste raw JSON. Lead with a verdict, not a dump.

### Machine contract (JSON)

Every script emits one JSON envelope. The list scripts (`list_changesets.py`,
`get_version_history.py`, `list_directories.py`) produce JSON only with `--json`;
all other scripts always emit JSON. Write paths echo the request under `data` with
`meta.dry_run=true` when `--dry-run` is passed.

Success:

```json
{ "ok": true, "schema": 1, "data": <result>, "meta": { "...": "counts / network_id / changeset_id / echoed params" } }
```

Failure (exit non-zero):

```json
{ "ok": false, "schema": 1, "error": { "code": "API|NOT_FOUND|INPUT|AUTH|EMPTY", "message": "...", "hint": "..." } }
```

`ok` is the only field to branch on. The human renderings below are the
default (`--json` off) presentation, not the contract.

### `list_changesets.py`

```
<N> change-set(s) on network <networkId>:
  <id>  "<name>"  snapshot=<snapshotId>  modified_devices=<N>  predicted_snapshots=<N>
  ...
```

Zero result: "No change-sets found on network <networkId>."

### `create_changeset.py`

```
Created change-set <id> "<name>" on snapshot <snapshotId>.
```

Surface the returned `id` prominently — the user needs it for downstream commands.

### `delete_changeset.py`

```
Deleted change-set <id>.
```

If the user didn't pass `--yes`, remind them the deletion requires `--yes`.

### `update_changeset.py`

```
Updated change-set <id>: <field>=<value>[, <field>=<value>].
```

Surface the full returned record's `id` and `name` so the user can confirm the rename.

### `commit_changeset.py`

```
Committed change-set <changesetId> — commit <commitId> "<note>" at <performedAt>.
```

Surface the commit ID; the user will need it to restore later.

### `get_version_history.py`

```
<N> commit(s) in change-set <id> (most recent first):
  <commitId>  "<note>"  by=<username>  at=<timestamp>
  ...
```

Zero result: "No commits found for change-set <id>. Use commit_changeset.py to create a checkpoint."

### `restore_commit.py`

```
Restored change-set <changesetId> to commit <commitId> "<note>". Current draft overwritten.
```

If `--yes` was not passed, surface the warning message. After restoring, suggest running `forward-predict` to re-evaluate the restored state.

### `edit_commands.py`

```
Updated CLI commands on <device> in change-set <changesetId>.
Draft now has <N> device(s) with changes.
```

Surface any validation errors verbatim from the server. Remind the user to run `commit_changeset.py` if they want to checkpoint this edit, then `run_predict.py` to model it.

### `run_predict.py`

```
Predict run triggered for change-set <changesetId> against snapshot <snapshotId>.
Predicted snapshot: <id>  status=<processingStage>
```

The predicted snapshot starts in a processing state. Tell the user to wait for it to complete before running path analysis against it — they can check status with `forward-inventory list_snapshots.py`.

### `list_directories.py`

```
Change-set directory tree for network <networkId>:
  /
    team/  (2 change-set(s): CHG-1, CHG-3)
      q3/  (1 change-set(s): CHG-7)
```

---

## When to use

- "Create a change-set called 'Test fix 001' on snapshot 691."
- "List all my change-sets on network NET_abc."
- "Rename change-set CHG-7 to 'Analysis — BGP leak test'."
- "Commit the current draft of CHG-7 with note 'before adding advertisements'."
- "Show me the version history of CHG-7."
- "Restore CHG-7 to commit CMT-2."
- "Add these IOS commands to us-border-1 in change-set CHG-7."
- "Run a Predict on CHG-7 against snapshot 691."
- "Show me the folder structure for my change-sets."

## When NOT to use

- **Adding / removing BGP advertisement overrides** → `forward-predict`
- **Running a path search against a change-set** → `forward-path-analysis` (pass `--changeset-id`)
- **Reading device BGP state or ARP tables** → `forward-device-intel`
- **Listing snapshots or networks** → `forward-inventory`
- **STIG or compliance checks** → `forward-compliance-check`

---

## Scripts

| Script | Purpose |
|---|---|
| `list_changesets.py` | List all change-sets on a network with summary info |
| `create_changeset.py` | Create a new change-set on a snapshot |
| `delete_changeset.py` | Delete a change-set (destructive, requires `--yes`) |
| `update_changeset.py` | Rename or update a change-set (PATCH) |
| `commit_changeset.py` | Commit draft changes — creates a version checkpoint |
| `get_version_history.py` | List all commits (version history) for a change-set |
| `restore_commit.py` | Restore change-set draft to a historical commit (destructive, requires `--yes`) |
| `edit_commands.py` | Set the CLI command block for a device in a change-set |
| `run_predict.py` | Trigger a Predict modelling run from a change-set |
| `list_directories.py` | Show the change-set folder tree |

### `list_changesets.py`

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-changeset/scripts/list_changesets.py" \
    --network-id NET_xyz [--json]
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network ID |
| `--json` | no | Emit raw JSON only |

### `create_changeset.py`

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-changeset/scripts/create_changeset.py" \
    --network-id NET_xyz --name "My Analysis" --snapshot-id 691 [--dir-path /team]
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network ID |
| `--name` | yes | Human-readable name |
| `--snapshot-id` | yes | Base snapshot ID |
| `--dir-path` | no | Directory path to place the change-set in |
| `--dry-run` | no | Preview request without calling API |

### `delete_changeset.py`

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-changeset/scripts/delete_changeset.py" \
    --network-id NET_xyz --changeset-id CHG-7 --yes
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network ID |
| `--changeset-id` | yes | Change-set ID to delete |
| `--yes` | yes* | Required to execute deletion |
| `--dry-run` | no | Show what would be deleted |

### `update_changeset.py`

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-changeset/scripts/update_changeset.py" \
    --network-id NET_xyz --changeset-id CHG-7 --name "New Name"
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network ID |
| `--changeset-id` | yes | Change-set ID to update |
| `--name` | no | New name |
| `--snapshot-id` | no | New base snapshot ID |
| `--dry-run` | no | Preview patch body |

At least one of `--name` or `--snapshot-id` must be provided.

### `commit_changeset.py`

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-changeset/scripts/commit_changeset.py" \
    --network-id NET_xyz --changeset-id CHG-7 --note "baseline state"
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network ID |
| `--changeset-id` | yes | Change-set ID |
| `--note` | yes | Commit message / version label |
| `--dry-run` | no | Preview request params |

### `get_version_history.py`

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-changeset/scripts/get_version_history.py" \
    --network-id NET_xyz --changeset-id CHG-7
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network ID |
| `--changeset-id` | yes | Change-set ID |
| `--json` | no | Emit raw JSON only |

### `restore_commit.py`

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-changeset/scripts/restore_commit.py" \
    --network-id NET_xyz --changeset-id CHG-7 --commit-id CMT-3 --yes
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network ID |
| `--changeset-id` | yes | Change-set ID |
| `--commit-id` | yes | Commit ID to restore to (from `get_version_history.py`) |
| `--yes` | yes* | Required to overwrite current draft |
| `--dry-run` | no | Show request without calling API |

### `edit_commands.py`

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-changeset/scripts/edit_commands.py" \
    --network-id NET_xyz --changeset-id CHG-7 --device us-border-1 \
    --commands "interface Gi0/1
 ip address 10.0.0.1 255.255.255.0"
# or from file:
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-changeset/scripts/edit_commands.py" \
    --network-id NET_xyz --changeset-id CHG-7 --device us-border-1 \
    --commands-file ./commands.txt
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network ID |
| `--changeset-id` | yes | Change-set ID |
| `--device` | yes | Device name |
| `--commands` | yes* | Inline CLI command string (mutually exclusive with `--commands-file`) |
| `--commands-file` | yes* | Path to text file of CLI commands |
| `--dry-run` | no | Preview request without calling API |

### `run_predict.py`

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-changeset/scripts/run_predict.py" \
    --network-id NET_xyz --changeset-id CHG-7 \
    --base-snapshot-id 691 --note "test injection 2026-06-19"
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network ID |
| `--changeset-id` | yes | Change-set ID to model |
| `--base-snapshot-id` | yes | Snapshot to model against |
| `--note` | yes | Label for this Predict run |
| `--dry-run` | no | Preview request params |

### `list_directories.py`

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-changeset/scripts/list_directories.py" \
    --network-id NET_xyz [--json]
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Forward network ID |
| `--json` | no | Emit raw JSON tree |

---

## Workflow: validate a config change end-to-end

The canonical loop — from raw idea to validated result:

```
1. forward-inventory   list_snapshots.py   → pick base snapshot ID
2. forward-changeset   create_changeset.py → CHG-N (start fresh)
3. forward-changeset   edit_commands.py    → push CLI commands to target device
4. forward-predict     add_advertisement.py (if BGP overrides also needed)
5. forward-changeset   commit_changeset.py → checkpoint "pre-run state"
6. forward-changeset   run_predict.py      → trigger Predict; get predicted snapshot ID
7. forward-inventory   list_snapshots.py   → poll until predicted snapshot is READY
8. forward-path-analysis search_path.py --snapshot-id <predicted> → validate reachability
9. forward-intent-check  (optional)        → confirm policy invariants still hold
```

## Gotchas

- **`--note` on `commit_changeset.py` is required** — the server rejects an empty note string. A meaningful label like `"baseline before BGP injection"` makes `get_version_history.py` output readable.
- **`run_predict.py` is async** — the returned `SnapshotMeta` has a `processingStage` that starts at `CREATION`. The predicted snapshot is not usable for path searches until that stage reaches `READY`. Poll with `forward-inventory list_snapshots.py`.
- **`edit_commands.py` replaces, not appends** — calling it twice overwrites the first command block. To add commands incrementally, read the current state first (use `forward-predict get_changeset.py` to inspect `deviceToChanges`) and include the full desired command set in `--commands`.
- **`restore_commit.py` overwrites the draft** — there is no undo after `--yes`. Commit first if the current draft has any unsaved work worth keeping.
- **Change-sets are per-user in the Forward UI** — the `getChangeSets` endpoint returns only change-sets belonging to the authenticated user. You won't see other users' change-sets via these scripts.
- **BGP advertisement overrides live in `deviceToChanges[*].addedAdvertisements`** — `edit_commands.py` (CLI commands, `deviceToChanges[*].hasConfig`) and `forward-predict` (BGP overrides) write to different fields on the same change-set. Both can coexist; they model different override channels.
