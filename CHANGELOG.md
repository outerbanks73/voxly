# Changelog

All notable changes to Voxly are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/).

---

## [Unreleased]

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
