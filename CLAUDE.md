# SpeakToText Local - Development Guidelines

## Chrome Extension Development Lessons Learned

### 1. Chrome Extension Service Workers are Ephemeral (Manifest V3)
- **Problem:** Service workers can be terminated and restarted by Chrome at any time to save resources
- **Solution:**
  - Never rely on in-memory state (`let activeJob = null`) for long-running operations
  - Always persist important state to `chrome.storage.local`
  - On sidepanel `DOMContentLoaded`, check storage for completed results that weren't displayed
  - Background worker should save results to storage immediately upon completion

### 2. Sidepanel Resilience
- **Problem:** Sidepanel can close/reopen during long operations (user closes it, Chrome kills it)
- **Solution:**
  - Background worker handles polling and saves results to `chrome.storage.local`
  - Sidepanel's `checkActiveJob()` should check BOTH background worker memory AND storage
  - Results survive service worker restarts and sidepanel reopens

### 3. Python venv Path Issues
- **Problem:** Hardcoding venv paths like `/path/to/venv/bin/python` causes stale path errors
- **Solution:**
  - Use `sys.executable` instead - it's always correct when venv is activated
  - Let startup scripts handle venv activation before running Python
  - Verify dependencies are actually installed (not just that venv directory exists)
  - Check for venv module availability before attempting to create venv

### 4. Long-Running Operations Need Generous Timeouts
- **Problem:** Default timeouts (5 min for FFmpeg) are too short for long videos
- **Solution:**
  - Set appropriate timeouts (e.g., 1 hour for FFmpeg conversion)
  - Always show progress/confirmation dialogs for user awareness
  - Don't silently fail - surface errors clearly

### 5. Server Process Management with Start/Stop Scripts
- **Problem:** Manual process management is error-prone and inconsistent
- **Solution:**
  - Create dedicated `start-server.sh` and `stop-server.sh` scripts
  - Scripts should:
    - **Establish environment:** Activate venv, set environment variables
    - **Check prerequisites:** Verify venv exists, dependencies installed
    - **Kill existing processes:** Use `pkill` with verification that process is dead before starting new one
    - **Verify startup:** Check process is running after launch
    - **Verify shutdown:** Confirm process is dead after kill
    - **Log everything:** Write to log files for debugging
  - All other scripts (update.sh, install.sh) should invoke these scripts rather than managing processes directly
  - Never duplicate process management logic - single source of truth

## Project Structure
- `/extension/` - Chrome extension (Manifest V3)
- `/server/` - Python FastAPI backend with Whisper transcription
- `start-server.sh` / `stop-server.sh` - Server lifecycle management
- `install.sh` / `update.sh` - Installation and update scripts

## Key Files
- `extension/background.js` - Service worker (ephemeral, save state to storage)
- `extension/sidepanel.js` - UI (check storage on load for recovered results)
- `server/server.py` - FastAPI server (use sys.executable, not hardcoded paths)
- `server/worker.py` - Transcription worker (generous timeouts for long operations)
