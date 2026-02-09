# Voxly (formerly SpeakToText Local) - Development Guidelines

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

## Supabase Cloud Architecture (v2.0.0)

### Architecture: Extension talks directly to Supabase
- Server stays transcription-only — no cloud dependencies in Python
- Extension handles all Supabase communication (auth, storage, sync)
- This enables future remote model swap without untangling storage

### Script Loading Order (HTML pages)
```
supabase.min.js → config.js → auth.js → supabase.js → cloud-auth.js → cloud-sync.js → ExtPay.js → [page].js
```
Functions are defined at load time but only called at runtime, so `isPremiumUser()` (defined in the page-specific JS after ExtPay) is available when `canUseCloudFeatures()` executes.

### Auth Flow
1. OAuth: `chrome.identity.launchWebAuthFlow()` → Supabase OAuth URL → parse hash tokens → `setSession()`
2. Session stored via custom `chromeStorageAdapter` in `chrome.storage.local` (service workers can't use localStorage)
3. Background alarm refreshes session every 55 min (tokens expire at 60)
4. `canUseCloudFeatures()` requires both `isPremiumUser()` AND `isCloudAuthenticated()`

### Cloud Sync
- Auto-sync after transcription completes (`trySyncOrQueue()`)
- Offline queue in `chrome.storage.local.pendingSyncQueue`, retried every 5 min (max 10)
- Cloud features are opt-in — local-only mode fully preserved

### Key Cloud Files
- `extension/supabase.js` - Client singleton with chrome.storage.local adapter
- `extension/cloud-auth.js` - OAuth, email, magic link auth flows
- `extension/cloud-sync.js` - Sync, fetch, share, API key CRUD functions
- `extension/library.html/js` - Transcript library (search, pagination, shared tab)
- `extension/share.html/js` - Public share viewer (no auth needed)
- `supabase/migrations/001_initial_schema.sql` - Full DB schema with RLS
- `supabase/functions/api-transcripts/index.ts` - Edge Function for developer API

### Database Tables
- `profiles` - Auto-created on signup via trigger
- `transcripts` - User transcripts with full-text search index
- `transcript_shares` - User-to-user sharing with read/write permissions
- `api_keys` - Developer API keys (SHA-256 hashed, prefix stored)

### RLS
Row Level Security is enabled on ALL tables. `user_id` filtering on all policies. Anon key can only read public shares.

## Project Structure
- `/extension/` - Chrome extension (Manifest V3)
- `/server/` - Python FastAPI backend with Whisper transcription
- `/supabase/` - Database migrations and Edge Functions
- `start-server.sh` / `stop-server.sh` - Server lifecycle management
- `install.sh` / `update.sh` - Installation and update scripts

## Key Files
- `extension/background.js` - Service worker (ephemeral, save state to storage)
- `extension/sidepanel.js` - UI (check storage on load for recovered results)
- `extension/config.js` - Shared constants (SUPABASE_URL, SUPABASE_ANON_KEY, etc.)
- `server/server.py` - FastAPI server (use sys.executable, not hardcoded paths)
- `server/worker.py` - Transcription worker (generous timeouts for long operations)
