# Voxly v3.0 — Technical Design Document

**Version:** 3.0.0 (Draft)
**Last Updated:** February 2026
**Status:** Design Phase

---

## 1. Executive Summary

Voxly v3.0 adds a standalone desktop application built with Tauri 2.0. The desktop app complements the existing Chrome extension (Grammarly model) — both products share the same Supabase cloud backend and Python transcription server. Premium Chrome extension subscribers get the desktop app at no additional cost.

The desktop app replaces browser tab recording with system-level and per-application audio capture, providing a more capable and reliable recording experience.

---

## 2. Goals & Non-Goals

### Goals
- Standalone desktop app for macOS, Windows, and Linux
- System-wide and per-application audio capture
- Shared cloud backend with the Chrome extension
- Single subscription: premium extension users get desktop free
- Auto-update mechanism via GitHub Releases
- Offline-first with cloud sync when connected

### Non-Goals
- Replacing the Chrome extension (both coexist)
- Building a mobile app
- Moving transcription off the local machine
- Changing the Python server's API contract
- CLI tool or webhook support (deferred to v3.1+)

---

## 3. System Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                       User's Machine                                │
│                                                                     │
│  ┌──────────────────────┐      ┌──────────────────────────────┐    │
│  │  Chrome Extension    │      │  Desktop App (Tauri 2.0)     │    │
│  │  (Manifest V3)       │      │                              │    │
│  │  ┌────────────────┐  │      │  ┌──────────┐ ┌──────────┐  │    │
│  │  │  Webview UI    │  │      │  │ Webview  │ │  Rust    │  │    │
│  │  │  (HTML/JS/CSS) │  │      │  │ Frontend │ │  Core    │  │    │
│  │  └───────┬────────┘  │      │  └────┬─────┘ └────┬─────┘  │    │
│  │          │            │      │       │            │         │    │
│  │  ┌───────▼────────┐  │      │  ┌────▼────────────▼─────┐  │    │
│  │  │ Service Worker │  │      │  │   Tauri IPC Bridge    │  │    │
│  │  └───────┬────────┘  │      │  └────────────┬──────────┘  │    │
│  └──────────┼───────────┘      └───────────────┼─────────────┘    │
│             │                                   │                   │
│             │     ┌─────────────────────────┐   │                   │
│             └────►│  Python Server (FastAPI) │◄──┘                   │
│                   │  localhost:5123          │                       │
│                   │  - Transcription engine  │                       │
│                   │  - Job queue             │                       │
│                   │  - URL downloading       │                       │
│                   └─────────────────────────┘                       │
│                                                                     │
└─────────────────────────────┬───────────────────────────────────────┘
                              │
                    ┌─────────▼──────────┐
                    │  Supabase Cloud    │
                    │  (Shared Backend)  │
                    │  - Auth (OAuth)    │
                    │  - Postgres + RLS  │
                    │  - Edge Functions  │
                    └────────────────────┘
