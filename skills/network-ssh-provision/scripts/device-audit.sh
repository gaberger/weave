#!/bin/bash
# device-audit.sh - Audit devices and collect status information

set -euo pipefail

# Usage: device-audit.sh <device-list-file> [username] [output-dir]
DEVICE_LIST="${1:?Missing device list file}"
USERNAME="${2:-admin}"
OUTPUT_DIR="${3:-./audit-$(date +%Y%m%d_%H%M%S)}"

mkdir -p "$OUTPUT_DIR"
echo "Audit output directory: $OUTPUT_DIR"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Audit commands (vendor agnostic attempts)
declare -a COMMANDS=(
  "show version"
  "show running-config"
  "show ip interface brief"
  "show inventory"
  "show logging"
)

while IFS= read -r device || [ -n "$device" ]; do
  [[ "$device" =~ ^#.*$ ]] && continue
  [[ -z "$device" ]] && continue

  echo "=== Auditing: $device ==="
  mkdir -p "$OUTPUT_DIR/$device"

  # Connectivity test
  if ! "$SCRIPT_DIR/ssh-device.sh" "$device" "show version" "$USERNAME" > "$OUTPUT_DIR/$device/version.txt" 2>&1; then
    echo "✗ Cannot connect to $device"
    echo "UNREACHABLE" > "$OUTPUT_DIR/$device/status.txt"
    continue
  fi

  echo "REACHABLE" > "$OUTPUT_DIR/$device/status.txt"
  echo "✓ Connected to $device"

  # Run audit commands
  for cmd in "${COMMANDS[@]}"; do
    filename=$(echo "$cmd" | sed 's/ /_/g').txt
    echo "  Running: $cmd"

    if "$SCRIPT_DIR/ssh-device.sh" "$device" "$cmd" "$USERNAME" > "$OUTPUT_DIR/$device/$filename" 2>&1; then
      echo "  ✓ Saved to $filename"
    else
      echo "  ⚠ Command failed or not supported"
    fi
  done

  echo ""
done < "$DEVICE_LIST"

# Generate summary
echo ""
echo "=== Audit Summary ==="
echo "Total devices: $(grep -c -v '^#\|^$' "$DEVICE_LIST")"
echo "Reachable: $(find "$OUTPUT_DIR" -name "status.txt" -exec grep -l "REACHABLE" {} \; | wc -l)"
echo "Unreachable: $(find "$OUTPUT_DIR" -name "status.txt" -exec grep -l "UNREACHABLE" {} \; | wc -l)"
echo "Output directory: $OUTPUT_DIR"

# Create summary CSV
echo "device,status,version" > "$OUTPUT_DIR/summary.csv"
for device_dir in "$OUTPUT_DIR"/*/; do
  device=$(basename "$device_dir")
  status=$(cat "$device_dir/status.txt" 2>/dev/null || echo "UNKNOWN")
  version=$(head -1 "$device_dir/version.txt" 2>/dev/null | tr -d '\n' | cut -c1-50 || echo "N/A")
  echo "$device,$status,\"$version\"" >> "$OUTPUT_DIR/summary.csv"
done

echo "Summary CSV: $OUTPUT_DIR/summary.csv"
