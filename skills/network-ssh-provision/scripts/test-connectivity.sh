#!/bin/bash
# test-connectivity.sh - Test SSH connectivity to devices

set -euo pipefail

DEVICE_LIST="${1:?Missing device list file}"
USERNAME="${2:-admin}"

echo "Testing SSH connectivity..."
echo ""

SUCCESS=0
FAILED=0

while IFS= read -r device || [ -n "$device" ]; do
  [[ "$device" =~ ^#.*$ ]] && continue
  [[ -z "$device" ]] && continue

  printf "%-30s " "$device"
  
  if timeout 10 ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "${USERNAME}@${device}" "exit" 2>/dev/null; then
    echo "✓ OK"
    ((SUCCESS++))
  else
    echo "✗ FAILED"
    ((FAILED++))
  fi
done < "$DEVICE_LIST"

echo ""
echo "Results: $SUCCESS success, $FAILED failed"
