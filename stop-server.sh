#!/bin/bash
# SpeakToText Local Server Stopper

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PID_FILE="$SCRIPT_DIR/server/.server.pid"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "Stopping SpeakToText Local Server..."

if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        kill "$PID" 2>/dev/null
        sleep 1
        # Force kill if still alive
        if kill -0 "$PID" 2>/dev/null; then
            kill -9 "$PID" 2>/dev/null
        fi
        echo -e "${GREEN}Server stopped (PID: $PID)${NC}"
    else
        echo -e "${YELLOW}Server process (PID: $PID) was not running${NC}"
    fi
    rm -f "$PID_FILE"
else
    # Fallback: try pkill
    pkill -f "python.*server\.py" 2>/dev/null
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}Server stopped${NC}"
    else
        echo -e "${YELLOW}No server processes found${NC}"
    fi
fi

echo "Done."
