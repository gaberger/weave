#!/bin/bash
# push-config.sh - Push configuration to device(s)

set -euo pipefail

# Usage: push-config.sh <device-or-list> <config-file> [username] [--batch]
TARGET="${1:?Missing device or device list}"
CONFIG_FILE="${2:?Missing config file}"
USERNAME="${3:-admin}"
BATCH_MODE="${4:-}"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "ERROR: Config file not found: $CONFIG_FILE" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Function to push to single device
push_to_device() {
  local device="$1"
  local config="$2"
  local username="$3"

  echo "=== Pushing config to $device ==="

  # Create backup first
  local backup_file="/tmp/${device}_backup_$(date +%Y%m%d_%H%M%S).cfg"
  if "$SCRIPT_DIR/ssh-device.sh" "$device" "show running-config" "$username" > "$backup_file" 2>/dev/null; then
    echo "✓ Backup saved: $backup_file"
  else
    echo "⚠ Warning: Could not backup config"
  fi

  # Push new config
  SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"

  if ssh $SSH_OPTS "${username}@${device}" < "$config" 2>&1; then
    echo "✓ Config pushed to $device"

    # Verify (optional)
    echo "Verifying configuration..."
    if "$SCRIPT_DIR/ssh-device.sh" "$device" "show running-config | include $(head -1 $config | sed 's/[^a-zA-Z0-9]//g')" "$username" >/dev/null 2>&1; then
      echo "✓ Verification passed"
    else
      echo "⚠ Warning: Could not verify config"
    fi

    return 0
  else
    echo "✗ Failed to push config to $device"
    echo "Backup available at: $backup_file"
    return 1
  fi
}

# Batch or single device
if [ "$BATCH_MODE" = "--batch" ] && [ -f "$TARGET" ]; then
  echo "Batch mode: Processing devices from $TARGET"

  while IFS= read -r device || [ -n "$device" ]; do
    [[ "$device" =~ ^#.*$ ]] && continue
    [[ -z "$device" ]] && continue

    push_to_device "$device" "$CONFIG_FILE" "$USERNAME"
    echo ""
  done < "$TARGET"
else
  # Single device
  push_to_device "$TARGET" "$CONFIG_FILE" "$USERNAME"
fi
