---
name: network-ssh-provision
description: Provision network devices via direct SSH — run show commands, push configs, and do batch operations. Use when the user asks "SSH to router1 and show version", "push this config to all switches", "back up device configs over SSH", "run a show command across a device list". Not for querying Forward model data (use forward-nqe-query) or tracing paths (use forward-path-analysis).
allowed-tools: Bash, Read, Write
---

# Network SSH Provision

Direct SSH provisioning and management for network devices using native SSH tooling.

## Invocation

Run from the user's cwd. Do not narrate which script you're about to run.

**Single device command:**
```bash
bash "${CLAUDE_PLUGIN_ROOT}/skills/network-ssh-provision/scripts/ssh-device.sh" --host <router1.example.com> --command "show version"
```

**Batch command across a device list:**
```bash
bash "${CLAUDE_PLUGIN_ROOT}/skills/network-ssh-provision/scripts/ssh-batch.sh" --device-list <devices.txt> --command "show ip interface brief"
```

**Push config file to one device or a list:**
```bash
bash "${CLAUDE_PLUGIN_ROOT}/skills/network-ssh-provision/scripts/push-config.sh" --target <router1.example.com> --config-file <config.txt>
bash "${CLAUDE_PLUGIN_ROOT}/skills/network-ssh-provision/scripts/push-config.sh" --target <routers.txt> --config-file <acl.txt> --batch
```

**Config backup:**
```bash
bash "${CLAUDE_PLUGIN_ROOT}/skills/network-ssh-provision/scripts/backup-configs.sh" --device-list <devices.txt> --output-dir <./backups>
```

**Connectivity test:**
```bash
bash "${CLAUDE_PLUGIN_ROOT}/skills/network-ssh-provision/scripts/test-connectivity.sh" --device-list <devices.txt>
```

**Device audit (version, uptime, platform):**
```bash
bash "${CLAUDE_PLUGIN_ROOT}/skills/network-ssh-provision/scripts/device-audit.sh" --device-list <devices.txt>
```

## Output format

Never paste raw JSON. Lead with a verdict, not a dump.

### ssh-device.sh

```
**Device**: router1.example.com
**Command**: show version
**Status**: SUCCESS

Cisco IOS XE Software, Version 17.6.3
...
```

Zero result / no output: "Command ran but returned no output — the device may be at a prompt or the command produced no match."

To inspect interface state, ask: "Run `show ip interface brief` on router1."

### ssh-batch.sh

```
**Batch Command**: show ip interface brief
**Devices**: 5 total — 4 succeeded, 1 failed

=== router-core-01.example.com ===
Interface              IP-Address      OK? Method Status                Protocol
GigabitEthernet0/0/0  203.0.113.1     YES NVRAM  up                    up

=== 192.168.1.10 ===
...

**Failed (1)**:
- switch-floor2: Connection timed out
```

Cap output at ~20 devices; note "(N of M shown — narrow with --device-list <subset>)" if larger. Zero result: "No devices responded." Next step: "To see the full running config on a device, ask: 'Show running-config on router-core-01.'"

### push-config.sh

```
**Config push**: config.txt
**Target**: router1.example.com (single device)
**Status**: SUCCESS — config applied

Output:
Enter configuration commands, one per line.  End with CNTL/Z.
...
```

Failures show the error and which device failed. Zero result: "Push completed but device returned no output — verify with a show command." Next step: "To verify the change, ask: 'Show the running config on router1.'"

### backup-configs.sh

```
**Config backup**
**Device list**: devices.txt (6 devices)
**Output directory**: ./backups/20260618

Backed up (5):
- router-core-01.example.com -> backups/20260618/router-core-01.example.com.cfg
- router-core-02.example.com -> backups/20260618/router-core-02.example.com.cfg
...

Failed (1):
- switch-floor2: Connection refused
```

### test-connectivity.sh / device-audit.sh

Present as a table, one row per device. Cap at 20 rows; add "(N of M; filter device list to see more)".

```
| Device                    | Status  | Latency |
|---------------------------|---------|---------|
| router-core-01.example.com | REACHABLE | 12 ms |
| 192.168.1.10               | REACHABLE | 4 ms  |
| switch-floor2              | FAILED    | —     |
```

Zero result: "No devices in list." Next step: "To run show commands on reachable devices, ask: 'Run show version on all reachable devices.'"

## When to use

- "SSH to router1 and show me the interface status"
- "Push this config snippet to all core routers"
- "Back up running configs for all devices in my list"
- "Run show ip bgp summary across these 10 switches"
- "Test SSH connectivity to my device list before a change window"
- "Audit software versions across all devices"

## When NOT to use

- When Forward Networks model data already answers the question — use `forward-nqe-query` or `forward-path-analysis` instead; SSH is not needed for read-only queries against the Forward model.
- Tracing reachability or paths — use `forward-path-analysis`.
- Querying device state, routing tables, or interface counters from the Forward model — use `forward-nqe-query`.
- Complex orchestration requiring transactional rollback (use Ansible/NAPALM/NETCONF-based tools outside this skill).
- Devices requiring REST APIs (RESTCONF, YANG-based APIs) — SSH is not the right transport.

