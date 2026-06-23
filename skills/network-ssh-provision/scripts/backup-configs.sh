#!/bin/bash
# backup-configs.sh - Backup device configurations

set -euo pipefail

# Usage: backup-configs.sh <device-list-file> [username] [backup-dir]
DEVICE_LIST="${1:?Missing device list file}"
USERNAME="${2:-admin}"
BACKUP_DIR="${3:-./backups}"

DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_PATH="$BACKUP_DIR/$DATE"

mkdir -p "$BACKUP_PATH"
echo "Backing up configs to: $BACKUP_PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SUCCESS_COUNT=0
FAIL_COUNT=0

while IFS= read -r device || [ -n "$device" ]; do
  # Skip comments and empty lines
  [[ "$device" =~ ^#.*$ ]] && continue
  [[ -z "$device" ]] && continue

  echo "Backing up: $device"

  # Try multiple commands (different vendor syntaxes)
  if "$SCRIPT_DIR/ssh-device.sh" "$device" "show running-config" "$USERNAME" 2>/dev/null > "$BACKUP_PATH/${device}.cfg"; then
    echo "✓ Backed up: $device"
    ((SUCCESS_COUNT++))
  elif "$SCRIPT_DIR/ssh-device.sh" "$device" "show configuration" "$USERNAME" 2>/dev/null > "$BACKUP_PATH/${device}.cfg"; then
    echo "✓ Backed up: $device (Junos)"
    ((SUCCESS_COUNT++))
  elif "$SCRIPT_DIR/ssh-device.sh" "$device" "show config" "$USERNAME" 2>/dev/null > "$BACKUP_PATH/${device}.cfg"; then
    echo "✓ Backed up: $device (Palo Alto)"
    ((SUCCESS_COUNT++))
  else
    echo "✗ Failed: $device"
    ((FAIL_COUNT++))
  fi
done < "$DEVICE_LIST"

echo ""
echo "=== Backup Summary ==="
echo "Success: $SUCCESS_COUNT"
echo "Failed: $FAIL_COUNT"
echo "Location: $BACKUP_PATH"
