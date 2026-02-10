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
  TDD-v2.5.md        Design — current v2.5 cloud transcription system
  TDD-v2.0.md        Design — original v2.0 local-only system
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
supabase.min.js → config.js → supabase.js → cloud-auth.js → cloud-sync.js → transcription-service.js → ExtPay.js → [page].js
```
Functions reference globals from earlier scripts but are only called at runtime, not parse time.

### State Lives in Storage, Not Memory
Service workers are ephemeral. All important state goes in `chrome.storage.local`.

### Auth Pattern
- Cloud auth: `canUseCloudFeatures()` requires both `isPremiumUser()` AND `isCloudAuthenticated()`
- Never check just one — both gates must pass
- Edge Functions validate JWT via `supabase.auth.getUser(token)`

### Version Source of Truth
`extension/manifest.json` is the single source. `config.js` reads it via `chrome.runtime.getManifest().version`. HTML pages display it via `.version-tag` elements. No hardcoded version strings elsewhere.

### XSS Prevention
All user content rendered via `innerHTML` must be escaped. Use `escapeHtmlForShare()` or DOMPurify (`lib/purify.min.js`). This includes "safe" data like email addresses.

## Gotchas

### Event Listeners
Setup functions called multiple times (e.g., `setupShareButton()`) will stack event listeners. Use guard flags (`_shareListenersAttached`) to prevent double-binding.

### CSS :active vs .active
`:active` = momentary press feedback (CSS pseudo-class). `.active` = persistent selected state (JS-toggled class). Both are needed — missing `:active` makes buttons feel broken.

## Key Files

| File | Role | Note |
|------|------|------|
| `extension/background.js` | Service worker | Ephemeral — save state to storage immediately |
| `extension/sidepanel.js` | Main UI | Check storage on load for recovered results |
| `extension/config.js` | Shared constants | Version, URLs, cloud endpoints |
| `extension/cloud-auth.js` | Supabase auth | OAuth, session management |
| `extension/cloud-sync.js` | Cloud operations | Sync, sharing, API keys, offline queue |
| `extension/transcription-service.js` | Cloud transcription | Deepgram + Supadata via Edge Functions |
| `extension/transcript.js` | Transcript page | Viewer, editor, export, share modal |
| `supabase/functions/transcribe/` | Edge Function | File → Deepgram Nova-2 |
| `supabase/functions/transcribe-url/` | Edge Function | URL → Supadata |
| `supabase/functions/realtime-token/` | Edge Function | Temp Deepgram key for streaming |