```

### 3.1 Key Architectural Decisions

| Decision | Rationale |
|----------|-----------|
| **Tauri 2.0** over Electron | ~10MB binary vs ~150MB. Rust backend enables native audio APIs. |
| **Shared Python server** | Reuse existing transcription engine unchanged. Desktop and extension both talk to `localhost:5123`. |
| **Shared Supabase backend** | One user account, one subscription, one transcript library across both clients. |
| **Webview frontend** | Reuse extension UI components. Same HTML/CSS/JS, adapted for Tauri's IPC. |
| **Rust for audio capture** | Native platform APIs (Core Audio, WASAPI, PipeWire) require low-level access that Rust provides safely. |

### 3.2 Component Responsibilities

| Component | Responsibility |
|-----------|---------------|
| **Tauri Webview** | UI rendering, user interaction, export formatting |
| **Rust Core** | System audio capture, Python server lifecycle, OS integration (tray, shortcuts), auto-updater |
| **Python Server** | Transcription (Whisper), diarization (pyannote), URL downloading (yt-dlp) — unchanged from v2.0 |
| **Supabase** | Auth, transcript storage, sharing, API keys — unchanged from v2.0 |

---

## 4. Desktop App — Tauri 2.0

### 4.1 Tauri Project Structure

```
desktop/
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── capabilities/
│   │   └── default.json          # Permission grants
│   ├── src/
│   │   ├── main.rs               # App entry, plugin registration
│   │   ├── lib.rs                # Shared setup
│   │   ├── audio/
│   │   │   ├── mod.rs            # Platform-agnostic audio trait
│   │   │   ├── macos.rs          # Core Audio Taps / ScreenCaptureKit
│   │   │   ├── windows.rs        # WASAPI loopback
│   │   │   └── linux.rs          # PipeWire capture
│   │   ├── server/
│   │   │   ├── mod.rs            # Python server lifecycle management
│   │   │   └── health.rs         # Health check polling
│   │   ├── commands.rs           # Tauri IPC command handlers
│   │   └── entitlement.rs        # ExtPay → Supabase entitlement check
│   └── icons/                    # App icons (all platforms)
├── src/                          # Webview frontend
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   └── lib/                      # Shared from extension where possible
└── package.json
```

### 4.2 Tauri Plugins Required

| Plugin | Purpose |
|--------|---------|
| `tauri-plugin-deep-link` | OAuth callback via `voxly://auth` |
| `tauri-plugin-single-instance` | Prevent multiple app instances; receive deep link in running instance |
| `tauri-plugin-opener` | Open system browser for OAuth |
| `tauri-plugin-updater` | Auto-update from GitHub Releases |
| `tauri-plugin-fs` | Read/write transcripts and audio cache |
| `tauri-plugin-shell` | Spawn/manage Python server subprocess |
| `tauri-plugin-notification` | Transcription complete alerts |
| `tauri-plugin-global-shortcut` | System-wide record hotkey |

### 4.3 Tauri Capabilities (Security Model)

Tauri 2.0 replaced the allowlist with a Capabilities + Permissions + Scopes model.

```json
// capabilities/default.json
{
  "identifier": "default",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "fs:allow-read",
    "fs:allow-write",
    "shell:allow-execute",
    "opener:allow-open-url",
    "deep-link:default",
    "updater:default",
    "notification:default",
    "global-shortcut:allow-register"
  ]
}
```

### 4.4 IPC Commands

The webview communicates with Rust via `invoke()`. All commands return `Result<T, String>`.

```rust
// commands.rs — Tauri command handlers

#[tauri::command]
async fn start_system_capture(app_pid: Option<u32>) -> Result<String, String>

#[tauri::command]
async fn stop_system_capture(session_id: String) -> Result<Vec<u8>, String>

#[tauri::command]
async fn list_audio_applications() -> Result<Vec<AudioApp>, String>

#[tauri::command]
async fn start_python_server() -> Result<(), String>

#[tauri::command]
async fn stop_python_server() -> Result<(), String>

#[tauri::command]
async fn check_python_server() -> Result<bool, String>

#[tauri::command]
async fn get_entitlement_status(email: String) -> Result<bool, String>
```

Frontend calls:

```javascript
const apps = await invoke('list_audio_applications');
const sessionId = await invoke('start_system_capture', { appPid: selectedApp.pid });
// ... recording ...
const audioData = await invoke('stop_system_capture', { sessionId });
```

---

## 5. System Audio Capture

### 5.1 Platform Strategy

| Platform | Primary API | Fallback | Per-App Support | Rust Crate |
|----------|-------------|----------|-----------------|------------|
| **macOS** | Core Audio Taps (14.2+) | ScreenCaptureKit (13+) | Yes (tap specific process) | Custom FFI bindings |
| **Windows** | WASAPI Loopback | — | Yes (`AudioClient::new_application_loopback_client`) | `wasapi` |
| **Linux** | PipeWire | PulseAudio loopback | Yes (graph node routing) | `pipewire` (v0.9+) |

### 5.2 Audio Capture Trait

