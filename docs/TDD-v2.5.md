# Voxly v2.5 — Technical Design Document

**Version:** 2.5.0
**Last Updated:** February 2026
**Status:** Design Phase

---

## 1. Goals & Non-Goals

### Goals

- **Cloud-first transcription** — Default to Deepgram Nova-2 so users don't need Python/faster-whisper installed. Enables Chrome Web Store distribution to non-technical users.
- **Preserve local transcription** — Keep the existing Python server path as "Voxly Desktop" for power users who want privacy or offline capability.
- **LLM-agnostic custom API** — Let users point transcription at their own endpoint (self-hosted Whisper, AssemblyAI, etc.).
- **YouTube transcripts without a local server** — Move caption extraction to an Edge Function (CORS blocks browser-side calls).
- **Usage quotas** — Protect Deepgram costs with per-user limits enforced server-side.

### Non-Goals

- Replacing the local Python server (it becomes "Voxly Desktop", not deprecated)
- Real-time streaming transcription via cloud (latency too high; remains Voxly Desktop only)
- Building a custom transcription model or fine-tuning pipeline
- Changing the cloud sync, sharing, or API key systems (those stay as-is from v2.0)

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                  Chrome Extension (Manifest V3)                  │
│                                                                  │
│  ┌──────────────────────────────────────────────────┐           │
│  │          TranscriptionService (NEW)               │           │
│  │  ┌──────────┐ ┌──────────┐ ┌────────────────┐   │           │
│  │  │  Cloud   │ │ Custom   │ │  Local Server  │   │           │
│  │  │ Adapter  │ │ Adapter  │ │    Adapter     │   │           │
│  │  └────┬─────┘ └────┬─────┘ └───────┬────────┘   │           │
│  └───────┼─────────────┼───────────────┼────────────┘           │
│          │             │               │                         │
│          ▼             ▼               ▼                         │
│   Supabase Edge    User's API    localhost:5123                  │
│   Functions        endpoint      (Python server)                │
│                                                                  │
│  ┌──────────────────────────────────────────────────────┐       │
│  │    Cloud Layer (unchanged from v2.0)                  │       │
│  │  Supabase Auth → Storage → Sync → Share → API        │       │
│  └──────────────────────────────────────────────────────┘       │
└──────────────────────────────────────────────────────────────────┘
          │
          ▼
