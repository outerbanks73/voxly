#!/bin/bash
# SpeakToText Local Server Launcher

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PORT=5123
LOG_FILE="$SCRIPT_DIR/server/server.log"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo "🎙️  SpeakToText Local Server"
echo "================================"

# Kill any existing python server.py processes
echo -e "${YELLOW}Checking for existing server processes...${NC}"
pkill -9 -f "server\.py" 2>/dev/null || true
pkill -9 -f "uvicorn" 2>/dev/null || true
sleep 2

echo -e "${GREEN}✓ Ready to start${NC}"

# Check if virtual environment exists and has dependencies installed
if [ ! -f "$SCRIPT_DIR/server/venv/bin/activate" ]; then
    echo -e "${YELLOW}⚠️  No virtual environment found. Creating one...${NC}"
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
    echo -e "${GREEN}✓ Server started successfully (PID: $SERVER_PID)${NC}"
    echo ""
    echo "To view logs:  tail -f $LOG_FILE"
    echo "To stop:       ./stop-server.sh"
else
    echo -e "${RED}✗ Server failed to start. Check logs:${NC}"
    cat "$LOG_FILE"
    exit 1
fi
