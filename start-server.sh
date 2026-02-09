#!/bin/bash
# SpeakToText Local Server Launcher

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PORT=5123
LOG_FILE="$SCRIPT_DIR/server/server.log"
PID_FILE="$SCRIPT_DIR/server/.server.pid"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo "🎙️  SpeakToText Local Server"
echo "================================"

# Kill any existing server process (prefer PID file, fall back to pkill)
echo -e "${YELLOW}Checking for existing server processes...${NC}"
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
        kill "$OLD_PID" 2>/dev/null
        sleep 1
        # Force kill if still alive
        kill -9 "$OLD_PID" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
else
    pkill -f "python.*server\.py" 2>/dev/null || true
fi
sleep 1

echo -e "${GREEN}✓ Ready to start${NC}"

# Check if virtual environment exists and has dependencies installed
if [ ! -f "$SCRIPT_DIR/server/venv/bin/activate" ]; then
    echo -e "${YELLOW}⚠️  No virtual environment found. Creating one...${NC}"

    # Check if venv module is available
    if ! python3 -m venv --help > /dev/null 2>&1; then
        echo -e "${RED}✗ Python venv module not found${NC}"
        echo ""
        echo "Please install the venv module:"
        echo "  macOS:  (should be included with Python)"
        echo "  Ubuntu: sudo apt install python3-venv"
        echo "  Fedora: sudo dnf install python3-venv"
        exit 1
    fi

    python3 -m venv "$SCRIPT_DIR/server/venv"
    source "$SCRIPT_DIR/server/venv/bin/activate"
    echo "Installing dependencies (this may take a few minutes)..."
    pip install -r "$SCRIPT_DIR/server/requirements.txt"
    if [ $? -ne 0 ]; then
        echo -e "${RED}✗ Failed to install dependencies${NC}"
        exit 1
    fi
    echo -e "${GREEN}✓ Virtual environment created and dependencies installed${NC}"
else
    source "$SCRIPT_DIR/server/venv/bin/activate"
    # Verify fastapi is installed (quick check that deps are present)
    if ! python -c "import fastapi" 2>/dev/null; then
        echo -e "${YELLOW}⚠️  Dependencies missing. Installing...${NC}"
        pip install -r "$SCRIPT_DIR/server/requirements.txt"
        if [ $? -ne 0 ]; then
            echo -e "${RED}✗ Failed to install dependencies${NC}"
            exit 1
        fi
        echo -e "${GREEN}✓ Dependencies installed${NC}"
    fi
fi

echo -e "${GREEN}Starting server on http://localhost:$PORT${NC}"
echo "Log file: $LOG_FILE"
echo ""

# Start server in background, redirect output to log file
nohup python "$SCRIPT_DIR/server/server.py" > "$LOG_FILE" 2>&1 &
SERVER_PID=$!

# Wait a moment and check if it started
sleep 2

if kill -0 $SERVER_PID 2>/dev/null; then
    echo "$SERVER_PID" > "$PID_FILE"
    echo -e "${GREEN}✓ Server started successfully (PID: $SERVER_PID)${NC}"
    echo ""
    # Display auth token for the user to copy into extension settings
    AUTH_TOKEN_FILE="$HOME/.voxly/auth_token"
    if [ -f "$AUTH_TOKEN_FILE" ]; then
        echo -e "${YELLOW}🔑 Auth Token (paste this into extension settings):${NC}"
        cat "$AUTH_TOKEN_FILE"
        echo ""
        echo ""
    fi
    echo "To view logs:  tail -f $LOG_FILE"
    echo "To stop:       ./stop-server.sh"
else
    echo -e "${RED}✗ Server failed to start. Check logs:${NC}"
    cat "$LOG_FILE"
    exit 1
fi