┌──────────────────────────────────────────────────────────────────┐
│                 Supabase Edge Functions                           │
│  ┌────────────────┐ ┌──────────────────────────────────────┐    │
│  │   transcribe   │ │         transcribe-url                │    │
│  │  (JWT + quota) │ │  (JWT + quota, cascade logic)         │    │
│  └───────┬────────┘ └───────┬──────────────────────────────┘    │
│          │                  │                                    │
│          ▼                  ▼ (cascade — cheapest first)         │
│      Deepgram         1. YouTube captions (free)                 │
│      Nova-2           2. Supadata.ai (social platforms)          │
│                       3. Deepgram Nova-2 (fallback)              │
│                                                                  │
│  ┌──────────────────┐                                            │
│  │  realtime-token  │ → Temp Deepgram key for WebSocket         │
│  └──────────────────┘                                            │
└──────────────────────────────────────────────────────────────────┘
```

### 2.1 Key Architectural Change

v2.0 routes all transcription through `localhost:5123`. v2.5 adds two alternative paths (cloud and custom API) while keeping the local path intact. The new `TranscriptionService` abstraction in the extension selects the adapter based on `chrome.storage.local.transcriptionMode`.

### 2.2 Why Proxy Through Edge Functions

The extension never holds the Deepgram API key. Reasons:

1. **Key security** — Chrome extensions can be inspected by users. An embedded key would be trivially extractable.
2. **Quota enforcement** — The Edge Function checks the user's monthly usage before forwarding to Deepgram. Client-side enforcement is bypassable.
3. **Cost control** — Server-side file size and duration limits prevent abuse.
4. **Latency** — Edge Function overhead is ~50-100ms, negligible against 10-30s transcription time.

---

## 3. Transcription Modes

### 3.1 Mode Selection

Stored in `chrome.storage.local` as `transcriptionMode`:

| Mode | Value | Default For |
|------|-------|-------------|
| **Voxly Cloud** | `'cloud'` | New installs, existing users without local server running |
| **Custom API** | `'custom'` | Users who configure their own endpoint |
| **Voxly Desktop** | `'local'` | Existing users with local server detected on upgrade |

**No auto-fallback.** If a cloud transcription fails, the extension shows an error with a suggestion to try Voxly Desktop — it does not silently switch modes. Auto-fallback creates confusing UX where users don't know which engine processed their audio.

### 3.2 Upgrade Migration

On extension update to v2.5:

1. Check if `transcriptionMode` is already set → do nothing
2. Call `checkServerConnection()` (existing function in `config.js`)
3. If server is reachable → set mode to `'local'`, show one-time banner: "Voxly Desktop detected. You can switch to cloud transcription in Settings."
4. If server is unreachable → set mode to `'cloud'`

This runs once in `background.js` on `chrome.runtime.onInstalled` with `reason === 'update'`.

---

## 4. TranscriptionService (Adapter Pattern)

### 4.1 File: `extension/transcription-service.js`

New file in the extension. Loaded after `config.js` and `auth.js` in the HTML script chain.

```
supabase.min.js → config.js → auth.js → transcription-service.js → supabase.js → ...
```

### 4.2 Normalized Response

All three adapters return the same shape:

```json
{
  "full_text": "string",
  "segments": [
    {
      "start": 0.0,
      "end": 2.5,
      "text": "Hello world",
      "speaker": "SPEAKER_00"
    }
  ],
  "metadata": {
    "source": "file|url|recording",
    "duration": 125.4,
    "language": "en",
    "model": "nova-2|custom|large-v3",
    "word_count": 1250,
    "speakers": ["SPEAKER_00", "SPEAKER_01"]
  }
}
```

The `speaker` field in segments is optional (only present when diarization is available).

### 4.3 CloudAdapter

Handles Voxly's managed cloud transcription via Supabase Edge Functions.

**File upload flow:**
1. Read file as `ArrayBuffer`
2. POST to Edge Function `transcribe` with Supabase JWT in `Authorization` header
3. Edge Function validates JWT, checks quota, forwards audio to Deepgram
4. Deepgram returns result synchronously → Edge Function normalizes → returns to extension
5. Extension receives complete result in a single HTTP response (no polling)

**URL transcription flow:**
1. POST URL to Edge Function `transcribe-url` with Supabase JWT
2. Edge Function downloads audio, sends to Deepgram
3. For YouTube URLs: tries caption extraction first (free), falls back to Deepgram
4. Returns normalized result

**Progress:** Cloud transcriptions are synchronous from the extension's perspective (single HTTP request/response). The sidepanel shows an indeterminate progress bar during the request.

### 4.4 CustomApiAdapter

For users who bring their own transcription API.

**Configuration (stored in `chrome.storage.local`):**

```json
{
  "customApiEndpoint": "https://my-whisper.example.com/transcribe",
  "customApiKey": "sk-...",
  "customApiHeaders": { "X-Custom-Header": "value" }
}
```

**Request:** POST multipart/form-data with the audio file to the configured endpoint. Includes `Authorization: Bearer {customApiKey}` if a key is set, plus any custom headers.

**Response mapping:** The adapter attempts to parse common response formats:
- Deepgram-style (`results.channels[0].alternatives[0]`)
- OpenAI Whisper API-style (`{ text, segments }`)
- Voxly-native format (`{ full_text, segments }`)

If the response doesn't match any known format, it treats the entire body as plain text in `full_text` with no segments.

### 4.5 LocalServerAdapter

Wraps the existing `localhost:5123` transcription path. Identical behavior to v2.0 — the adapter is a thin wrapper around the existing `authenticatedFetch()` calls and job polling logic.

**Key difference from cloud/custom:** Local transcription is asynchronous. The adapter submits the job, then polls `/job/{id}` until completion. This is the only adapter that uses polling.

---

## 5. Supabase Edge Functions

### 5.1 `transcribe` (NEW)

**Purpose:** Proxy file uploads to Deepgram Nova-2 with JWT auth and quota enforcement.

| Property | Value |
|----------|-------|
| Auth | Supabase JWT required |
| Method | POST (multipart/form-data) |
| Max file size | 100MB (free), 500MB (premium) |
| Max duration | 60 min (free), 240 min (premium) |
| Rate limit | Quota-based (see section 7) |

**Request:**

```
POST /transcribe
Authorization: Bearer {supabase_jwt}
Content-Type: multipart/form-data

