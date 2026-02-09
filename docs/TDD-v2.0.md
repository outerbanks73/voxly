# Voxly v2.0 — Technical Design Document

**Version:** 2.0.0
**Last Updated:** February 2026
**Status:** Shipped

---

## 1. Product Vision

Voxly transforms audio and video content into structured, AI-ready formats. It prioritizes local processing for privacy, rich metadata for downstream consumption, and format flexibility for diverse workflows.

### 1.1 Design Principles

- **AI-Ready Output** — Structure transcripts for LLM consumption, RAG pipelines, and knowledge management, not just human reading.
- **Rich Metadata** — Every export includes source, timing, speakers, language, model, and processing timestamp. A transcript without context is incomplete.
- **Format Flexibility** — Markdown for note-taking, JSON for APIs, SRT/VTT for video, TXT for universal compatibility. One transcription, many outputs.
- **Local-First, Cloud-Enhanced** — All transcription runs on the user's machine. Cloud sync is opt-in, premium-only, and additive. Core functionality requires no account.

### 1.2 Target Users

| Persona | Use Case |
|---------|----------|
| AI/ML Engineers | RAG systems, training data pipelines, LLM applications |
| Researchers | Interview and lecture transcription → searchable data |
| Content Creators | Podcast/video → show notes, blog posts, repurposed content |
| Knowledge Workers | Building knowledge bases in Obsidian, Notion, etc. |
| Data Teams | Extracting structured data from audio/video archives |
| Developers | Programmatic transcript access via REST API |

### 1.3 Competitive Position

| Dimension | Cloud Services | Voxly |
|-----------|---------------|-------|
| Data Location | Their servers | User's machine |
| Cloud Sync | Required | Optional (premium) |
| Export Formats | Limited | MD, JSON, SRT, VTT, TXT |
| Metadata | Basic | Rich, structured |
| AI Integration | Proprietary | Open formats |
| API Access | Vendor lock-in | Developer-friendly REST API |
| Cost | Per-minute pricing | Free core, premium for cloud |

---

## 2. System Architecture

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
│  │  - faster-whisper transcription               │          │
│  │  - Speaker diarization (pyannote)             │          │
│  └───────────────────────────────────────────────┘          │
└─────────────────────────────────────────────────────────────┘
```

### 2.1 Separation of Concerns

The extension talks directly to Supabase for all cloud operations. The Python server has zero cloud dependencies and handles transcription only. This separation means:

- Server can be swapped for a remote transcription service without touching storage/auth logic
- Cloud features can evolve independently of the transcription engine
- Users who never sign up still get the full local experience

### 2.2 Subprocess Isolation (worker.py)

The transcription worker runs as a separate subprocess via `subprocess.run()`, not as a thread or async task. This solves three problems:

1. **Broken Pipe Prevention** — Whisper and pyannote use tqdm progress bars that write to stdout. In threaded contexts, this causes broken pipe errors when the parent's stdout is closed.
2. **Memory Management** — Each job gets a clean Python process. Model memory is fully released on completion instead of accumulating.
3. **Stability** — PyTorch and CUDA have thread-safety issues. Process isolation avoids these entirely.

The server serializes results to a temp JSON file. The worker writes output there. The server reads it back on completion.

---

## 3. Chrome Extension Architecture

### 3.1 Manifest V3 Design Decisions

Chrome's Manifest V3 makes service workers ephemeral — they can be killed and restarted at any time. This drives several architectural choices:

**State persistence:** All important state lives in `chrome.storage.local`, never in service worker memory. The `activeJob` variable in `background.js` is a convenience cache; the ground truth is always storage.

**Sidepanel resilience:** When the sidepanel reopens, `checkActiveJob()` checks both the background worker's memory and storage for completed results. Results survive service worker restarts.

**Script loading order:** HTML pages load scripts in dependency order:
```
supabase.min.js → config.js → auth.js → supabase.js → cloud-auth.js → cloud-sync.js → ExtPay.js → [page].js
```
Functions are defined at load time but only called at runtime. `isPremiumUser()` (defined in the page-specific JS after ExtPay loads) is available when `canUseCloudFeatures()` executes because it's called later, not at parse time.

### 3.2 Extension File Map

| File | Responsibility |
|------|---------------|
| `background.js` | Service worker: job tracking, polling, ExtPay init, cloud alarm scheduling |
| `sidepanel.js` | Main UI: input selection, job submission, progress display |
| `transcript.js` | Transcript viewer: rendering, editing, export, sharing modal |
| `library.js` | Cloud transcript library: search, pagination, shared tab |
| `config.js` | Shared constants (SERVER_URL, SUPABASE_URL, polling intervals). Version reads from `manifest.json`. |
| `auth.js` | Server auth: token auto-fetch from `/auth/token`, 401 retry with fresh token |
| `supabase.js` | Supabase client singleton with `chromeStorageAdapter` (service workers can't use localStorage) |
| `cloud-auth.js` | OAuth flows (`chrome.identity.launchWebAuthFlow`), session management, auth state broadcasting |
| `cloud-sync.js` | Transcript CRUD, sharing, API key management, offline sync queue |
| `share.js` | Public share viewer (no auth required) |
| `options.js` | Settings page: model selection, HF token, server connection |
| `ExtPay.js` | Premium subscriptions via ExtensionPay |
| `lib/supabase.min.js` | Supabase JS client (UMD bundle) |
| `lib/purify.min.js` | DOMPurify for XSS-safe HTML rendering |

### 3.3 Server Authentication

The local Python server generates a Bearer token at `~/.voxly/auth_token` on startup. The extension auto-fetches this token:

1. Extension calls `GET /auth/token` — server returns the token (only to requests with empty or `chrome-extension://` Origin)
2. Token stored in `chrome.storage.local`
3. All subsequent requests use `Authorization: Bearer {token}` via `authenticatedFetch()`
4. On 401, auto-fetch a fresh token and retry once

