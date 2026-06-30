---
name: forward-snapshot-collection
description: Trigger, monitor, and manage Forward Networks snapshot collections. Use when the user asks "collect a snapshot", "trigger collection", "start a new snapshot", "check collection status", "cancel collection", or "manage collection schedules". Not for listing existing snapshots (use forward-inventory) or querying snapshot data (use forward-nqe-query, forward-path-analysis).
allowed-tools: Bash(python3 *), Read
---

# Forward Snapshot Collection

> **Read first:** `${CLAUDE_PLUGIN_ROOT}/shared/expertise/forward-as-backend.md` — the foundational framing. This skill manages the *collection lifecycle* — triggering new snapshots, monitoring progress, and managing schedules.

## Operate as a network engineer

Snapshot collection is often step 0.5 of an investigation — when the user needs fresh data, trigger a collection before querying. For multi-step workflows that need current state, read `${CLAUDE_PLUGIN_ROOT}/shared/expertise/investigation-workflows.md` after triggering collection.

## Invocation

Run from the user's cwd so the scripts auto-load `.env`. Do NOT `source .env` or export creds manually. Do not narrate which script you're about to run.

```bash
# Trigger collection
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-snapshot-collection/scripts/start_collection.py" \
  --network-id <id>

# Check status
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-snapshot-collection/scripts/get_collection_status.py" \
  --task-id <task-id>

# Cancel
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-snapshot-collection/scripts/cancel_collection.py" \
  --network-id <id>

# Manage schedules
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-snapshot-collection/scripts/list_schedules.py" \
  --network-id <id>

python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-snapshot-collection/scripts/add_schedule.py" \
  --network-id <id> --cron "0 2 * * *" --label "Daily 2am collection"

python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-snapshot-collection/scripts/delete_schedule.py" \
  --network-id <id> --schedule-id <schedule-id>
```

## Output format

Every script emits the standard skill envelope on stdout and exits 0 on success:

```json
{"ok": true, "schema": 1, "data": <result>, "meta": {"network_id": "...", ...}}
```

On failure it emits `{"ok": false, "schema": 1, "error": {"code", "message", "hint?"}}` and exits non-zero. Codes: `AUTH` (bad creds), `NOT_FOUND` (unknown network/task/schedule — includes 404), `API` (any other Forward API error, e.g. a 409 "collection already running"). `data` is the API result; `meta` carries facts about it (network_id, task_id, cron, count). Read `data`/`meta`, then render as below — never paste raw JSON. Lead with a verdict, not a dump.

### `start_collection.py`

```markdown
**Collection started** for network `<id>` (<name>)

Task ID: `<taskId>`
Status: `<status>` (QUEUED / IN_PROGRESS / COMPLETED / FAILED)
```

Zero result: not applicable — a 409 conflict means a collection is already running; surface that error directly.

To check progress, ask: "**Check collection status for task `<taskId>`.**"

### `get_collection_status.py`

```markdown
**Collection task** `<taskId>`

| Field | Value |
|---|---|
| Network | `<networkId>` |
| Status | `<status>` |
| Progress | `<progress>` (if available) |
| Started | `<startTime>` |
| Completed | `<endTime>` (if finished) |
| Error | `<errorMessage>` (if failed) |

If COMPLETED and snapshot was processed:
- Snapshot ID: `<snapshotId>`
- Processed at: `<processedAt>`
```

Zero result: not applicable — a missing task ID returns a 404 error; surface that directly.

Next step by status:
- If IN_PROGRESS: "Collection is still running. Check again in a few minutes."
- If COMPLETED: To see the new snapshot, ask: "**List snapshots for network `<networkId>`.**"
- If FAILED: "Collection failed: `<error>`. Check network connectivity or collection settings."

### `list_schedules.py`

```markdown
**<N> collection schedules** for network `<id>` (<name>)

| Schedule ID | Label | Cron | Next run |
|---|---|---|---|
| ... | ... | ... | ... |
```

Zero result: "No collection schedules configured."

To add a schedule, ask: "**Schedule daily collection at 2am for network `<id>`.**"

### `cancel_collection.py`

```markdown
**Collection cancelled** for network `<id>`.
```

Zero result / nothing running: surface the error response directly (the API returns an error if no collection is active).

To verify no collection is running, ask: "**Check collection status for network `<id>`.**"

### `add_schedule.py`

```markdown
**Schedule created** for network `<id>`

| Field | Value |
|---|---|
| Schedule ID | `<scheduleId>` |
| Label | `<label>` |
| Cron | `<cron>` |
| Next run | `<nextRun>` |
```