file: (binary audio data)
```

**Processing:**

1. Validate JWT, extract `user_id`
2. Check `profiles` table for premium status
3. Check monthly usage count against tier limit
4. Validate file size against tier limit
5. Forward audio to Deepgram Nova-2 pre-recorded API
6. Normalize Deepgram response to Voxly format
7. Increment usage counter
8. Return normalized result

**Response (200):**

```json
{
  "full_text": "...",
  "segments": [...],
  "metadata": {
    "source": "file",
    "duration": 125.4,
    "language": "en",
    "model": "nova-2",
    "word_count": 1250,
    "speakers": [...]
  }
}
```

**Error responses:**

| Status | Body | When |
|--------|------|------|
| 401 | `{ "error": "unauthorized" }` | Invalid/missing JWT |
| 413 | `{ "error": "file_too_large", "limit_mb": 100 }` | File exceeds tier limit |
| 429 | `{ "error": "quota_exceeded", "limit": 15, "used": 15, "resets_at": "..." }` | Monthly quota exhausted |
| 500 | `{ "error": "transcription_failed", "detail": "..." }` | Deepgram API error |

### 5.2 `transcribe-url` (NEW)

**Purpose:** Transcribe content from any public URL using a cost-optimized cascade strategy. Tries the cheapest/fastest method first, falling back to progressively more expensive options.

| Property | Value |
|----------|-------|
| Auth | Supabase JWT required |
| Method | POST (JSON) |
| Max duration | Same as `transcribe` tier limits |

**Request:**

```json
{
  "url": "https://youtube.com/watch?v=...",
  "language": "en"
}
```

**Transcription Cascade:**

The Edge Function applies different cascade strategies based on the URL platform:

**YouTube URLs** (`youtube.com/watch`, `youtu.be/`, `youtube.com/shorts/`, `youtube.com/live/`):

1. **YouTube Captions** (free, ~1s) — Extract existing captions via `youtube_transcript_api`. Most YouTube videos have auto-generated or manual captions. Zero API cost.
2. **Supadata.ai** (~5-15s) — If no captions available, Supadata downloads and transcribes. Handles most edge cases.
3. **Deepgram Nova-2** (fallback) — If Supadata fails, download audio server-side and send to Deepgram pre-recorded API.

**Social Platform URLs** (TikTok, Instagram, X/Twitter, Facebook):

1. **Supadata.ai** — Primary method. Supadata handles platform-specific extraction.
2. **Deepgram Nova-2** (fallback) — If Supadata fails, attempt direct audio download + Deepgram transcription.

**Other URLs** (podcasts, direct media links, etc.):

1. **Supadata.ai** — Try Supadata first (handles many podcast hosts, media platforms).
2. **Deepgram Nova-2** (fallback) — Download audio directly and transcribe via Deepgram.

**Processing:**

1. Validate JWT, check quota (same as `transcribe`)
2. Detect platform from URL
3. Execute cascade: try each method in order, move to next on failure
4. Normalize result from whichever method succeeds
5. Increment usage (only counted once regardless of cascade steps)
6. Return result with `metadata.method` indicating which cascade step succeeded

**Response:** Same format as `transcribe`, with additional metadata:

```json
{
  "metadata": {
    "method": "youtube_captions|supadata|deepgram",
    "cascade_steps": ["youtube_captions:failed", "supadata:success"]
  }
}
```

**Response:** Same format as `transcribe`.

### 5.3 YouTube Caption Extraction (Internal to `transcribe-url`)

**Purpose:** Extract YouTube captions as the first step in the URL transcription cascade. Zero API cost. Not a standalone endpoint — this logic lives inside `transcribe-url`.

**Implementation:** Uses `youtube_transcript_api` (Python library, ported to Deno/TypeScript or called via a helper). Extracts auto-generated or manual captions from YouTube videos.

**Processing:**

1. Extract video ID from URL
2. Fetch available caption tracks (auto-generated + manual)
3. Prefer manual captions; fall back to auto-generated
4. Parse captions into segments with timestamps
5. If no captions available, return failure signal to trigger next cascade step

**Normalized output (when successful):**

```json
{
  "full_text": "...",
  "segments": [
    { "start": 0.0, "end": 3.2, "text": "..." }
  ],
  "metadata": {
    "method": "youtube_captions",
    "language": "en",
    "model": "youtube_captions"
  }
}
```

**Failure modes that trigger cascade fallback:**
- Video has no captions in any language
- Video is age-restricted or private
- YouTube API rate limiting
- Network/parsing errors

### 5.4 Edge Function Environment Variables

| Variable | Function(s) | Description |
|----------|-------------|-------------|
| `DEEPGRAM_API_KEY` | `transcribe`, `transcribe-url`, `realtime-token` | Voxly's Deepgram Nova-2 key |
| `DEEPGRAM_PROJECT_ID` | `realtime-token` | Deepgram project for scoped temporary keys |
| `SUPADATA_API_KEY` | `transcribe-url` | Supadata.ai API key for social platform transcription |

Standard Supabase env vars (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`) are available automatically.

