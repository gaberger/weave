#!/bin/bash
# ssh-device.sh - Execute SSH command on network device with error handling

set -euo pipefail

# Usage: ssh-device.sh <host> <command> [username] [timeout]
HOST="${1:?Missing host}"
COMMAND="${2:?Missing command}"
USERNAME="${3:-admin}"
TIMEOUT="${4:-30}"

# SSH options for network devices
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=10"

# Execute with timeout
timeout "$TIMEOUT" ssh $SSH_OPTS "${USERNAME}@${HOST}" "$COMMAND"
EXIT_CODE=$?

if [ $EXIT_CODE -eq 124 ]; then
  echo "ERROR: Command timed out after ${TIMEOUT}s" >&2
  exit 1
elif [ $EXIT_CODE -ne 0 ]; then
  echo "ERROR: SSH command failed (exit code: $EXIT_CODE)" >&2
  exit $EXIT_CODE
fi