Zero result: not applicable — success always returns a schedule object.

To review all schedules, ask: "**List collection schedules for network `<id>`.**"

### `delete_schedule.py`

```markdown
**Schedule `<scheduleId>` deleted** from network `<id>`.
```

Note: deletion is permanent and cannot be undone. Confirm the schedule ID before deletion.

To verify deletion, ask: "**List collection schedules for network `<id>`.**"

## When to use

- "Trigger a new snapshot collection"
- "Start collecting network X"
- "Check if collection is done"
- "Cancel the current collection"
- "Show collection schedules"
- "Schedule daily collections at 2am"

## When NOT to use

- Listing existing snapshots → `forward-inventory`
- Querying snapshot data → `forward-nqe-query`, `forward-path-analysis`, etc.
- Analyzing device configs → `forward-device-intel`, `forward-device-config`

## Scripts

| Script | Purpose |
|---|---|
| `start_collection.py` | Trigger a new snapshot collection for a network |
| `get_collection_status.py` | Poll the status of an in-progress or completed collection task |
| `cancel_collection.py` | Cancel an in-progress network collection |
| `list_schedules.py` | List all collection schedules for a network |
| `add_schedule.py` | Add a new cron-based collection schedule |
| `delete_schedule.py` | Delete a collection schedule by ID |

### `start_collection.py`

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-snapshot-collection/scripts/start_collection.py" \
  --network-id NET_xyz
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Network ID to collect |

### `get_collection_status.py`

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-snapshot-collection/scripts/get_collection_status.py" \
  --task-id <task-id>
```

| Flag | Required | Notes |
|---|---|---|
| `--task-id` | yes | Collector task ID returned by `start_collection.py` |

### `cancel_collection.py`

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-snapshot-collection/scripts/cancel_collection.py" \
  --network-id NET_xyz
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Network ID whose in-progress collection to cancel |

### `list_schedules.py`

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-snapshot-collection/scripts/list_schedules.py" \
  --network-id NET_xyz
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Network ID to list schedules for |

### `add_schedule.py`

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-snapshot-collection/scripts/add_schedule.py" \
  --network-id NET_xyz --cron "0 2 * * *" --label "Daily 2am collection"
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Network ID to add the schedule to |
| `--cron` | yes | Cron expression (e.g., `"0 2 * * *"` = daily at 2am UTC) |
| `--label` | no | Human-readable label for the schedule |

### `delete_schedule.py`

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-snapshot-collection/scripts/delete_schedule.py" \
  --network-id NET_xyz --schedule-id <schedule-id>
```

| Flag | Required | Notes |
|---|---|---|
| `--network-id` | yes | Network ID |
| `--schedule-id` | yes | Schedule ID to delete (from `list_schedules.py` output) |

## Gotchas

- **One collection at a time**: A network can only have one collection task running. If you try to start a second, it will fail with a 409 conflict.
- **Async operation**: `start_collection.py` returns immediately with a task ID. The actual collection takes minutes to hours depending on network size. Always poll `get_collection_status.py` to check progress.
- **Task ID != Snapshot ID**: The task ID is for tracking collection progress. Once complete, the task response includes the snapshot ID.
- **Cron syntax**: Collection schedules use standard cron syntax (`minute hour day month weekday`). Example: `0 2 * * *` = daily at 2am UTC.
- **Timezone**: All cron schedules run in UTC unless the Forward instance is configured otherwise.
- **Schedule labels**: Optional but highly recommended for human readability.

## Collection workflow tips

**Before triggering:**
- Check if a collection is already running with `get_collection_status.py`
- Verify the network has collection sources configured (devices with credentials)

**During collection:**
- Poll status every 30-60 seconds for small networks, every 2-3 minutes for large ones
- Don't spam the API — collections can take 15+ minutes for large networks

**After collection:**
- Wait for snapshot processing to complete (status = COMPLETED)
- Use `forward-inventory` to get the new snapshot ID
- Proceed with analysis skills (`forward-nqe-query`, `forward-path-analysis`, etc.)

## Error handling

**Common errors:**
- `409 Conflict`: Collection already running — wait or cancel the existing one
- `404 Not Found`: Invalid network ID
- `401 Unauthorized`: Invalid API credentials
- `500 Internal Error`: Forward platform issue — check the UI or contact support

If collection fails (status = FAILED), check:
1. Device credentials are configured
2. Devices are reachable from Forward collectors
3. Collection settings (SNMP community strings, SSH keys, etc.)