```rust
// audio/mod.rs

pub struct AudioApp {
    pub pid: u32,
    pub name: String,
    pub icon: Option<Vec<u8>>,
}

pub struct CaptureConfig {
    pub sample_rate: u32,      // 16000 (Whisper optimal)
    pub channels: u16,          // 1 (mono)
    pub format: SampleFormat,   // F32
    pub target: CaptureTarget,  // System or App(pid)
}

pub enum CaptureTarget {
    System,
    Application(u32), // PID
}

#[async_trait]
pub trait AudioCapture: Send + Sync {
    async fn list_applications() -> Result<Vec<AudioApp>>;
    async fn start(config: CaptureConfig) -> Result<CaptureSession>;
    async fn stop(session: CaptureSession) -> Result<AudioBuffer>;
}
```

### 5.3 macOS — Core Audio Taps

Core Audio Taps (macOS 14.2+) provide per-process audio capture without screen recording permission.

```
App audio output → Core Audio Tap → Ring buffer → WAV encode → POST to server
```

**Permissions required:** None for system audio taps on 14.2+. ScreenCaptureKit fallback (macOS 13) needs Screen Recording permission.

**FFI approach:** No existing Rust crate wraps Core Audio Taps. Build a thin C bridge:

```c
// bridge/macos_audio.c
#include <CoreAudio/CoreAudio.h>

CATapDescription *create_process_tap(pid_t pid);
OSStatus start_tap(CATapDescription *tap, AudioBufferCallback callback);
void stop_tap(CATapDescription *tap);
```

Linked via `build.rs` with `cc` crate and `-framework CoreAudio`.

**Fallback for macOS 13:** Use `screencapturekit` crate with `SCStreamConfiguration` audio-only mode.

### 5.4 Windows — WASAPI

```rust
// audio/windows.rs
use wasapi::{AudioClient, Direction, ShareMode};

// System loopback
let client = AudioClient::new(Direction::Capture, ShareMode::Shared)?;
client.initialize_loopback()?;

// Per-application (Windows 10 2004+)
let client = AudioClient::new_application_loopback_client(target_pid)?;
```

**Permissions required:** None. WASAPI loopback is unprivileged.

### 5.5 Linux — PipeWire

```rust
// audio/linux.rs
use pipewire::{MainLoop, Context};

// Connect to PipeWire daemon
let mainloop = MainLoop::new()?;
let context = Context::new(&mainloop)?;
let core = context.connect(None)?;

// Create stream targeting specific node
let props = properties! {
    "media.class" => "Audio/Sink",
    "stream.capture.sink" => "true",
    "target.object" => node_id,  // Per-app routing
};
```

**Permissions required:** PipeWire access (default on modern distros). Flatpak needs `--socket=pipewire`.

### 5.6 Audio Pipeline (All Platforms)

```
Capture Device/Tap
    │
    ▼
Ring Buffer (lock-free, 30s capacity)
    │
    ▼
Resample to 16kHz mono f32 (if needed)
    │
    ▼
WAV encode in memory
    │
    ▼
POST /transcribe/file → Python server
    │
    ▼
Poll /job/{id} until complete
```

The ring buffer accumulates audio during capture. On stop, the buffer contents are WAV-encoded and submitted to the existing Python server endpoint — no changes to the server API.

---

## 6. Authentication & Entitlements

### 6.1 OAuth in Tauri

The desktop app uses Supabase PKCE (Proof Key for Code Exchange) flow with deep linking.

```
Desktop App                   System Browser               Supabase
    │                              │                          │
    │  1. Generate PKCE pair       │                          │
    │     (code_verifier,          │                          │
    │      code_challenge)         │                          │
    │                              │                          │
    │  2. Open browser ───────────►│                          │
    │     supabase.co/auth?        │                          │
    │     flow_type=pkce&          │                          │
    │     code_challenge=xxx&      │                          │
    │     redirect_to=voxly://auth │                          │
    │                              │  3. User authenticates   │
    │                              │────────────────────────►  │
    │                              │                          │
    │                              │  4. Redirect with code   │
    │                              │◄────────────────────────  │
    │                              │                          │
    │  5. Deep link callback ◄─────│                          │
    │     voxly://auth?code=yyy    │                          │
    │                              │                          │
    │  6. Exchange code + verifier ────────────────────────►  │
    │                              │                          │
    │  7. Access + refresh tokens  ◄────────────────────────  │
    │                              │                          │
    │  8. Store tokens locally     │                          │
    └──────────────────────────────┘──────────────────────────┘
```

