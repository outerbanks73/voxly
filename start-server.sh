#!/bin/bash
# SpeakToText Local Server Launcher

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
source "$SCRIPT_DIR/server/venv/bin/activate"
python "$SCRIPT_DIR/server/server.py"