## Scripts

| Script | Purpose |
|---|---|
| `ssh-device.sh` | Run a single command on one device via SSH |
| `ssh-batch.sh` | Run a command across a list of devices |
| `push-config.sh` | Push a config file to one device or a batch of devices |
| `backup-configs.sh` | Back up running configs from a device list to a local directory |
| `test-connectivity.sh` | Test SSH reachability for a device list |
| `device-audit.sh` | Collect version/platform/uptime from a device list |

### ssh-device.sh

```bash
bash "${CLAUDE_PLUGIN_ROOT}/skills/network-ssh-provision/scripts/ssh-device.sh" \
  --host router1.example.com \
  --command "show version" \
  --username admin \
  --timeout 30
```

| Flag | Required | Notes |
|---|---|---|
| `--host` | yes | Hostname or IP of target device |
| `--command` | yes | Command string to execute on the device |
| `--username` | no | SSH username; defaults to `admin` |
| `--timeout` | no | Connection timeout in seconds; defaults to `30` |

### ssh-batch.sh

```bash
bash "${CLAUDE_PLUGIN_ROOT}/skills/network-ssh-provision/scripts/ssh-batch.sh" \
  --device-list devices.txt \
  --command "show ip interface brief" \
  --username admin \
  --jobs 5
```

| Flag | Required | Notes |
|---|---|---|
| `--device-list` | yes | Path to newline-delimited file of hostnames/IPs |
| `--command` | yes | Command to run on every device |
| `--username` | no | SSH username; defaults to `admin` |
| `--jobs` | no | Max parallel SSH sessions; defaults to `5` |

### push-config.sh

```bash
bash "${CLAUDE_PLUGIN_ROOT}/skills/network-ssh-provision/scripts/push-config.sh" \
  --target router1.example.com \
  --config-file config.txt \
  --username admin

# Batch mode: --target is a device-list file
bash "${CLAUDE_PLUGIN_ROOT}/skills/network-ssh-provision/scripts/push-config.sh" \
  --target routers.txt \
  --config-file acl.txt \
  --username admin \
  --batch
```

| Flag | Required | Notes |
|---|---|---|
| `--target` | yes | Single hostname/IP or (with `--batch`) a device-list file |
| `--config-file` | yes | Path to config snippet file to push |
| `--username` | no | SSH username; defaults to `admin` |
| `--batch` | no | Treat `--target` as a device-list file |

### backup-configs.sh

```bash
bash "${CLAUDE_PLUGIN_ROOT}/skills/network-ssh-provision/scripts/backup-configs.sh" \
  --device-list devices.txt \
  --username admin \
  --output-dir ./backups
```

| Flag | Required | Notes |
|---|---|---|
| `--device-list` | yes | Path to newline-delimited file of hostnames/IPs |
| `--username` | no | SSH username; defaults to `admin` |
| `--output-dir` | no | Directory for backup files; defaults to `./backups` |

### test-connectivity.sh

```bash
bash "${CLAUDE_PLUGIN_ROOT}/skills/network-ssh-provision/scripts/test-connectivity.sh" \
  --device-list devices.txt \
  --username admin \
  --timeout 10
```

| Flag | Required | Notes |
|---|---|---|
| `--device-list` | yes | Path to newline-delimited file of hostnames/IPs |
| `--username` | no | SSH username; defaults to `admin` |
| `--timeout` | no | Per-device timeout in seconds; defaults to `10` |

### device-audit.sh

```bash
bash "${CLAUDE_PLUGIN_ROOT}/skills/network-ssh-provision/scripts/device-audit.sh" \
  --device-list devices.txt \
  --username admin
```

| Flag | Required | Notes |
|---|---|---|
| `--device-list` | yes | Path to newline-delimited file of hostnames/IPs |
| `--username` | no | SSH username; defaults to `admin` |

## Gotchas

- **Password-based auth requires `sshpass`** — install with `brew install sshpass` (macOS) or `apt-get install sshpass`. Without it, only key-based auth works.
- **StrictHostKeyChecking** — scripts use `-o StrictHostKeyChecking=no` for automation; known-hosts mismatches will silently succeed. Review this for security-sensitive environments.
- **Interactive prompts break batch mode** — use `-o BatchMode=yes` to abort instead of hanging on a password prompt or pager. Scripts add this by default.
- **Device pagers** — Cisco IOS may truncate output if `terminal length 0` is not prepended. Scripts attempt this automatically; check device-specific behavior.
- **Timeout tuning** — WAN-latency devices need higher `--timeout` values. Start with `--timeout 60` for slow links.
- **Large device lists** — running ssh-batch.sh on 200+ devices with `--jobs 1` (serial) is slow. Use `--jobs 10` cautiously and watch for rate-limiting.
- **Push-config atomicity** — there is no transactional rollback. A failure mid-push leaves partial config applied. Always back up first with backup-configs.sh.
- **Worked examples** — see `references/examples/` for sample device lists and Cisco IOS config snippets.