**Design note:** Manifest V3 service workers don't send Origin headers on `fetch()`. The server accepts empty Origin (not just `chrome-extension://`) to handle this.

### 3.4 Premium Gating

ExtensionPay manages subscriptions. The free tier allows 15 transcriptions. Premium unlocks unlimited transcriptions and cloud features.

`canUseCloudFeatures()` requires **both** `isPremiumUser()` (ExtPay check) **and** `isCloudAuthenticated()` (Supabase session exists). A premium user who hasn't logged in doesn't get cloud features. A logged-in free user doesn't either.

---

## 4. Cloud Architecture (Supabase)

### 4.1 Authentication

| Method | Flow |
|--------|------|
| **Google/GitHub OAuth** | `chrome.identity.launchWebAuthFlow()` → Supabase OAuth URL → parse hash tokens → `setSession()` |
| **Email/Password** | `supabase.auth.signInWithPassword()` directly |
| **Magic Link** | `supabase.auth.signInWithOtp()` → user clicks email → redirect to options.html → parse hash → set session |

**Session persistence:** Supabase JS client uses a custom `chromeStorageAdapter` wrapping `chrome.storage.local`. The `supabase-js` v2 library supports async storage adapters, so this works seamlessly.

**Session refresh:** A background alarm fires every 55 minutes (tokens expire at 60) to call `refreshCloudSession()`. This keeps sessions alive without user interaction.

**Auth state broadcasting:** On login/logout, `broadcastAuthStateChange()` writes state to `chrome.storage.local` and sends a `chrome.runtime.sendMessage` so all open extension pages update their UI.

### 4.2 Database Schema

Four tables, all with Row Level Security enabled.

**`profiles`**
- Auto-created on signup via Postgres trigger (`handle_new_user`)
- Stores display name, avatar URL, email
- RLS: authenticated users can read all profiles (needed for share lookup), update only their own

**`transcripts`**
- Core table: full_text, segments (JSONB), speakers, metadata columns
- Full-text search index on `title || full_text` using GIN
- Sharing via `is_public` flag + `share_token` (16-char random string)
- RLS: owners have full CRUD; shared recipients can SELECT (and UPDATE if write permission); anon can SELECT public transcripts

**`transcript_shares`**
- Junction table for user-to-user sharing
- `permission` column: `'read'` or `'write'`
- Unique constraint on `(transcript_id, shared_with)` — one share per user per transcript
- RLS: owners manage shares; recipients can read shares targeting them

**`api_keys`**
- SHA-256 hash stored, never the raw key
- `key_prefix` (first 10 chars) stored for display (e.g., "vxly_a1b2c3...")
- Soft revoke via `revoked_at` timestamp (never hard-delete)
- RLS: users manage their own keys only

**`storage.audio-files`**
- Supabase Storage bucket, private
- Path convention: `{user_id}/{transcript_id}.mp3`
- 100MB file size limit
- RLS: users access their own folder only

### 4.3 Cloud Sync

Sync happens automatically after transcription completes for premium users:

1. `trySyncOrQueue()` attempts `syncTranscriptToCloud()`
2. On success: transcript ID stored locally for linking
3. On failure: added to `chrome.storage.local.pendingSyncQueue`
4. Background alarm retries pending syncs every 5 minutes (max 10 retries per item, then dropped)

The offline queue ensures transcripts created without connectivity eventually reach the cloud.

### 4.4 Developer API

A Supabase Edge Function (`api-transcripts/index.ts`) provides REST access:

- Authenticated via `x-api-key` header
- Key is SHA-256 hashed and matched against `api_keys` table
- Service role client bypasses RLS; function manually filters by `user_id`
- CRUD on transcripts: GET (list/single), POST, PUT, DELETE
- List endpoint supports pagination (`page`, `page_size` max 100) and full-text search

### 4.5 Sharing

**Public sharing:** Toggle `is_public` on a transcript, generate a random `share_token`. The share URL loads `share.html` which fetches the transcript via anon Supabase client (RLS allows anon SELECT on public transcripts).

**User-to-user sharing:** Look up target user by email in `profiles`, insert into `transcript_shares` with read or write permission. Recipients see shared transcripts in their library's "Shared with me" tab.

