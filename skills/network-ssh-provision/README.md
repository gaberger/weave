# Network SSH Provision

**Lightweight SSH provisioning and management for network devices with minimal dependencies.**

## Overview

This skill provides direct SSH access to network devices for configuration management, command execution, and auditing. Built on native SSH tooling with zero Python/framework dependencies.

### Key Features

- ✅ **Minimal Dependencies** - Uses native `ssh`, works everywhere
- ✅ **Vendor Agnostic** - Cisco IOS, Arista EOS, Junos, Palo Alto
- ✅ **Battle-tested Scripts** - Error handling, timeouts, backups
- ✅ **Batch Operations** - Serial or parallel execution
- ✅ **Safety First** - Auto-backup before changes, rollback support
- ✅ **Integration Ready** - Works with Forward Networks skills

## Quick Start

### 1. Test Single Device
```bash
cd /Volumes/External/working/forward-skills/skills/network-ssh-provision
./scripts/ssh-device.sh router1.example.com "show version"
```

### 2. Batch Commands
```bash
# Create device list
cat > my-devices.txt <<EOF
router1.example.com
switch1.example.com
EOF

# Run command on all
./scripts/ssh-batch.sh my-devices.txt "show ip interface brief"
```

### 3. Backup All Configs
```bash
./scripts/backup-configs.sh my-devices.txt
```

See [QUICKSTART.md](QUICKSTART.md) for more examples.

## What's Included

### Scripts
- **ssh-device.sh** - Execute command on single device
- **ssh-batch.sh** - Execute command on multiple devices
- **backup-configs.sh** - Backup device configurations
- **push-config.sh** - Push configuration to device(s)
- **device-audit.sh** - Full device audit with status collection
- **test-connectivity.sh** - Test SSH connectivity to devices

