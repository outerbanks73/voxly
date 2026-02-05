#!/bin/bash
#
# SpeakToText Local - One-Click Installer
# For macOS and Linux
#

set -e

echo "=============================================="
echo "  SpeakToText Local - Installer"
echo "=============================================="
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check for Python 3.9+
check_python() {
    echo "Checking Python installation..."

    if command -v python3 &> /dev/null; then
        PYTHON_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
        MAJOR=$(echo $PYTHON_VERSION | cut -d. -f1)
        MINOR=$(echo $PYTHON_VERSION | cut -d. -f2)

        if [ "$MAJOR" -ge 3 ] && [ "$MINOR" -ge 9 ]; then
            echo -e "${GREEN}✓ Python $PYTHON_VERSION found${NC}"
            return 0
        fi
    fi

    echo -e "${RED}✗ Python 3.9+ required${NC}"
    echo "Please install Python 3.9 or higher:"
    echo "  macOS: brew install python@3.11"
    echo "  Ubuntu: sudo apt install python3.11"
    exit 1
}

# Check for ffmpeg
check_ffmpeg() {
    echo "Checking ffmpeg installation..."

    if command -v ffmpeg &> /dev/null; then
        echo -e "${GREEN}✓ ffmpeg found${NC}"
        return 0
    fi

    echo -e "${YELLOW}⚠ ffmpeg not found${NC}"
    echo "Installing ffmpeg..."

    if [[ "$OSTYPE" == "darwin"* ]]; then
        if command -v brew &> /dev/null; then
            brew install ffmpeg
        else
            echo -e "${RED}Please install Homebrew first: https://brew.sh${NC}"
            exit 1
        fi
    elif command -v apt-get &> /dev/null; then
        sudo apt-get update && sudo apt-get install -y ffmpeg
    elif command -v dnf &> /dev/null; then
        sudo dnf install -y ffmpeg
    else
        echo -e "${RED}Please install ffmpeg manually${NC}"
        exit 1
    fi

    echo -e "${GREEN}✓ ffmpeg installed${NC}"
}

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
SERVER_DIR="$SCRIPT_DIR/server"
VENV_DIR="$SERVER_DIR/venv"

# Create virtual environment
setup_venv() {
    echo ""
    echo "Setting up Python virtual environment..."

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

    if [ -d "$VENV_DIR" ]; then
        echo "Virtual environment already exists, updating..."
    else
        python3 -m venv "$VENV_DIR"
        echo -e "${GREEN}✓ Virtual environment created${NC}"
    fi

    # Activate and install dependencies
    source "$VENV_DIR/bin/activate"

    echo "Installing Python dependencies (this may take a few minutes)..."
    pip install --upgrade pip > /dev/null 2>&1
    pip install -r "$SERVER_DIR/requirements.txt"

    echo -e "${GREEN}✓ Dependencies installed${NC}"
}

# Create launcher scripts
create_launcher() {
    echo ""
    echo "Creating launcher scripts..."

    # Create start-server.sh
    LAUNCHER="$SCRIPT_DIR/start-server.sh"

    cat > "$LAUNCHER" << 'EOF'
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
    echo -e "${GREEN}✓ Server started successfully (PID: $SERVER_PID)${NC}"
    echo ""
    echo "To view logs:  tail -f $LOG_FILE"
    echo "To stop:       ./stop-server.sh"
else
    echo -e "${RED}✗ Server failed to start. Check logs:${NC}"
    cat "$LOG_FILE"
    exit 1
fi
EOF

    chmod +x "$LAUNCHER"
    echo -e "${GREEN}✓ Launcher created: start-server.sh${NC}"

    # Create stop-server.sh
    STOPPER="$SCRIPT_DIR/stop-server.sh"

    cat > "$STOPPER" << 'EOF'
#!/bin/bash
# SpeakToText Local Server Stopper

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "🛑 Stopping SpeakToText Local Server..."

# Kill any python server.py or uvicorn processes
pkill -9 -f "server\.py" 2>/dev/null
pkill -9 -f "uvicorn" 2>/dev/null

# Check if any were killed
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Server stopped${NC}"
else
    echo -e "${YELLOW}⚠️  No server processes found${NC}"
fi

echo "Done."
EOF

    chmod +x "$STOPPER"
    echo -e "${GREEN}✓ Stopper created: stop-server.sh${NC}"
}

# Create macOS app (optional)
create_macos_app() {
    if [[ "$OSTYPE" != "darwin"* ]]; then
        return
    fi

    echo ""
    echo "Creating macOS application..."

    APP_DIR="$SCRIPT_DIR/SpeakToText Server.app"
    mkdir -p "$APP_DIR/Contents/MacOS"
    mkdir -p "$APP_DIR/Contents/Resources"

    # Create Info.plist
    cat > "$APP_DIR/Contents/Info.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>launcher</string>
    <key>CFBundleIdentifier</key>
    <string>com.speaktotext.local</string>
    <key>CFBundleName</key>
    <string>SpeakToText Server</string>
    <key>CFBundleVersion</key>
    <string>1.0.0</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
</dict>
</plist>
EOF

    # Create launcher
    cat > "$APP_DIR/Contents/MacOS/launcher" << EOF
#!/bin/bash
SCRIPT_DIR="\$( cd "\$( dirname "\${BASH_SOURCE[0]}" )/../../../" && pwd )"
osascript -e 'tell application "Terminal" to do script "cd \"'\$SCRIPT_DIR'\" && ./start-server.sh"'
EOF

    chmod +x "$APP_DIR/Contents/MacOS/launcher"

    echo -e "${GREEN}✓ macOS app created: SpeakToText Server.app${NC}"
}

# Main installation
main() {
    check_python
    check_ffmpeg
    setup_venv
    create_launcher
    create_macos_app

    echo ""
    echo "=============================================="
    echo -e "${GREEN}  Installation Complete!${NC}"
    echo "=============================================="
    echo ""
    echo "Next steps:"
    echo ""
    echo "1. Start the server:"
    echo "   ${YELLOW}./start-server.sh${NC}"
    echo ""
    echo "2. Install the Chrome extension:"
    echo "   - Open Chrome and go to: chrome://extensions"
    echo "   - Enable 'Developer mode' (top right)"
    echo "   - Click 'Load unpacked'"
    echo "   - Select the 'extension' folder in this directory"
    echo ""
    echo "3. (Optional) Configure speaker diarization:"
    echo "   - Click the extension icon → Settings"
    echo "   - Add your Hugging Face token"
    echo ""
    echo "The server must be running for the extension to work."
    echo ""
}

main
