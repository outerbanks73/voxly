# Voxly - Product Requirements Document

**Version:** 2.0.0
**Last Updated:** February 2026

---

## 1. Overview

Voxly is a cloud-enabled audio transcription platform that transforms audio and video content into structured, AI-ready formats. It consists of a Chrome extension frontend, a local Python transcription server, and a Supabase cloud backend for storage, sharing, and API access.

**Key Value Proposition:** Convert spoken content into formats optimized for LLM consumption, RAG pipelines, knowledge bases, and data workflows — with optional cloud sync, sharing, and developer API.

**Design:** See [TDD-v2.0.md](TDD-v2.0.md) for architecture and design decisions.

---

## 2. Functional Requirements

### 2.1 Input Methods

| Method | Description |
|--------|-------------|
| **File Upload** | User selects local audio/video file |
| **URL** | User provides URL to audio/video (YouTube, podcasts, etc.) |
| **Tab Recording** | Captures audio from active browser tab |
| **YouTube Transcript** | Extract existing YouTube captions without transcription |

### 2.2 Transcription Options

| Option | Values | Default |
|--------|--------|---------|
| **Model** | tiny, base, small, medium, large | base |
| **Speaker Diarization** | Enabled/Disabled | Disabled |
| **HF Token** | User-provided (required for diarization) | None |

### 2.3 Export Formats

| Format | Use Case |
|--------|----------|
| **JSON** | APIs, databases, RAG pipelines |
| **Markdown** | Obsidian, Notion, note-taking |
| **SRT** | Video editing, YouTube subtitles |
| **VTT** | Web video, HTML5 players |
| **TXT** | Universal plain text |

### 2.4 Cloud Features (Premium)

| Feature | Description |
|---------|-------------|
| **Cloud Sync** | Auto-sync transcripts after transcription |
| **Transcript Library** | Full-text search, pagination, browsing all past transcripts |
| **Public Sharing** | Generate share links accessible without the extension |
| **User-to-User Sharing** | Share with specific users (read or write permission) |
| **Developer API** | REST API with API key authentication for CRUD operations |
| **Offline Queue** | Failed syncs queued and retried automatically |

### 2.5 Metadata Enrichment

Every export includes:
- **Source**: URL, filename, or "Tab Recording"
- **Duration**: Total audio length
- **Word Count**: Total words in transcript
- **Speakers**: List of identified speakers (if diarization enabled)
- **Language**: Detected language
- **Model**: Whisper model used
- **Processed At**: ISO timestamp

---

## 3. Non-Functional Requirements

### 3.1 Privacy & Local Processing
- All transcription happens on user's machine
- No data transmission to external servers (except URL fetching via yt-dlp)
- Cloud sync is opt-in and requires premium + explicit login
- No analytics or telemetry
- No account required for core functionality

### 3.2 Performance
- Tiny model: ~10x realtime on CPU
- Base model: ~5x realtime on CPU
- Large model: ~1x realtime on CPU (faster with GPU)
- faster-whisper provides ~4x speed improvement over original openai-whisper

### 3.3 Compatibility
- Python 3.9+
- Chrome/Chromium browsers
- macOS, Linux, Windows

---

## 4. API Requirements

### 4.1 Local Server Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Server status check |
| `/transcribe/file` | POST | Upload file for transcription |
| `/transcribe/url` | POST | Submit URL for transcription |
| `/job/{job_id}` | GET | Poll job status |
| `/transcribe/realtime/start` | POST | Start real-time session |
| `/transcribe/realtime/chunk/{session_id}` | POST | Send audio chunk |
| `/transcribe/realtime/stop/{session_id}` | POST | End session, get result |
| `/auth/token` | GET | Auto-fetch server auth token |

### 4.2 Developer REST API

Authenticated via `x-api-key` header.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api-transcripts` | GET | List transcripts (paginated, searchable) |
| `/api-transcripts/{id}` | GET | Get single transcript |
| `/api-transcripts` | POST | Create transcript |
| `/api-transcripts/{id}` | PUT | Update transcript |
| `/api-transcripts/{id}` | DELETE | Delete transcript |

Query parameters for list: `page`, `page_size` (max 100), `search` (full-text).

---

## 5. Version History

### 2.0.0 (Current)
- OAuth accounts — Google, GitHub, email/password, magic links via Supabase Auth
- Cloud transcript storage — Supabase Postgres with auto-sync
- Transcript library — Full-text search, pagination, shared transcripts tab
- Sharing — Public share links + user-to-user with read/write permissions
- Developer API — REST API via Supabase Edge Functions with API key auth
- Local-only mode preserved — Core functionality unchanged without account
- Rebranded to Voxly

### 1.9.1
- Bug fixes (401 errors, TypeError handling)
- Auth auto-configuration improvements

### 1.4.0
- JSON export with full metadata schema
- Enhanced Markdown with YAML frontmatter
- Metadata enrichment (source, duration, speakers, language, word count)

### 1.3.0
- Safari extension support
- Automatic update notification system

### 1.2.0
- Real-time transcription for tab recording
- Transcript editing, SRT/VTT export
- Markdown/Obsidian export with YAML frontmatter

### 1.1.0
- URL auto-population for streaming sites
- Subprocess worker isolation
- Fixed broken pipe errors

---

## 6. Dependencies

| Package | Purpose | Version |
|---------|---------|---------|
| faster-whisper | Speech recognition (CTranslate2) | Latest |
| pyannote.audio | Speaker diarization | 3.1+ |
| FastAPI | HTTP server | 0.100+ |
| yt-dlp | URL audio extraction | Latest |
| ffmpeg | Audio conversion | System |
| torch | ML backend | 2.0+ |
| supabase-js | Cloud client (extension) | 2.x |

---

## 7. Roadmap

### 2.5.0 - Custom Models
- Fine-tuned Whisper for domain-specific vocabulary
- Custom speaker voice profiles

### 3.0.0 - Desktop App
- Standalone desktop application (Tauri) — see [TDD-v3.0.md](TDD-v3.0.md)
- System-wide keyboard shortcuts
- System/application audio capture (replaces browser tab recording)
- Webhook support for automation
- CLI tool for batch processing

---

*Document maintained by the Voxly team*