---

## 6. Extension File Changes

### 6.1 New Files

| File | Responsibility |
|------|---------------|
| `extension/transcription-service.js` | TranscriptionService class with CloudAdapter, CustomApiAdapter, LocalServerAdapter. Mode selection, response normalization, error handling. |

### 6.2 Modified Files

| File | Changes |
|------|---------|
| `extension/config.js` | Add `LOCAL_SERVER_URL` (alias for `SERVER_URL`), `TRANSCRIPTION_MODES` enum, `CLOUD_EDGE_FUNCTION_BASE` URL, tier limit constants (`FREE_MONTHLY_LIMIT`, `FREE_MAX_FILE_MB`, `PREMIUM_MAX_FILE_MB`, `FREE_MAX_DURATION_MIN`, `PREMIUM_MAX_DURATION_MIN`) |
| `extension/sidepanel.js` | Use `TranscriptionService` instead of direct `authenticatedFetch()` calls for transcription. Mode-aware status bar. Indeterminate progress bar for cloud. Hide model selector in cloud mode. Hide real-time recording when not in local mode. Add footer section (Voxly Desktop CTA + privacy tips). |
| `extension/sidepanel.html` | Add footer HTML: Voxly Desktop download card, privacy tips container. Add conditional sections for mode-specific UI (model selector, recording options). |
| `extension/background.js` | Mode migration logic on `onInstalled` (update). Mode-aware job tracking: only poll for local mode, cloud/custom resolve immediately. |
| `extension/options.html` | New "Transcription Settings" section: mode radio buttons (Cloud / Custom API / Voxly Desktop), custom API config fields (endpoint, key, headers). |
| `extension/options.js` | Save/load transcription mode and custom API settings. Connection test button for custom API. Server connection status for local mode. |
| `extension/manifest.json` | Version bump to `2.5.0`. Add Supabase Edge Function URLs to `host_permissions`. |

### 6.3 Script Loading Order (Updated)

```
supabase.min.js → config.js → auth.js → transcription-service.js → supabase.js → cloud-auth.js → cloud-sync.js → ExtPay.js → [page].js
```

`transcription-service.js` loads after `auth.js` (needs `authenticatedFetch()` for local adapter) and after `config.js` (needs constants). It loads before `supabase.js` because it doesn't depend on the Supabase client — cloud adapter calls Edge Functions via standard `fetch()` with the JWT from `cloud-auth.js` at runtime.

---

## 7. Usage Quotas & Cost Control

### 7.1 Tier Limits

| Limit | Free | Premium |
|-------|------|---------|
| Transcriptions/month | 15 | Unlimited |
| Max file size | 100 MB | 500 MB |
| Max duration | 60 min | 240 min |
| YouTube transcripts | Unlimited | Unlimited |

YouTube transcript extraction is free (no Deepgram cost), so it's unlimited for all tiers.

### 7.2 Quota Tracking

A new `usage` table in Supabase tracks cloud transcription usage:

```sql
CREATE TABLE usage (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) NOT NULL,
  month TEXT NOT NULL,  -- '2026-02' format
  transcription_count INTEGER DEFAULT 0,
  total_duration_seconds NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, month)
);

ALTER TABLE usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own usage" ON usage
  FOR SELECT USING (auth.uid() = user_id);
```

Edge Functions use the service role key to read/write this table (users can only read their own usage via RLS).

### 7.3 Cost Analysis

| Item | Rate |
|------|------|
| YouTube captions (youtube_transcript_api) | Free |
| Supadata.ai | Per-request pricing (see Supadata plan) |
| Deepgram Nova-2 | $0.0043/min |
| Average file transcription | ~10 min → $0.043 |
| Average URL transcription (YouTube w/ captions) | $0.00 (free cascade step) |
| Free tier cost (worst case, 15 × 10min Deepgram) | $0.645/user/month |
| Supabase Edge Function | Free tier covers initial scale |

