# Voxly — Development Guide

## Build & Run

```bash
# Start the Python transcription server
cd server && source venv/bin/activate && python server.py
# Or use the lifecycle scripts:
./start-server.sh
./stop-server.sh

# Load the Chrome extension
# 1. chrome://extensions → Enable Developer Mode
# 2. Load Unpacked → select the extension/ directory

# Install Python dependencies
cd server && source venv/bin/activate && pip install -r requirements.txt

# No frontend build step — extension is vanilla JS, loaded directly by Chrome
```

## Project Structure

```
extension/           Chrome extension (Manifest V3, vanilla JS)
server/              Python FastAPI server (transcription engine)
supabase/            Database migrations + Edge Functions
docs/
  PRD.md             Requirements — what we build and why
  TDD-v2.0.md        Design — how the shipped v2.0 system works
  TDD-v3.0.md        Design — planned v3.0 Tauri desktop app
CHANGELOG.md         Post-release change tracking
start-server.sh      Server lifecycle (start)
stop-server.sh       Server lifecycle (stop)
install.sh           First-time setup
update.sh            Pull + restart
```

## Documentation Rules

- **PRD** contains requirements only. No architecture, no design decisions.
- **TDD** contains all design decisions. Versioned per major release (FAANG pattern).
- **CHANGELOG** tracks every shipped change after a major release.
- When adding a feature, update the TDD. When adding a requirement, update the PRD.

## Conventions

### Extension Script Loading Order
HTML pages load scripts in this dependency chain:
```
supabase.min.js → config.js → auth.js → supabase.js → cloud-auth.js → cloud-sync.js → ExtPay.js → [page].js
```
Functions reference globals from earlier scripts but are only called at runtime, not parse time.

### State Lives in Storage, Not Memory
Service workers are ephemeral. All important state goes in `chrome.storage.local`. In-memory variables (like `activeJob` in background.js) are convenience caches — storage is the source of truth.

### Auth Pattern
- Server auth: `authenticatedFetch()` in `auth.js` handles token auto-fetch and 401 retry
- Cloud auth: `canUseCloudFeatures()` requires both `isPremiumUser()` AND `isCloudAuthenticated()`
- Never check just one — both gates must pass

### Version Source of Truth
`extension/manifest.json` is the single source. `config.js` reads it via `chrome.runtime.getManifest().version`. HTML pages display it via `.version-tag` elements. No hardcoded version strings elsewhere.

### XSS Prevention
All user content rendered via `innerHTML` must be escaped. Use `escapeHtmlForShare()` or DOMPurify (`lib/purify.min.js`). This includes "safe" data like email addresses.

## Gotchas

### Service Workers Don't Send Origin Headers
Manifest V3 `fetch()` from service workers omits the `Origin` header. Any server endpoint that validates Origin must accept empty Origin, or the extension silently gets 401s.

### Subprocess Isolation for Whisper
`worker.py` runs as a subprocess, not a thread. This prevents tqdm broken pipes, ensures clean memory release, and avoids PyTorch/CUDA thread conflicts. Don't refactor this into async — the isolation is intentional.

### venv Paths
Never hardcode venv paths. Use `sys.executable` in Python code. Let `start-server.sh` handle venv activation.

### Timeouts
FFmpeg conversion: 1 hour timeout (long videos). Whisper inference: no timeout. Don't reduce these.

### Event Listeners
Setup functions called multiple times (e.g., `setupShareButton()`) will stack event listeners. Use guard flags (`_shareListenersAttached`) to prevent double-binding.

### CSS :active vs .active
`:active` = momentary press feedback (CSS pseudo-class). `.active` = persistent selected state (JS-toggled class). Both are needed — missing `:active` makes buttons feel broken.

## Key Files

| File | Role | Note |
|------|------|------|
| `extension/background.js` | Service worker | Ephemeral — save state to storage immediately |
| `extension/sidepanel.js` | Main UI | Check storage on load for recovered results |
| `extension/config.js` | Shared constants | Version, URLs, polling intervals |
| `extension/auth.js` | Server auth | Auto-token fetch + 401 retry |
| `extension/cloud-auth.js` | Supabase auth | OAuth, session management |
| `extension/cloud-sync.js` | Cloud operations | Sync, sharing, API keys, offline queue |
| `extension/transcript.js` | Transcript page | Viewer, editor, export, share modal |
| `server/server.py` | FastAPI server | Use `sys.executable`, not hardcoded paths |
| `server/worker.py` | Transcription worker | Subprocess isolation — don't thread this |
