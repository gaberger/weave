# Network SSH Provision - Examples

## Quick Start

### 1. Create Device List
```bash
cat > my-devices.txt <<EOF
router1.example.com
192.168.1.10
switch-core
EOF
```

### 2. Test Connectivity
```bash
./scripts/ssh-device.sh router1.example.com "show version"
```

### 3. Run Batch Command
```bash
./scripts/ssh-batch.sh my-devices.txt "show ip interface brief"
```

### 4. Backup Configs
```bash
./scripts/backup-configs.sh my-devices.txt admin ./backups
```

### 5. Audit Devices
```bash
./scripts/device-audit.sh my-devices.txt admin
```

## Common Workflows

### Change Interface Description
```bash
# Create config snippet
cat > update-interface.txt <<EOF
configure terminal
interface GigabitEthernet0/0/0
description NEW_DESCRIPTION
end
write memory
EOF

# Push to device
./scripts/push-config.sh router1.example.com update-interface.txt
```

### Emergency ACL Block
```bash
# Block malicious IP across all routers
BLOCK_IP="203.0.113.100"

cat > block-ip.txt <<EOF
configure terminal
access-list 100 deny ip host $BLOCK_IP any
end
write memory
EOF

./scripts/push-config.sh routers.txt block-ip.txt admin --batch
```

### Collect Show Commands
```bash
# Gather BGP status from all routers
./scripts/ssh-batch.sh routers.txt "show ip bgp summary" > bgp-status.txt
```

## Advanced Usage

### Parallel Execution (requires GNU parallel)
```bash
# Install parallel
brew install parallel  # macOS
# or
apt-get install parallel  # Linux

# Run on 10 devices simultaneously
./scripts/ssh-batch.sh devices.txt "show version" admin 10
```

### Using SSH Config
```bash
# Add to ~/.ssh/config
cat >> ~/.ssh/config <<EOF
Host network-*
    User admin
    IdentityFile ~/.ssh/network-key
    StrictHostKeyChecking no
    UserKnownHostsFile /dev/null
    LogLevel ERROR
EOF

# Now use aliases
ssh network-router1 "show version"
```

### Integration with Forward Networks
```bash
# 1. Query Forward for devices with BGP issues
# (using forward-nqe-query skill)
forward-nqe-query --query "BGP neighbors down"

# 2. SSH to fix
./scripts/ssh-device.sh router1 "clear ip bgp *"

# 3. Trigger snapshot to verify
# (using forward-snapshot-collection skill)
forward-snapshot-collection --device router1
```

## Troubleshooting

### Permission Denied
```bash
# Generate SSH key
ssh-keygen -t ed25519 -f ~/.ssh/network-devices

# Copy to device (if supported)
ssh-copy-id -i ~/.ssh/network-devices.pub admin@device
```

### Connection Timeout
```bash
# Test network connectivity
ping -c 3 device

# Test SSH port
nc -zv device 22

# Try with explicit timeout
timeout 10 ssh admin@device "show version"
```

### Command Hangs
```bash
# Use BatchMode to avoid prompts
ssh -o BatchMode=yes admin@device "show version"

# Force terminal type
ssh -t admin@device "show version"
```