**Deep link registration:**

```json
// tauri.conf.json
{
  "plugins": {
    "deep-link": {
      "desktop": {
        "schemes": ["voxly"]
      }
    }
  }
}
```

**Token storage:** Tokens stored in the OS keychain via Tauri's `tauri-plugin-store` (encrypted at rest). Session refresh on a timer, same 55-min interval as the extension.

### 6.2 ExtPay → Desktop Entitlement Bridge

ExtPay (Chrome extension payments) has no external API. The desktop app cannot query ExtPay directly. Solution: the Chrome extension syncs payment status to Supabase, and the desktop app reads from Supabase.

```
Chrome Extension                    Supabase                     Desktop App
    │                                  │                             │
    │  ExtPay.getUser()                │                             │
    │  → { paid: true, email }         │                             │
    │                                  │                             │
    │  Upsert to user_entitlements ───►│                             │
    │  { email, paid, plan,            │                             │
    │    source: 'extpay',             │                             │
    │    updated_at }                  │                             │
    │                                  │                             │
    │                                  │  Query user_entitlements ◄──│
    │                                  │  WHERE email = ?            │
    │                                  │──────────────────────────►  │
    │                                  │                             │
    │                                  │  { paid: true, plan: ... }  │
    └──────────────────────────────────┘─────────────────────────────┘
```

**New Supabase table:**

```sql
CREATE TABLE user_entitlements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    paid BOOLEAN DEFAULT false,
    plan TEXT DEFAULT 'free',        -- 'free', 'premium'
    source TEXT DEFAULT 'extpay',    -- 'extpay', 'stripe', etc.
    extpay_user_id TEXT,
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(email)
);

ALTER TABLE user_entitlements ENABLE ROW LEVEL SECURITY;

-- Users can read their own entitlement
CREATE POLICY "Users read own entitlement"
    ON user_entitlements FOR SELECT
    USING (auth.uid() = user_id);

-- Service role (extension via Supabase client) can upsert
-- Extension uses authenticated user context, RLS handles it
CREATE POLICY "Users upsert own entitlement"
    ON user_entitlements FOR ALL
    USING (auth.uid() = user_id);
```

**Extension sync logic (added to cloud-sync.js):**

```javascript
async function syncEntitlementStatus() {
    const extpayUser = await extpay.getUser();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user || !extpayUser) return;

    await supabase.from('user_entitlements').upsert({
        user_id: user.id,
        email: user.email,
        paid: extpayUser.paid,
        plan: extpayUser.paid ? 'premium' : 'free',
        source: 'extpay',
        updated_at: new Date().toISOString()
    }, { onConflict: 'email' });
}
```

**Desktop entitlement check (Rust):**

```rust
// entitlement.rs
pub async fn check_premium(supabase_client: &Client, email: &str) -> Result<bool> {
    let response = supabase_client
        .from("user_entitlements")
        .select("paid")
        .eq("email", email)
        .single()
        .execute()
        .await?;

    Ok(response.body.get("paid").and_then(|v| v.as_bool()).unwrap_or(false))
}
```

### 6.3 Auth Flows Summary

| Method | Extension (v2.0) | Desktop (v3.0) |
|--------|-------------------|-----------------|
| Google OAuth | `chrome.identity.launchWebAuthFlow()` | Deep link + PKCE |
| GitHub OAuth | `chrome.identity.launchWebAuthFlow()` | Deep link + PKCE |
| Email/password | `supabase.auth.signInWithPassword()` | Same (direct API call) |
| Magic link | Redirect to options.html | Redirect to `voxly://auth` |
| Token storage | `chrome.storage.local` | OS keychain via Tauri store |
| Session refresh | Background alarm (55 min) | Rust timer (55 min) |

---

## 7. Python Server Lifecycle

The desktop app manages the Python server as a child process. The server API is unchanged.

### 7.1 Startup Sequence

