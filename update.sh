#!/bin/bash

# SpeakToText Local - Update Script
# Updates the application to the latest version from GitHub

set -e

echo "========================================"
echo "  SpeakToText Local - Update Script"
echo "========================================"
echo

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# Check if git is available
if ! command -v git &> /dev/null; then
    echo "Error: git is not installed."
    echo "Please install git and try again."
    exit 1
fi

# Check if we're in a git repo
if [ ! -d ".git" ]; then
    echo "Error: This doesn't appear to be a git repository."
    echo "Please run this script from the speaktotext-local directory."
    exit 1
fi

# Get current version
CURRENT_VERSION=$(grep '"version"' extension/manifest.json | head -1 | sed 's/.*"version": "\([^"]*\)".*/\1/')
echo "Current version: $CURRENT_VERSION"

# Fetch latest from remote
echo
echo "Fetching updates from GitHub..."
git fetch origin main

# Check if there are updates
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
    echo
    echo "✅ You're already on the latest version!"
    exit 0
fi

# Show what's new
echo
echo "📦 Updates available!"
echo
echo "Changes since your version:"
git log --oneline HEAD..origin/main | head -10
echo

# Pull updates
echo "Downloading updates..."
git pull origin main

# Get new version
NEW_VERSION=$(grep '"version"' extension/manifest.json | head -1 | sed 's/.*"version": "\([^"]*\)".*/\1/')
echo
echo "✅ Updated from v$CURRENT_VERSION to v$NEW_VERSION"

# Check if server is running and restart it
echo
echo "Checking for running server..."
if pgrep -f "server.py" > /dev/null; then
    echo "Restarting server with updates..."
    ./stop-server.sh
    ./start-server.sh
    echo "✅ Server restarted"
else
    echo "Server not running. Start it with: ./start-server.sh"
fi

echo
echo "========================================"
echo "  Update Complete!"
echo "========================================"
echo
echo "Next steps:"
echo "1. Go to chrome://extensions"
echo "2. Find 'SpeakToText Local'"
echo "3. Click the refresh/reload icon (🔄)"
echo
echo "Enjoy the new features!"
