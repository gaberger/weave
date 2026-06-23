# Network SSH Provision - Quick Start

## 🚀 5-Minute Setup

### Prerequisites
```bash
# Test SSH access
ssh admin@your-device "show version"

# Optional: Install for parallel execution
brew install parallel  # macOS
```

### Basic Usage

#### 1️⃣ Single Device Command
```bash
cd skills/network-ssh-provision
./scripts/ssh-device.sh router1.example.com "show ip interface brief"
```

#### 2️⃣ Batch Commands
```bash
# Create device list
cat > devices.txt <<EOF
router1.example.com
switch1.example.com
192.168.1.10
EOF

# Run command on all devices
./scripts/ssh-batch.sh devices.txt "show version"
```

#### 3️⃣ Backup Configurations
```bash
./scripts/backup-configs.sh devices.txt admin ./backups
```

#### 4️⃣ Push Configuration
```bash
# Create config
cat > my-config.txt <<EOF
configure terminal
interface GigabitEthernet0/0/0
description UPLINK
no shutdown
end
write memory
EOF

# Push to single device
./scripts/push-config.sh router1.example.com my-config.txt

# Push to multiple devices
./scripts/push-config.sh devices.txt my-config.txt admin --batch
```

#### 5️⃣ Device Audit
```bash
./scripts/device-audit.sh devices.txt admin
# Creates audit-<timestamp>/ directory with full device data
```

## 📋 Script Reference

| Script | Purpose | Usage |
|--------|---------|-------|
| `ssh-device.sh` | Single device command | `./ssh-device.sh <host> <command> [user] [timeout]` |
| `ssh-batch.sh` | Batch commands | `./ssh-batch.sh <device-list> <command> [user] [parallel-jobs]` |
| `backup-configs.sh` | Backup configs | `./backup-configs.sh <device-list> [user] [backup-dir]` |
| `push-config.sh` | Push config | `./push-config.sh <device> <config-file> [user] [--batch]` |
| `device-audit.sh` | Full audit | `./device-audit.sh <device-list> [user] [output-dir]` |

## 🔐 Security Setup (Recommended)

### Use SSH Keys Instead of Passwords
```bash
# Generate key
ssh-keygen -t ed25519 -f ~/.ssh/network-devices

# Copy to devices (if supported)
ssh-copy-id -i ~/.ssh/network-devices.pub admin@router1

# Add to SSH config
cat >> ~/.ssh/config <<EOF
Host router* switch* fw*
    User admin
    IdentityFile ~/.ssh/network-devices
    StrictHostKeyChecking no
EOF
```

## 🎯 Common Use Cases

### Use Case 1: Check All Devices Status
```bash
./scripts/ssh-batch.sh devices.txt "show version | include uptime"
```

### Use Case 2: Emergency Security Block
```bash
cat > block-ip.txt <<EOF
configure terminal
access-list 100 deny ip host 203.0.113.100 any
end
write memory
EOF

./scripts/push-config.sh devices.txt block-ip.txt admin --batch
```

### Use Case 3: Bulk Interface Updates
```bash
# Create CSV
cat > updates.csv <<EOF
router1,GigabitEthernet0/0,WAN_LINK
router2,GigabitEthernet0/1,ISP_BACKUP
EOF

# Script to process
while IFS=, read -r device interface desc; do
  ssh admin@$device "configure terminal
interface $interface
description $desc
end
write memory"
done < updates.csv
```

### Use Case 4: Pre-Change Audit
```bash
# Before maintenance
./scripts/backup-configs.sh devices.txt
./scripts/device-audit.sh devices.txt

# Make changes...

# After maintenance - verify
./scripts/ssh-batch.sh devices.txt "show version"
```

## 🔄 Integration with Forward Networks

Combine SSH provisioning with Forward observability:

```bash
# 1. Identify issues in Forward
/forward-nqe-query --query "BGP down"

# 2. SSH to fix
./scripts/ssh-device.sh router1 "clear ip bgp *"

# 3. Trigger Forward snapshot
/forward-snapshot-collection --device router1

# 4. Verify in Forward
/forward-path-analysis --src router1 --dst external
```

## ⚠️ Best Practices

✅ **DO**:
- Test on single device first
- Always backup before changes
- Use SSH keys for authentication
- Set reasonable timeouts
- Review commands before batch execution
- Keep audit logs

❌ **DON'T**:
- Hardcode passwords in scripts
- Run untested commands in batch
- Skip backups for critical changes
- Use `--force` flags without understanding
- Ignore error messages

## 🐛 Troubleshooting

**Cannot connect**:
```bash
# Check connectivity
ping -c 3 device

# Check SSH port
nc -zv device 22

# Try manual SSH
ssh -v admin@device
```

**Permission denied**:
```bash
# Check SSH key permissions
chmod 600 ~/.ssh/network-devices
chmod 644 ~/.ssh/network-devices.pub
```

**Command timeout**:
```bash
# Increase timeout
./scripts/ssh-device.sh router1 "show tech-support" admin 300
```

## 📚 More Information

- Full documentation: `SKILL.md`
- Examples: `examples/README.md`
- Scripts: `scripts/`

## 🆘 Getting Help

Invoke the skill in Claude Code:
```
/network-ssh-provision
```

Or ask Claude:
```
How do I backup configs from 50 devices?
How do I push an ACL to all routers?
Show me how to audit device versions
```