```
App Launch
    │
    ├─ 1. Check if server already running (GET /health)
    │     └─ If running → skip to step 4
    │
    ├─ 2. Locate Python environment
    │     └─ Check: server/venv/bin/python → system python3 → error
    │
    ├─ 3. Spawn server subprocess
    │     └─ Command: {python} server/server.py
    │     └─ Working dir: project root
    │     └─ Redirect stdout/stderr to log file
    │
    ├─ 4. Poll /health every 500ms (max 30s timeout)
    │     └─ If healthy → ready
    │     └─ If timeout → show error to user
    │
    └─ 5. Monitor process (restart on unexpected exit)
```

### 7.2 Shutdown

On app quit, send SIGTERM to the Python server child process. Wait 5 seconds, then SIGKILL if still alive. This matches the existing `stop-server.sh` behavior.

### 7.3 Server Discovery

Both the extension and desktop app use `localhost:5123`. If both run simultaneously, they share the same server instance — no conflict, since the server is stateless between requests (job state is per-job).

---

## 8. Frontend Architecture

### 8.1 Code Sharing Strategy

The desktop webview reuses extension UI components where possible, with a thin adaptation layer for Tauri IPC vs Chrome extension APIs.

| Component | Extension | Desktop | Shared? |
|-----------|-----------|---------|---------|
| Transcript viewer | transcript.html/js | transcript.html/js | Yes |
| Export formatting | transcript.js | transcript.js | Yes |
| Cloud sync | cloud-sync.js | cloud-sync.js | Yes |
| Supabase client | supabase.js | supabase.js | Adapted (no chrome.storage) |
| Auth UI | cloud-auth.js | auth-desktop.js | No (different flows) |
| Audio capture | background.js (tabCapture) | Rust IPC | No |
| Server management | External (start-server.sh) | Rust child process | No |
| Config | config.js (chrome.runtime) | config.js (static) | Adapted |

### 8.2 Platform Abstraction Layer

```javascript
// platform.js — abstracts Chrome extension vs Tauri runtime

const Platform = {
    isDesktop: () => window.__TAURI__ !== undefined,
    isExtension: () => typeof chrome !== 'undefined' && chrome.runtime?.id,

    // Storage
    async getStorage(key) {
        if (this.isDesktop()) {
            return invoke('get_storage', { key });
        }
        return new Promise(r => chrome.storage.local.get(key, r));
    },

    // Server communication (identical — both use localhost:5123)
    async transcribeFile(formData) {
        return fetch(`${SERVER_URL}/transcribe/file`, { method: 'POST', body: formData });
    },

    // Audio capture (divergent)
    async startCapture(target) {
        if (this.isDesktop()) {
            return invoke('start_system_capture', { appPid: target?.pid });
        }
        return chrome.tabCapture.capture({ audio: true });
    }
};
```

### 8.3 Desktop-Only UI Features

- **Application picker:** Dropdown listing running audio applications (from `list_audio_applications` IPC)
- **System tray:** Persistent tray icon with record/stop toggle, recent transcripts, server status
- **Global shortcut indicator:** Visual overlay showing the active hotkey
- **Server status panel:** In-app view of Python server health, logs, restart button

---

## 9. Auto-Update

### 9.1 Mechanism

Uses `tauri-plugin-updater` with GitHub Releases as the update source.

```
App Launch
    │
    └─ Check for updates (async, non-blocking)
         │
         ├─ GET https://github.com/{owner}/{repo}/releases/latest
         │
         ├─ Compare current_version vs latest tag
         │
         └─ If newer → prompt user → download → install → restart
```

### 9.2 Configuration

```json
// tauri.conf.json
{
  "plugins": {
    "updater": {
      "endpoints": [
        "https://github.com/outerbanks73/speaktotext-local/releases/latest/download/latest.json"
      ],
      "pubkey": "<Ed25519 public key>"
    }
  }
}
```

### 9.3 Build & Release Pipeline