---

## 5. Python Server Design

### 5.1 Server (server.py)

FastAPI application on `localhost:5123`. Key design points:

- **Job queue:** In-memory dict of job objects. Each job has a UUID, status, progress, and result. Jobs are created on submission and polled by the extension.
- **URL downloading:** `yt-dlp` fetches audio from URLs (YouTube, podcasts, etc.). Downloads are cached by URL hash in a temp directory.
- **YouTube transcript extraction:** Direct caption extraction via `youtube_transcript_api` — no Whisper needed. Falls back to Whisper if captions unavailable.
- **Real-time transcription:** WebSocket-like chunked endpoint for tab recording. Chunks are accumulated and transcribed on stop.
- **CORS:** Wildcard origin (extension IDs are unstable in dev). Security is handled by Bearer token auth.

### 5.2 Worker (worker.py)

Isolated subprocess for transcription. Receives input via command-line args, writes output to a temp JSON file.

- **faster-whisper** for transcription (4x faster than original openai-whisper, lower memory)
- **pyannote.audio** for speaker diarization (requires HuggingFace token)
- Generous timeouts: 1 hour for FFmpeg conversion, no timeout on Whisper inference

### 5.3 Server Process Management

Dedicated shell scripts handle the server lifecycle:

- `start-server.sh`: Activate venv, check prerequisites, kill existing process, start, verify
- `stop-server.sh`: Kill process, verify dead
- Both scripts log to files for debugging
- `install.sh` and `update.sh` delegate to these scripts — no duplicated process management

**Path handling:** Always use `sys.executable` for the Python interpreter, never hardcoded venv paths. Venv activation is handled by startup scripts.

---

## 6. Data Flow

### 6.1 File Upload

```
User selects file → Extension POST /transcribe/file (multipart)
→ Server saves to temp dir → Spawns worker.py subprocess
→ Worker: FFmpeg convert → faster-whisper transcribe → (optional) pyannote diarize
→ Worker writes result JSON → Server reads result → Job status: completed
→ Extension polls /job/{id} → Gets result → Renders transcript
→ (Premium) cloud-sync.js upserts to Supabase
```

### 6.2 URL Transcription

```
User enters URL → Extension POST /transcribe/url { url, model }
→ Server: yt-dlp downloads audio (cached by URL hash)
→ Same worker.py pipeline as file upload
→ Extension polls → result → render → (optional) cloud sync
```

### 6.3 YouTube Transcript Extraction

```
User enters YouTube URL → Extension POST /transcribe/url { url }
→ Server: Detect YouTube, try youtube_transcript_api first
→ If captions exist: extract directly (no Whisper, instant)
→ If not: fall back to yt-dlp download → Whisper pipeline
→ Extension polls → result → render → (optional) cloud sync
```

### 6.4 Tab Recording

```
User clicks Record → chrome.tabCapture.capture({ audio: true })
→ MediaRecorder encodes WebM chunks → POST chunks every 5s
→ User clicks Stop → Final chunk sent → Server assembles audio
→ Worker transcribes assembled audio → Same completion flow
```

---

## 7. Security Model

| Layer | Mechanism |
|-------|-----------|
| Server access | Bearer token auth (auto-configured, stored in `~/.voxly/auth_token`) |
| Cloud data | Supabase RLS on all tables, scoped to `auth.uid()` |
| API keys | SHA-256 hashed, never stored raw, soft-revoke |
| XSS prevention | DOMPurify for all user content rendered as HTML; `escapeHtmlForShare()` for share modal |
| OAuth | `chrome.identity.launchWebAuthFlow()` (browser-managed, no raw tokens in extension storage) |
| Public shares | Read-only via anon key, scoped to `is_public = true` transcripts |

---

## 8. Export Formats

| Format | Schema | Use Case |
|--------|--------|----------|
| **JSON** | `{ metadata: {...}, segments: [...], full_text: "..." }` | APIs, databases, RAG pipelines |
| **Markdown** | YAML frontmatter + formatted text with timestamps | Obsidian, Notion, note-taking |
| **SRT** | Industry-standard subtitle format with sequence numbers | Video editing, YouTube |
| **VTT** | WebVTT with optional speaker tags | HTML5 video, web players |
| **TXT** | Plain text, no formatting | Universal clipboard, simple copy |

All exports include metadata: source, duration, word count, speakers, language, model, processed timestamp.

---

## 9. Dependencies

| Package | Purpose | Version |
|---------|---------|---------|
| faster-whisper | Speech recognition (CTranslate2 backend) | Latest |
| pyannote.audio | Speaker diarization | 3.1+ |
| FastAPI | HTTP server | 0.100+ |
| yt-dlp | URL audio extraction | Latest |
| ffmpeg | Audio conversion | System |
| torch | ML backend | 2.0+ |
| supabase-js | Cloud client (extension) | 2.x |
| ExtensionPay | Premium subscriptions | 3.x |
| DOMPurify | XSS-safe HTML rendering | Latest |

---

*Document maintained by the Voxly team*