### Documentation
- **SKILL.md** - Complete skill documentation
- **QUICKSTART.md** - 5-minute getting started guide
- **examples/** - Example configs and device lists

## Use Cases

### 1. Configuration Backup
```bash
# Daily backup of all network devices
./scripts/backup-configs.sh production-devices.txt admin ./backups
```

### 2. Emergency Security Response
```bash
# Block malicious IP across all routers
cat > block-ip.txt <<EOF
configure terminal
access-list 100 deny ip host 203.0.113.100 any
end
write memory
EOF

./scripts/push-config.sh routers.txt block-ip.txt admin --batch
```

### 3. Device Audit
```bash
# Collect full device status
./scripts/device-audit.sh all-devices.txt admin
# Creates audit-<timestamp>/ with device data + summary CSV
```

### 4. Bulk Interface Updates
```bash
# Update descriptions across devices
./scripts/ssh-batch.sh switches.txt "configure terminal
interface range GigabitEthernet1/0/1-24
description ACCESS_PORTS
end
write memory"
```

### 5. Integration with Forward Networks
```bash
# Identify issues in Forward
/forward-nqe-query --query "BGP neighbors down"

# Fix via SSH
./scripts/ssh-device.sh router1 "clear ip bgp *"

# Verify in Forward
/forward-snapshot-collection --device router1
```

## Supported Devices

Works with any device supporting standard SSH:
- **Cisco** - IOS, IOS-XE, NX-OS
- **Arista** - EOS
- **Juniper** - Junos
- **Palo Alto** - PAN-OS
- **Fortinet** - FortiOS
- **Any** - Linux, BSD, network appliances

## Dependencies

**Required** (standard on Linux/macOS):
- `ssh` - OpenSSH client
- `bash` - Shell scripting

**Optional**:
- `sshpass` - For password authentication (not recommended)
- `parallel` - For faster batch operations
- `expect` - For interactive sessions

## Security

### Recommended: SSH Key Authentication
```bash
# Generate key
ssh-keygen -t ed25519 -f ~/.ssh/network-devices

# Copy to devices
ssh-copy-id -i ~/.ssh/network-devices.pub admin@router1

# Configure SSH
cat >> ~/.ssh/config <<EOF
Host router* switch*
    User admin
    IdentityFile ~/.ssh/network-devices
    StrictHostKeyChecking no
EOF
```

### Features
- ✅ Auto-backup before config changes
- ✅ Timeout protection on all operations
- ✅ No credential storage in scripts
- ✅ SSH key support (recommended)
- ✅ Jump host support for bastion access

## Performance

### Serial Execution
```bash
# One device at a time (default)
./scripts/ssh-batch.sh devices.txt "show version"
```

### Parallel Execution
```bash
# 10 devices simultaneously (requires GNU parallel)
./scripts/ssh-batch.sh devices.txt "show version" admin 10
```

**Benchmarks** (100 devices):
- Serial: ~5 minutes
- Parallel (10 jobs): ~30 seconds

## Integration

### With Forward Networks Skills
```bash
# Device discovery
/forward-inventory > devices.txt

# Configuration backup
./scripts/backup-configs.sh devices.txt

# Query issues
/forward-nqe-query --query "BGP down"

# SSH to remediate
./scripts/ssh-device.sh affected-router "clear ip bgp *"

# Verify fix
/forward-snapshot-collection --device affected-router
```

### With Ansible
```bash
# Use SSH scripts as Ansible local actions
# or shell module tasks for ad-hoc operations
```

### With CI/CD
```bash
# GitHub Actions, GitLab CI, Jenkins
# Run audits, backups, deployments in pipelines
```

## Best Practices

✅ **DO**:
- Test commands on single device first
- Always backup before making changes
- Use SSH keys for authentication
- Set appropriate timeouts
- Log all operations
- Review diffs before batch deployment

❌ **DON'T**:
- Hardcode passwords in scripts
- Skip backups for critical changes
- Run untested commands in batch
- Use --force flags without understanding
- Ignore connection errors

## Troubleshooting

### Cannot Connect
```bash
# Test connectivity
./scripts/test-connectivity.sh devices.txt

# Manual test
ping device
nc -zv device 22
ssh -v admin@device
```

### Permission Denied
```bash
# Check SSH key permissions
chmod 600 ~/.ssh/network-devices
ls -la ~/.ssh/
```

### Command Hangs
```bash
# Increase timeout
./scripts/ssh-device.sh router1 "show tech" admin 300

# Use BatchMode
ssh -o BatchMode=yes admin@device "show version"
```

### Vendor-Specific Issues
See [SKILL.md](SKILL.md) for vendor-specific command syntax.

## Examples

See [examples/README.md](examples/README.md) for:
- Device list formats
- Configuration templates
- Common workflows
- Integration examples

## Files

```
network-ssh-provision/
├── SKILL.md              # Complete documentation
├── QUICKSTART.md         # 5-minute guide
├── README.md            # This file
├── .gitignore           # Ignore backups/credentials
├── scripts/
│   ├── ssh-device.sh          # Single device command
│   ├── ssh-batch.sh           # Batch execution
│   ├── backup-configs.sh      # Config backup
│   ├── push-config.sh         # Config deployment
│   ├── device-audit.sh        # Full audit
│   └── test-connectivity.sh   # Connectivity test
└── examples/
    ├── README.md              # Example workflows
    ├── devices.txt            # Device list template
    └── cisco-ios-config.txt   # Config template
```

## Getting Help

### In Claude Code
```
/network-ssh-provision
```

### Ask Claude
```
How do I backup configs from 50 routers?
Show me how to push an ACL to all switches
How do I audit device versions across the network?
```

### Read Documentation
- [SKILL.md](SKILL.md) - Complete reference
- [QUICKSTART.md](QUICKSTART.md) - Quick start
- [examples/README.md](examples/README.md) - Examples

## License

Part of the Forward Skills marketplace for Claude Code.

## Contributing

To enhance this skill:
1. Test changes on lab devices first
2. Update documentation
3. Add examples for new workflows
4. Submit PR to forward-skills repository