```yaml
# .github/workflows/release.yml
# Triggered by pushing a version tag (v3.x.x)

jobs:
  build:
    strategy:
      matrix:
        platform: [macos-latest, windows-latest, ubuntu-22.04]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2      # Frontend deps
      - uses: dtolnay/rust-toolchain@stable
      - uses: tauri-apps/tauri-action@v0
        with:
          tagName: v__VERSION__
          releaseName: Voxly v__VERSION__
          releaseBody: "See CHANGELOG.md for details"
          updaterJsonKeepUniversal: true
        env:
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_KEY_PASSWORD }}
```

**Build artifacts per platform:**

| Platform | Format | Size Estimate |
|----------|--------|---------------|
| macOS | `.dmg` (universal binary) | ~15 MB |
| Windows | `.msi` + `.nsis` | ~12 MB |
| Linux | `.deb`, `.AppImage` | ~10 MB |

Note: These sizes are for the Tauri app only. The Python server and Whisper models are installed separately.

---

## 10. Data Flow — Complete Transcription Cycle

### 10.1 System Audio Recording (Desktop)

```
1. User selects audio source (system or specific app)
2. Frontend: invoke('start_system_capture', { appPid })
3. Rust: Platform audio API starts capture → ring buffer
4. User clicks Stop
5. Frontend: invoke('stop_system_capture', { sessionId })
6. Rust: Stop capture → WAV encode → return bytes
7. Frontend: POST /transcribe/file (multipart, audio.wav)
8. Server: Queue job → worker.py transcribes via Whisper
9. Frontend: Poll /job/{id} every 500ms
10. Server returns segments + metadata
11. Frontend: Render transcript, offer export
12. If premium: cloud-sync.js → Supabase upsert
```

### 10.2 File Upload / URL (Shared Path)

Identical to extension v2.0. The frontend sends the same HTTP requests to the same server endpoints. No changes needed.

---

## 11. Database Changes

### 11.1 New Table: `user_entitlements`

See Section 6.2 for full schema. Bridges ExtPay subscription status to the desktop app.

### 11.2 Modified Table: `transcripts`

Add `source_client` column to distinguish transcript origin:

```sql
ALTER TABLE transcripts ADD COLUMN source_client TEXT DEFAULT 'extension';
-- Values: 'extension', 'desktop', 'api'
```

### 11.3 Migration

```sql
-- supabase/migrations/002_desktop_support.sql

-- Entitlement bridge table
CREATE TABLE user_entitlements ( ... );  -- Full schema in Section 6.2

-- Track which client created the transcript
ALTER TABLE transcripts ADD COLUMN source_client TEXT DEFAULT 'extension';
```

---

## 12. Security Considerations

| Risk | Mitigation |
|------|------------|
| OAuth token theft | PKCE flow (not implicit). Tokens in OS keychain, not plaintext. |
| Audio capture without consent | macOS: Core Audio Taps require no permission but user explicitly clicks Record. Show recording indicator. |
| Python server exposed | Localhost-only binding. Auth token on all endpoints (auto-configured, same as v2.0). |
| Auto-update MITM | Ed25519 signature verification on all updates. HTTPS transport. |
| Tauri IPC injection | Capabilities restrict which commands the webview can call. No `dangerousRemoteDomainIpcAccess`. |
| Deep link hijacking | Validate `state` parameter in OAuth callback. Single-instance plugin prevents duplicate handlers. |
| Entitlement spoofing | RLS policy: users can only read/write their own entitlement row. Extension writes with authenticated Supabase client. |

---

## 13. Testing Strategy

### 13.1 Unit Tests

| Component | Framework | Coverage Target |
|-----------|-----------|-----------------|
| Rust audio module | `cargo test` | Platform trait, buffer management, WAV encoding |
| Rust server lifecycle | `cargo test` | Spawn, health check, restart, shutdown |
| Entitlement check | `cargo test` | Mock Supabase responses, edge cases |
| Frontend platform.js | Manual / browser | IPC abstraction, storage adapter |

### 13.2 Integration Tests

| Scenario | Method |
|----------|--------|
| Full transcription cycle (desktop) | Record system audio → transcribe → verify output |
| OAuth flow | Deep link → token exchange → session valid |
| Entitlement sync | Extension pay → Supabase row → desktop reads |
| Auto-update | Mock update server → download → verify signature |
| Cross-client library | Create transcript in extension → visible in desktop |

