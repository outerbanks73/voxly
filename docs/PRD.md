# Voxly - Product Requirements Document

**Version:** 2.5.0
**Last Updated:** February 2026

---

## 1. Overview

Voxly is a cloud-enabled audio transcription platform that transforms audio and video content into structured, AI-ready formats. It consists of a Chrome extension frontend with built-in cloud transcription, an optional local Python transcription server ("Voxly Desktop") for privacy-focused users, and a Supabase cloud backend for storage, sharing, and API access.

**Key Value Proposition:** Convert spoken content into formats optimized for LLM consumption, RAG pipelines, knowledge bases, and data workflows — no local setup required. Optional cloud sync, sharing, and developer API.

**Design:** See [TDD-v2.5.md](TDD-v2.5.md) for current architecture. See [TDD-v2.0.md](TDD-v2.0.md) for the original local-only design.

---

## 2. Functional Requirements

### 2.1 Input Methods

| Method | Description |
|--------|-------------|
| **File Upload** | User selects local audio/video file (.mp3, .mp4, .m4a, .wav, .webm, .mov, .mkv, .ogg, .flac, .aac, .wma, .opus, .avi, .ts, .3gp) |
| **URL** | User provides URL — supports YouTube, TikTok, Instagram, X/Twitter, Facebook, and any public media URL |
| **Tab Recording** | Captures audio from active browser tab via tabCapture or getDisplayMedia fallback |
| **YouTube Transcript** | Extract existing YouTube captions without transcription (free, via cascade step 1) |

### 2.2 Transcription Engines

| Engine | Description |
|--------|-------------|
| **Cloud (Deepgram Nova-2)** | Default for file uploads. Also used as final fallback for URL transcription. |
| **YouTube Captions** | Free caption extraction for YouTube URLs. First cascade step — zero cost. |
| **Supadata.ai** | Social platform transcription (YouTube fallback, TikTok, Instagram, X, Facebook). |
| **Custom API** | User-configured endpoint (self-hosted Whisper, AssemblyAI, etc.) |
| **Voxly Desktop (Local)** | Local Python server with faster-whisper. Full offline capability. |

**URL Transcription Cascade:** For URL-based transcription, Voxly uses a cost-optimized cascade — cheapest/fastest method first, falling back to progressively more expensive options. YouTube URLs try free caption extraction first, then Supadata, then Deepgram. Social platform URLs try Supadata first, then Deepgram. This minimizes per-transcription cost while maximizing reliability.

### 2.3 Transcription Options

| Option | Values | Default | Availability |
|--------|--------|---------|-------------|
| **Transcription Mode** | Cloud, Custom API, Voxly Desktop | Cloud | All users |
| **Model** | tiny, base, small, medium, large | base | Voxly Desktop only |
| **Speaker Diarization** | Enabled/Disabled | Disabled | Voxly Desktop only |
| **HF Token** | User-provided (required for diarization) | None | Voxly Desktop only |
| **Custom API Endpoint** | User-provided URL | None | Custom API mode only |
| **Custom API Key** | User-provided key | None | Custom API mode only |

### 2.4 Export Formats

| Format | Use Case |
|--------|----------|
| **JSON** | APIs, databases, RAG pipelines |
| **Markdown** | Obsidian, Notion, note-taking |
| **SRT** | Video editing, YouTube subtitles |
| **VTT** | Web video, HTML5 players |
| **TXT** | Universal plain text |

### 2.5 Usage Limits

| Limit | Free | Premium |
|-------|------|---------|
| Cloud transcriptions/month | 15 | Unlimited |
| Max file size (cloud) | 100 MB | 500 MB |
| Max duration (cloud) | 60 min | 240 min |
| YouTube transcript extraction | Unlimited | Unlimited |
| Voxly Desktop transcriptions | Unlimited | Unlimited |

### 2.6 Cloud Features (Premium)

| Feature | Description |
|---------|-------------|
| **Cloud Sync** | Auto-sync transcripts after transcription |
| **Transcript Library** | Full-text search, pagination, browsing all past transcripts |
| **Public Sharing** | Generate share links accessible without the extension |
| **User-to-User Sharing** | Share with specific users (read or write permission) |
| **Developer API** | REST API with API key authentication for CRUD operations |
| **Offline Queue** | Failed syncs queued and retried automatically |

### 2.7 Metadata Enrichment

Every export includes:
- **Source**: URL, filename, or "Tab Recording"
- **Duration**: Total audio length
- **Word Count**: Total words in transcript
- **Speakers**: List of identified speakers (if diarization enabled)
- **Language**: Detected language
- **Model**: Transcription model used (e.g., nova-2, large-v3)
- **Processed At**: ISO timestamp

---

## 3. Non-Functional Requirements

### 3.1 Privacy & Processing
- Cloud transcription sends audio to Deepgram (third-party) for processing
- Voxly Desktop mode: all transcription happens on user's machine (no external transmission)
- Custom API mode: audio sent only to user's own configured endpoint
- Cloud sync is opt-in and requires premium + explicit login
- No analytics or telemetry
- No account required for Voxly Desktop mode; Supabase account required for cloud transcription

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

### 2.5.0 (Current)
- Cloud transcription — Deepgram Nova-2 as default engine, no local setup required
- Cost-optimized URL cascade — YouTube captions (free) → Supadata.ai → Deepgram Nova-2 fallback
- Multi-platform URL support — YouTube, TikTok, Instagram, X/Twitter, Facebook, and any public URL
- Usage quotas — Free tier (15 cloud transcriptions/month), unlimited for premium
- Tab recording with getDisplayMedia fallback — Works on any page including Google Meet
- AI Summary as transcript format option — Generate summaries on-demand alongside timestamps
- Chrome Web Store ready — Core functionality works without any local installation

### 2.0.0
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
| Deepgram Nova-2 | Cloud speech recognition — file uploads + cascade fallback (API) | v1 |
| Supadata.ai | Social platform transcript extraction — YouTube, TikTok, Instagram, X, Facebook (API) | v1 |

---

## 7. Roadmap

### 3.0.0 - Desktop App
- Standalone desktop application (Tauri) — see [TDD-v3.0.md](TDD-v3.0.md)
- System-wide keyboard shortcuts
- System/application audio capture (replaces browser tab recording)
- Webhook support for automation
- CLI tool for batch processing

---

*Document maintained by the Voxly team*
