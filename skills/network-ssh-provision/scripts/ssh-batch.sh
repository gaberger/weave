#!/bin/bash
# ssh-batch.sh - Execute command on multiple devices from a list

set -euo pipefail

# Usage: ssh-batch.sh <device-list-file> <command> [username] [parallel-jobs]
DEVICE_LIST="${1:?Missing device list file}"
COMMAND="${2:?Missing command}"
USERNAME="${3:-admin}"
PARALLEL_JOBS="${4:-1}"

if [ ! -f "$DEVICE_LIST" ]; then
  echo "ERROR: Device list file not found: $DEVICE_LIST" >&2
  exit 1
fi

# Get script directory for helper script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Function to execute on single device
run_device() {
  local device="$1"
  local command="$2"
  local username="$3"

  echo "=== $device ==="
  if "$SCRIPT_DIR/ssh-device.sh" "$device" "$command" "$username" 2>&1; then
    echo "✓ Success: $device"
  else
    echo "✗ Failed: $device"
    return 1
  fi
  echo ""
}

export -f run_device
export SCRIPT_DIR USERNAME COMMAND

# Execute
if [ "$PARALLEL_JOBS" -gt 1 ] && command -v parallel >/dev/null 2>&1; then
  # Use GNU parallel if available
  cat "$DEVICE_LIST" | grep -v '^#' | grep -v '^[[:space:]]*$' | \
    parallel --jobs "$PARALLEL_JOBS" run_device {} "$COMMAND" "$USERNAME"
else
  # Sequential execution
  while IFS= read -r device || [ -n "$device" ]; do
    # Skip comments and empty lines
    [[ "$device" =~ ^#.*$ ]] && continue
    [[ -z "$device" ]] && continue

    run_device "$device" "$COMMAND" "$USERNAME"
  done < "$DEVICE_LIST"
fi