### 13.3 Platform Testing Matrix

| | macOS 13 | macOS 14.2+ | Windows 10 | Windows 11 | Ubuntu 22.04 | Fedora 39 |
|---|---|---|---|---|---|---|
| System capture | SCK | Core Audio Tap | WASAPI | WASAPI | PipeWire | PipeWire |
| Per-app capture | SCK | Core Audio Tap | WASAPI | WASAPI | PipeWire | PipeWire |
| OAuth deep link | Test | Test | Test | Test | Test | Test |
| Auto-update | Test | Test | Test | Test | Test | Test |

---

## 14. Rollout Plan

### Phase 1 — Scaffolding (2 weeks)
- Tauri 2.0 project setup with plugins
- Basic webview with hardcoded UI
- Python server lifecycle (spawn, health, shutdown)
- File upload transcription working end-to-end

### Phase 2 — Audio Capture (3 weeks)
- Platform audio trait + macOS implementation (Core Audio Taps)
- Windows WASAPI implementation
- Linux PipeWire implementation
- Application picker UI
- Ring buffer + WAV encoding pipeline

### Phase 3 — Auth & Entitlements (2 weeks)
- Supabase PKCE OAuth flow with deep linking
- Token storage in OS keychain
- `user_entitlements` table + RLS
- Extension entitlement sync
- Desktop entitlement check + premium gating

### Phase 4 — UI & Polish (2 weeks)
- Port extension transcript viewer to desktop
- System tray with record/stop
- Global shortcut registration
- Cloud sync integration (reuse cloud-sync.js)
- Export to all formats (JSON, MD, SRT, VTT, TXT)

### Phase 5 — Distribution (1 week)
- GitHub Actions CI/CD with `tauri-action`
- Code signing (macOS notarization, Windows Authenticode)
- Auto-updater configuration + signing keys
- Landing page / download instructions

### Phase 6 — Beta (2 weeks)
- Closed beta with existing premium users
- Cross-platform testing matrix
- Bug fixes and performance tuning
- Documentation

**Estimated total: ~12 weeks**

---

## 15. Dependencies

### 15.1 Rust Crates (New)

| Crate | Purpose | Version |
|-------|---------|---------|
| `tauri` | App framework | 2.x |
| `tauri-plugin-deep-link` | OAuth deep linking | Latest |
| `tauri-plugin-single-instance` | Prevent duplicates | Latest |
| `tauri-plugin-opener` | Open system browser | Latest |
| `tauri-plugin-updater` | Auto-updates | Latest |
| `tauri-plugin-fs` | Filesystem access | Latest |
| `tauri-plugin-shell` | Subprocess management | Latest |
| `tauri-plugin-notification` | OS notifications | Latest |
| `tauri-plugin-global-shortcut` | System hotkeys | Latest |
| `wasapi` | Windows audio capture | 0.11+ |
| `pipewire` | Linux audio capture | 0.9+ |
| `cc` | C FFI build (macOS audio bridge) | Latest |
| `ringbuf` | Lock-free ring buffer | Latest |
| `hound` | WAV encoding | Latest |

### 15.2 Existing Dependencies (Unchanged)

Python server, Supabase, extension — all unchanged from v2.0. See PRD.md Section 9.

---

## 16. Open Questions

| # | Question | Impact | Default Assumption |
|---|----------|--------|-------------------|
| 1 | Bundle Python + Whisper with installer, or require pre-installed? | UX vs download size | Require pre-installed (link to install guide) |
| 2 | macOS 13 support (ScreenCaptureKit fallback) or 14.2+ only? | User reach vs complexity | Support 14.2+ only, revisit if requested |
| 3 | System tray on Linux (varies by DE)? | UX on Linux | Implement for GNOME/KDE, skip for tiling WMs |
| 4 | Separate desktop repo or monorepo with extension? | CI/CD complexity | Monorepo (add `desktop/` directory) |
| 5 | Per-app audio on Linux — PipeWire only, or support PulseAudio? | Distro coverage | PipeWire only (ships on Ubuntu 22.10+, Fedora 34+) |

---

*Document maintained by the Voxly team*
