# Changelog

All notable changes to Voxly are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/).

---

## [Unreleased]

## [2.5.2] - 2026-02-14

### Changed
- Recording now uses microphone capture (getUserMedia) — reliable across all platforms
- Simplified background service worker (removed offscreen document complexity)

### Fixed
- Sidepanel script crash caused by duplicate `DEEPGRAM_WS_URL` const declaration (config.js already defines it)
- UI freeze when Supabase auth check hangs — initialization no longer blocks on network calls
- Auth check has 5-second timeout with fail-safe fallback

## [2.5.1] - 2026-02-13

### Added
- Microphone + tab audio mixing for real-time recording — both sides of calls are now transcribed
- Tab title captured as recording title (e.g., "Google Meet - Project Standup")
- URL transcription cascade: YouTube captions (free) → Supadata → Deepgram Nova-2
- Deepgram Nova-2 as universal fallback for all URL transcription failures
- Cascade metadata in transcription results (method used, steps attempted)

### Changed
- Record tab simplified to real-time only (removed "transcribe after recording" toggle)
- Edge Function `transcribe-url` rewritten with cost-optimized cascade logic
- Edge Functions deployed with `--no-verify-jwt` for ES256 token compatibility

### Fixed
- Blank transcript from real-time recording (missing start/end fields, race condition in stopRecording)
- Empty Supadata responses no longer treated as successful transcription
- Cascade error messages now match extension error handling for user-friendly display

## [2.0.1] - 2026-02-09

### Changed
- Switched from openai-whisper to faster-whisper (CTranslate2 backend) for ~4x faster transcription and lower memory usage

### Fixed
- 8-bug fix round:
  - Removed dead Server Auth Token UI from options page (was replaced by auto-configuration)
  - Added `:active` CSS for copy/edit button press feedback (darker blue on press)
  - Fixed event listener stacking in share modal and library tabs (guard flags)
  - Added null checks for share modal DOM elements
  - Removed duplicate `AUTH_SERVER_URL` constant in auth.js (uses `SERVER_URL` from config.js)
  - Fixed package.json version (was 1.0.0, now 2.0.0)
  - Escaped email addresses in share list to prevent XSS
- Fixed 401 "Missing auth token" error — Manifest V3 service workers don't send Origin headers on fetch(); server now accepts empty Origin
- Fixed YouTube timestamp links not appearing as hyperlinks — improved CSS visibility (blue, underlined) and regex handling for complex YouTube URL formats

## [2.0.0] - 2026-02-08

### Added
- OAuth accounts — Google, GitHub, email/password, magic links via Supabase Auth
- Cloud transcript storage — Supabase Postgres with automatic sync after transcription
- Transcript library — Full-text search, pagination, "Shared with me" tab
- Public sharing — Generate share links accessible without the extension
- User-to-user sharing — Share with specific users (read or write permissions)
- Developer API — REST API via Supabase Edge Functions with API key authentication
- Offline sync queue — Failed syncs queued and retried automatically (5 min interval, max 10 retries)
- Database schema with Row Level Security on all tables

### Changed
- Rebranded from SpeakToText Local to Voxly
- Extension talks directly to Supabase (server remains transcription-only, no cloud dependencies)

### Preserved
- Local-only mode — all core functionality works without an account
- No analytics or telemetry
- Privacy-first: all transcription runs locally

---

## [1.9.1]

### Fixed
- 401 error handling improvements
- TypeError handling in various edge cases
- Auth auto-configuration reliability

## [1.4.0]

### Added
- JSON export with full metadata schema
- Enhanced Markdown export with YAML frontmatter
- Metadata enrichment (source, duration, speakers, language, word count)

## [1.3.0]

### Added
- Safari extension support
- Automatic update notification system

## [1.2.0]

### Added
- Real-time transcription for tab recording
- Transcript editing
- SRT/VTT export
- Markdown/Obsidian export with YAML frontmatter

## [1.1.0]

### Added
- URL auto-population for streaming sites
- Subprocess worker isolation (worker.py)

### Fixed
- Broken pipe errors from tqdm in threaded contexts
