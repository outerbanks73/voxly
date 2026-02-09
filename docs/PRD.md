# Voxly - Product Requirements Document

**Version:** 2.0.0
**Last Updated:** February 2026

---

## 1. Overview

Voxly is a cloud-enabled audio transcription platform that transforms audio and video content into structured, AI-ready formats. It consists of a Chrome extension frontend, a local Python server backend using OpenAI Whisper, and a Supabase cloud backend for storage, sharing, and API access.

**Key Value Proposition:** Convert spoken content into formats optimized for LLM consumption, RAG pipelines, knowledge bases, and data workflows — with optional cloud sync, sharing, and developer API.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Chrome Extension (Manifest V3)             │
│  ┌──────────┐  ┌──────────┐  ┌────────────────────┐        │
│  │   URL    │  │   File   │  │  Record this Tab   │        │
│  └────┬─────┘  └────┬─────┘  └─────────┬──────────┘        │
│       └─────────────┴───────────────────┘                   │
│                        │                                     │
│              HTTP POST to localhost:5123                     │
│                        │                                     │
│  ┌─────────────────────┼─────────────────────────────┐      │
│  │    Cloud Layer (Premium)                           │      │
│  │  Supabase Auth → Storage → Sync → Share → API     │      │
│  └────────────────────────────────────────────────────┘      │
└────────────────────────┼────────────────────────────────────┘
                         │
┌────────────────────────┼────────────────────────────────────┐
│                   Python Server (Local)                       │
│  ┌─────────────────────▼─────────────────────────┐          │
│  │              server.py (FastAPI)              │          │
│  │  - Job queue management                       │          │
│  │  - URL downloading (yt-dlp)                   │          │
│  │  - Audio caching                              │          │
│  └─────────────────────┬─────────────────────────┘          │
│              subprocess.run()                                │
│  ┌─────────────────────▼─────────────────────────┐          │
│  │              worker.py (Isolated)             │          │
│  │  - Whisper transcription                      │          │
│  │  - Speaker diarization (pyannote)             │          │
│  └───────────────────────────────────────────────┘          │
└─────────────────────────────────────────────────────────────┘
```

### 2.1 Cloud Architecture

The extension talks directly to Supabase — the Python server has no cloud dependencies and remains transcription-only. This separation enables future remote model swaps without untangling storage logic.

- **Auth:** Supabase Auth with OAuth (Google, GitHub), email/password, magic links
- **Storage:** Supabase Postgres with Row Level Security on all tables
- **Sync:** Automatic after transcription for premium users, with offline retry queue
- **API:** Supabase Edge Functions authenticated via developer API keys

### 2.2 Why Subprocess Isolation?

The transcription worker runs as a separate subprocess to solve:
1. **Broken Pipe Prevention**: Whisper/pyannote tqdm output causes crashes in threaded contexts
2. **Memory Management**: Clean memory release after each job
3. **Stability**: PyTorch/CUDA thread conflicts avoided via isolation

---

## 3. Functional Requirements

### 3.1 Input Methods

| Method | Description | Implementation |
|--------|-------------|----------------|
| **File Upload** | User selects local audio/video file | Direct upload via FormData |
| **URL** | User provides URL to audio/video | Server downloads via yt-dlp, caches locally |
| **Tab Recording** | Captures audio from active browser tab | Chrome tabCapture API, WebM encoding |
| **YouTube Transcript** | Extract existing YouTube captions | Direct extraction, no Whisper needed |

### 3.2 Transcription Options

| Option | Values | Default |
|--------|--------|---------|
| **Model** | tiny, base, small, medium, large | base |
| **Speaker Diarization** | Enabled/Disabled | Disabled |
| **HF Token** | User-provided | None |

### 3.3 Export Formats

| Format | Use Case | Features |
|--------|----------|----------|
| **JSON** | APIs, databases, RAG pipelines | Full metadata, structured schema |
| **Markdown** | Obsidian, Notion, note-taking | YAML frontmatter, formatted text |
| **SRT** | Video editing, YouTube | Industry-standard subtitles |
| **VTT** | Web video, HTML5 | WebVTT with speaker tags |
| **TXT** | Universal | Plain text, simple copy |

### 3.4 Cloud Features (Premium)

| Feature | Description |
|---------|-------------|
| **Cloud Sync** | Auto-sync transcripts to Supabase after transcription |
| **Transcript Library** | Full-text search, pagination, browsing all past transcripts |
| **Public Sharing** | Generate share links accessible without the extension |
| **User-to-User Sharing** | Share with specific users (read or write permission) |
| **Developer API** | REST API with API key authentication for CRUD operations |
| **Offline Queue** | Failed syncs queued and retried automatically |

### 3.5 Metadata Enrichment

Every export includes:
- **Source**: URL, filename, or "Tab Recording"
- **Duration**: Total audio length
- **Word Count**: Total words in transcript
- **Speakers**: List of identified speakers (if diarization enabled)
- **Language**: Detected language
- **Model**: Whisper model used
- **Processed At**: ISO timestamp

---

## 4. Non-Functional Requirements

### 4.1 Privacy & Local Processing
- All transcription happens on user's machine
- No data transmission to external servers (except yt-dlp fetches)
- Cloud sync is opt-in and requires premium + explicit login
- No analytics or telemetry
- No account required for core functionality

### 4.2 Performance
- Tiny model: ~10x realtime on CPU
- Base model: ~5x realtime on CPU
- Large model: ~1x realtime on CPU (faster with GPU)

### 4.3 Compatibility
- Python 3.9+
- Chrome/Chromium browsers
- macOS, Linux, Windows

---

## 5. Cloud API

### 5.1 Local Server Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Server status check |
| `/transcribe/file` | POST | Upload file for transcription |
| `/transcribe/url` | POST | Submit URL for transcription |
| `/job/{job_id}` | GET | Poll job status |
| `/transcribe/realtime/start` | POST | Start real-time session |
| `/transcribe/realtime/chunk/{session_id}` | POST | Send audio chunk |
| `/transcribe/realtime/stop/{session_id}` | POST | End session, get result |

### 5.2 Developer REST API (Supabase Edge Function)

Authenticated via `x-api-key` header. Keys are SHA-256 hashed and stored in the `api_keys` table.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api-transcripts` | GET | List transcripts (paginated, searchable) |
| `/api-transcripts/{id}` | GET | Get single transcript |
| `/api-transcripts` | POST | Create transcript |
| `/api-transcripts/{id}` | PUT | Update transcript |
| `/api-transcripts/{id}` | DELETE | Delete transcript |