**Cascade cost optimization:** Most YouTube videos have auto-generated captions, so the majority of YouTube URL transcriptions cost nothing. The cascade ensures Deepgram (most expensive) is only used as a last resort.

### 7.4 Abuse Prevention

- File size validated before upload reaches Deepgram
- Duration limits prevent single massive transcriptions
- Monthly quotas prevent sustained abuse
- JWT auth prevents anonymous access to `transcribe` and `transcribe-url`
- `youtube-transcript` rate limited by IP (30 req/min) since it requires no auth

---

## 8. Sidepanel UI Changes

### 8.1 Status Bar

The existing connection status indicator becomes mode-aware:

| Mode | Status Text | Indicator |
|------|-------------|-----------|
| Cloud | "Voxly Cloud" | Green dot |
| Custom | "Custom API" | Blue dot |
| Local (connected) | "Voxly Desktop" | Green dot |
| Local (disconnected) | "Voxly Desktop — offline" | Red dot |

### 8.2 Mode-Specific UI

**Model selector:**
- Cloud mode: Hidden (Deepgram Nova-2 is fixed)
- Custom mode: Hidden (model is determined by the user's endpoint)
- Local mode: Whisper model dropdown (tiny/base/small/medium/large) — same as v2.0

**Real-time recording:**
- Cloud/Custom mode: Hidden (not supported)
- Local mode: Visible — same as v2.0

**Progress display:**
- Cloud/Custom: Indeterminate progress bar (single HTTP request, no percentage available)
- Local: Determinate progress bar with percentage (job polling, same as v2.0)

### 8.3 Footer Section

Below the existing result/settings links, a new footer section:

**Voxly Desktop CTA:**
- Small card with icon + "Voxly Desktop" heading
- Subtitle: "Local transcription, real-time recording, offline mode"
- Link to download page (GitHub Releases)
- Dismissible (stores `ctaDismissed: true` in `chrome.storage.local`)
- Not shown when user is already in local mode

**Privacy tips:**
- Rotating text, one tip visible at a time
- 6 tips, cycle every 30 seconds or on panel open
- Tips focus on Voxly's privacy model (local processing, no analytics, optional cloud, etc.)

---

## 9. Database Changes

### 9.1 New Table: `usage`

Tracks per-user monthly cloud transcription usage. Schema in section 7.2.

### 9.2 New Column: `profiles.is_premium`

```sql
ALTER TABLE profiles ADD COLUMN is_premium BOOLEAN DEFAULT false;
```

Edge Functions check this to determine tier limits. Updated by a webhook from ExtensionPay on subscription changes, or checked at runtime via ExtPay's API.

**Note:** This is a cache for Edge Function use. The extension still checks premium status via ExtPay directly (source of truth). The Edge Function can't call ExtPay, so it reads this column.

### 9.3 Unchanged Tables

`transcripts`, `transcript_shares`, `api_keys`, `storage.audio-files` — no changes. The cloud transcription result flows through the same `cloud-sync.js` path as local results.

---

## 10. Data Flows

### 10.1 Cloud File Upload

```
User selects file → TranscriptionService (cloud adapter)
→ POST file to Edge Function /transcribe (JWT auth)
→ Edge Function: validate JWT, check quota, validate file size
→ Forward audio to Deepgram Nova-2 API
→ Deepgram returns transcript → Edge Function normalizes
→ Return to extension → Render transcript
→ (Premium) cloud-sync.js upserts to Supabase (same as v2.0)
```

### 10.2 Cloud URL Transcription (Cascade)

```
User enters URL → TranscriptionService (cloud adapter)
→ POST URL to Edge Function /transcribe-url (JWT auth)
→ Edge Function: validate JWT, check quota, detect platform

YouTube URLs:
  Step 1: youtube_transcript_api → extract captions (free, ~1s)
  Step 2: If no captions → Supadata.ai → transcribe (~5-15s)
  Step 3: If Supadata fails → Deepgram Nova-2 (download + transcribe)

Social URLs (TikTok, Instagram, X, Facebook):
  Step 1: Supadata.ai → platform extraction (~5-15s)
  Step 2: If fails → Deepgram Nova-2 (download + transcribe)

Other URLs:
  Step 1: Supadata.ai → try extraction (~5-15s)
  Step 2: If fails → Deepgram Nova-2 (download + transcribe)

→ First successful step returns → normalize result
→ Increment usage (once) → Return to extension
→ Render → (optional) cloud sync
```

### 10.4 Custom API

```
User selects file → TranscriptionService (custom adapter)
→ POST file to user's configured endpoint
→ Adapter parses response (Deepgram/OpenAI/Voxly format detection)
→ Normalize → Render → (optional) cloud sync
```

### 10.5 Local (Unchanged from v2.0)

```
User selects file → TranscriptionService (local adapter)
→ POST file to localhost:5123/transcribe/file (Bearer auth)
→ Server: save file, spawn worker.py subprocess
→ Extension polls /job/{id} → completed → Render → (optional) cloud sync
```

---

## 11. Security

### 11.1 New Security Considerations

| Concern | Mitigation |
|---------|------------|
| Deepgram API key exposure | Key stored only in Edge Function env vars, never in extension |
| Cloud quota bypass | Quotas enforced server-side in Edge Function via service role |
| Custom API key storage | Stored in `chrome.storage.local` (encrypted at rest by Chrome). Never transmitted except to the user's own configured endpoint. |
| YouTube transcript abuse | Rate limited by IP (30 req/min), no auth needed but abuse is low-cost |
| File upload attacks | Edge Function validates content-type and file size before forwarding to Deepgram |

### 11.2 Unchanged Security

All v2.0 security measures remain: RLS on all tables, Bearer token auth for local server, DOMPurify for XSS prevention, `escapeHtmlForShare()` for share modal, OAuth via `chrome.identity.launchWebAuthFlow()`.

---

## 12. Migration & Compatibility

### 12.1 Extension Update Path

- v2.0 → v2.5: `background.js` `onInstalled` handler detects update, runs mode migration (section 3.2)
- All existing features continue working in local mode
- No database migration needed for existing transcripts
- New `usage` table + `profiles.is_premium` column added via Supabase migration

### 12.2 Local Server Compatibility

The Python server is unchanged. Users running v2.0's local server continue to work with v2.5's local mode adapter. The server doesn't know or care about v2.5.

### 12.3 Chrome Web Store

With cloud as the default, the extension can be published to the Chrome Web Store. Non-technical users get a working product without installing Python. The extension description and screenshots will reflect the cloud-first experience.

---

## 13. Phased Rollout

### Phase 1: Foundation

Create `TranscriptionService` abstraction with `LocalServerAdapter` only. Refactor `sidepanel.js` and `background.js` to route all transcription through `TranscriptionService`. No behavior change — this is a pure refactor that validates the adapter interface against real usage.

### Phase 2: Cloud Adapter

Deploy the three Edge Functions (`transcribe`, `transcribe-url`, `youtube-transcript`). Implement `CloudAdapter`. Add mode selection to Settings page. Add `usage` table migration. Wire up the upgrade migration in `background.js`.

### Phase 3: Custom API

Implement `CustomApiAdapter` with response format detection. Add custom API configuration UI to Settings (endpoint, API key, custom headers). Add connection test button.

### Phase 4: UI Polish

Sidepanel footer (Voxly Desktop CTA + rotating privacy tips). Mode-aware status bar. Indeterminate progress bar for cloud/custom. Model selector visibility toggling. One-time upgrade migration banner.

### Phase 5: Hardening

Quota enforcement testing. File size validation edge cases. Error handling for all failure modes (network, quota, auth, Deepgram errors). End-to-end testing across all three modes.

---

## 14. Dependencies

### 14.1 New Dependencies

| Package | Purpose | Where |
|---------|---------|-------|
| Deepgram Nova-2 API | Cloud speech recognition (file uploads, cascade fallback) | Edge Functions (server-side) |
| Supadata.ai API | Social platform transcript extraction (YouTube, TikTok, Instagram, X, Facebook) | Edge Functions (server-side) |
| `youtube_transcript_api` equivalent | Free YouTube caption extraction (cascade step 1 for YouTube URLs) | Edge Functions (server-side) |

### 14.2 Edge Function Runtime

Edge Functions run on Deno (Supabase's runtime). YouTube transcript extraction uses a Deno-compatible library or direct HTTP parsing of YouTube's caption API.

### 14.3 Unchanged Dependencies

All v2.0 dependencies remain for the local server path: faster-whisper, pyannote.audio, FastAPI, yt-dlp, ffmpeg, torch, supabase-js, ExtensionPay, DOMPurify.

---

*Document maintained by the Voxly team*
