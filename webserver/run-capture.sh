#!/bin/bash
#
# Periodic capture script for package detection
# Runs capture.js at regular intervals
#
# Usage: ./run-capture.sh [interval_seconds]
# Default interval: 60 seconds
#

INTERVAL=${1:-60}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "=================================="
echo "  Package Detection Capture Loop"
echo "=================================="
echo "Interval: ${INTERVAL} seconds"
echo "Project: $PROJECT_DIR"
echo "Press Ctrl+C to stop"
echo "=================================="
echo ""

while true; do
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Running capture.js..."
    node capture.js

    EXIT_CODE=$?
    if [ $EXIT_CODE -ne 0 ]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] capture.js exited with code $EXIT_CODE"
    fi

    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Sleeping for ${INTERVAL}s..."
    sleep "$INTERVAL"
done