Query parameters for list: `page`, `page_size` (max 100), `search` (full-text).

---

## 6. Database Schema

### Tables
- **`profiles`** — Auto-created on signup via trigger. Stores display name, avatar, email.
- **`transcripts`** — User transcripts with full-text search index. Supports public sharing via `share_token`.
- **`transcript_shares`** — User-to-user sharing with read/write permissions. Unique constraint on (transcript_id, shared_with).
- **`api_keys`** — Developer API keys. SHA-256 hashed, prefix stored for display. Soft-revoke via `revoked_at`.

### Row Level Security
RLS is enabled on all tables. All policies filter by `user_id` or `auth.uid()`. The anon key can only read public shares.

---

## 7. Auth Flow

1. OAuth: `chrome.identity.launchWebAuthFlow()` → Supabase OAuth URL → parse hash tokens → `setSession()`
2. Email/password: `supabase.auth.signInWithPassword()` directly
3. Magic link: `supabase.auth.signInWithOtp()` → user clicks email → redirect to options.html → parse hash → set session
4. Session stored via custom `chromeStorageAdapter` in `chrome.storage.local`
5. Background alarm refreshes session every 55 min (tokens expire at 60)
6. `canUseCloudFeatures()` requires both `isPremiumUser()` AND `isCloudAuthenticated()`

---

## 8. Version History

### 2.0.0 (Current)
- **OAuth accounts** — Google, GitHub, email/password, magic links via Supabase Auth
- **Cloud transcript storage** — Supabase Postgres with auto-sync
- **Transcript library** — Full-text search, pagination, shared transcripts tab
- **Sharing** — Public share links + user-to-user with read/write permissions
- **Developer API** — REST API via Supabase Edge Functions with API key auth
- **Local-only mode preserved** — Core functionality unchanged without account
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
- Subprocess worker isolation (`worker.py`)
- Fixed broken pipe errors

---

## 9. Dependencies

| Package | Purpose | Version |
|---------|---------|---------|
| openai-whisper | Speech recognition | Latest |
| pyannote.audio | Speaker diarization | 3.1+ |
| FastAPI | HTTP server | 0.100+ |
| yt-dlp | URL audio extraction | Latest |
| ffmpeg | Audio conversion | System |
| torch | ML backend | 2.0+ |
| supabase-js | Cloud client (extension) | 2.x |

---

## 10. Roadmap

### 2.5.0 - Integrations & Custom Models
- Direct export to Notion, Obsidian, Google Docs
- Fine-tuned Whisper for domain-specific vocabulary
- Custom speaker voice profiles

### 3.0.0 - Desktop App
- Standalone desktop application (Tauri)
- System-wide keyboard shortcuts
- Webhook support for automation
- CLI tool for batch processing

---

*Document maintained by the Voxly team*
