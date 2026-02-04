# SpeakToText Local - Product Requirements Document

**Version:** 1.4.0
**Last Updated:** February 2025

---

## 1. Overview

SpeakToText Local is an AI data preparation tool that transforms audio and video content into structured, AI-ready formats. It consists of a Chrome extension frontend and a local Python server backend, using OpenAI's Whisper model for transcription and optional speaker diarization via pyannote.audio.

**Key Value Proposition:** Convert spoken content into formats optimized for LLM consumption, RAG pipelines, knowledge bases, and data workflows.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Chrome Extension                          │
│  ┌──────────┐  ┌──────────┐  ┌────────────────────┐        │
│  │   URL    │  │   File   │  │  Record this Tab   │        │
│  └────┬─────┘  └────┬─────┘  └─────────┬──────────┘        │
│       │             │                   │                   │
│       └─────────────┴───────────────────┘                   │
│                        │                                     │
│              HTTP POST to localhost:5123                     │
└────────────────────────┼────────────────────────────────────┘
                         │
┌────────────────────────┼────────────────────────────────────┐
│                   Python Server                              │
│                        │                                     │
│  ┌─────────────────────▼─────────────────────────┐          │
│  │              server.py (FastAPI)              │          │
│  │  - Job queue management                       │          │
│  │  - URL downloading (yt-dlp)                   │          │
│  │  - Audio caching                              │          │
│  │  - Status polling endpoints                   │          │
│  └─────────────────────┬─────────────────────────┘          │
│                        │                                     │
│              subprocess.run()                                │
│                        │                                     │
│  ┌─────────────────────▼─────────────────────────┐          │
│  │              worker.py (Isolated)             │          │
│  │  - Whisper transcription                      │          │
│  │  - Speaker diarization (pyannote)             │          │
│  │  - JSON output to stdout                      │          │
│  └───────────────────────────────────────────────┘          │
└─────────────────────────────────────────────────────────────┘
```

### 2.1 Why Subprocess Isolation?

The transcription worker runs as a separate subprocess to solve critical issues:

1. **Broken Pipe Prevention**: Whisper and pyannote output progress bars (tqdm) to stdout/stderr. When these streams close unexpectedly in threaded contexts, `[Errno 32] Broken pipe` crashes occur. Subprocess isolation provides clean stream handling.

2. **Memory Management**: Transcription can consume significant memory. Subprocess isolation allows clean memory release after each job.

3. **Stability**: PyTorch/CUDA operations in threads can cause conflicts. Isolation ensures reliable model execution.

---

## 3. Functional Requirements

### 3.1 Input Methods

| Method | Description | Implementation |
|--------|-------------|----------------|
| **File Upload** | User selects local audio/video file | Direct upload via FormData |
| **URL** | User provides URL to audio/video | Server downloads via yt-dlp, caches locally |
| **Tab Recording** | Captures audio from active browser tab | Chrome tabCapture API → WebM encoding |

### 3.2 URL Input Features

- **Auto-population**: When user opens extension on a streaming site, URL field auto-fills with current tab URL
- **Supported Sites**: 30+ platforms including YouTube, Spotify, Vimeo, SoundCloud, podcasts, etc.
- **Caching**: Downloaded audio cached for 24 hours to avoid re-downloads

### 3.3 Transcription Options

| Option | Values | Default |
|--------|--------|---------|
| **Model** | tiny, base, small, medium, large | base |
| **Speaker Diarization** | Enabled/Disabled | Disabled |
| **HF Token** | User-provided | None |

### 3.4 Export Formats

| Format | Use Case | Features |
|--------|----------|----------|
| **JSON** | APIs, databases, RAG pipelines | Full metadata, structured schema |
| **Markdown** | Obsidian, Notion, note-taking | YAML frontmatter, formatted text |
| **SRT** | Video editing, YouTube | Industry-standard subtitles |
| **VTT** | Web video, HTML5 | WebVTT with speaker tags |
| **TXT** | Universal | Plain text, simple copy |

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

### 4.1 Local Processing
- All transcription happens on user's machine
- No data transmission to external servers (except yt-dlp fetches)
- No analytics or telemetry
- No account required for core functionality

### 4.2 Performance
- Tiny model: ~10x realtime on CPU
- Base model: ~5x realtime on CPU
- Large model: ~1x realtime on CPU (faster with GPU)

### 4.3 Compatibility
- Python 3.9+
- Chrome/Chromium browsers
- Safari (limited - no tab recording)
- macOS, Linux, Windows

---

## 5. User Interface

### 5.1 Extension Popup

```
┌─────────────────────────────────────┐
│  🎙️ SpeakToText Local      [⚙️]    │
│  Transform audio to AI-ready data   │
├─────────────────────────────────────┤
│  [URL] [File] [Record this Tab]     │  ← Tab navigation
├─────────────────────────────────────┤
│  We will download, then transcribe  │  ← Context-aware description
│  and save your clip.                │
│                                     │
│  🔗 [https://youtube.com/watch...]  │  ← Auto-populated input
│                                     │
│  Model: [Base (recommended) ▼]      │  ← Model selector
│                                     │
│  [      Transcribe URL      ]       │  ← Action button
├─────────────────────────────────────┤
│  ⏳ Downloading...                  │  ← Stage indicator
│  ████████░░░░░░░░░░ 45%             │  ← Progress bar
│  Downloading audio... 45%           │  ← Status text
└─────────────────────────────────────┘
```

### 5.2 Progress Stages

1. **Queued** → Job accepted, waiting to process
2. **Downloading** → Fetching audio from URL (shows percentage)
3. **Processing** → Whisper transcription in progress
4. **Complete** → Results ready for display

### 5.3 Export Menu

```
┌─────────────────────────────────────┐
│  [📋 Copy] [✏️ Edit] [💾 Export ▼] │
│                    ┌───────────────┐│
│                    │ 📄 Text (.txt)││
│                    │ 📝 Markdown   ││
│                    │ 🔧 JSON       ││
│                    │ 🎬 SRT        ││
│                    │ 🎥 VTT        ││
│                    └───────────────┘│
└─────────────────────────────────────┘
```

### 5.4 Settings Page

- Hugging Face token input (for speaker diarization)
- Token validation status
- Media storage folder configuration
- Link to pyannote model access request

---

## 6. API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Server status check |
| `/transcribe/file` | POST | Upload file for transcription |
| `/transcribe/url` | POST | Submit URL for transcription |
| `/job/{job_id}` | GET | Poll job status |
| `/transcribe/realtime/start` | POST | Start real-time session |
| `/transcribe/realtime/chunk/{session_id}` | POST | Send audio chunk |
| `/transcribe/realtime/stop/{session_id}` | POST | End session, get result |

### 6.1 Job Status Response

```json
{
  "status": "completed",
  "progress": "Done!",
  "stage": "complete",
  "download_percent": 100,
  "url": "https://youtube.com/...",
  "result": {
    "segments": [
      {"timestamp": "00:00", "speaker": "SPEAKER_00", "text": "Hello..."},
      {"timestamp": "00:05", "speaker": "SPEAKER_01", "text": "Hi there..."}
    ],
    "full_text": "Hello... Hi there...",
    "metadata": {
      "source": "https://youtube.com/...",
      "duration": 125,
      "word_count": 450,
      "speakers": ["SPEAKER_00", "SPEAKER_01"],
      "language": "en",
      "model": "base",
      "processed_at": "2025-02-03T10:30:00Z"
    }
  },
  "language": "en"
}
```

---

## 7. Version History

### 1.4.0 (Current)
- **JSON export** with full metadata schema
- **Enhanced Markdown** with YAML frontmatter
- **Metadata enrichment** (source, duration, speakers, language, word count)
- Rebranded focus: AI data preparation tool
- Updated documentation and vision

### 1.3.0
- Safari extension support
- Build script for Safari (`build-safari.sh`)
- Safari-compatible manifest without tabCapture
- Automatic update notification system
- Update scripts (`update.sh`, `update.bat`)

### 1.2.0
- Real-time transcription for tab recording
- Transcript editing in UI
- Export to SRT/VTT subtitle formats
- Markdown/Obsidian export with YAML frontmatter
- Custom storage folder configuration

### 1.1.0
- URL auto-population for streaming sites
- Stage indicator in progress UI
- Improved tab labels ("Record this Tab")
- Fixed `[Errno 32] Broken pipe` error during transcription
- Fixed subprocess Python path to use venv
- Suppressed Whisper stdout pollution in worker
- Introduced `worker.py` for isolated transcription

---

## 8. Roadmap

### 2.0.0 - Cloud Platform
- User accounts with OAuth authentication
- Cloud storage for transcripts and media (Supabase backend)
- Transcript library with search and organization
- Sharing and collaboration features
- API access for automated workflows
- Direct integrations (Notion, Google Docs, Confluence)

### 2.5.0 - Custom Models
- Local model fine-tuning on domain-specific vocabulary
- Custom speaker voice profiles
- Industry-specific terminology support
- Batch file processing
- CLI tool for automation

### 3.0.0 - Desktop App
- Standalone desktop application (Tauri)
- System-wide keyboard shortcuts
- Menu bar quick access
- Offline-first architecture

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

---

## 10. Success Metrics

Since we don't collect analytics, success is measured by:

1. **GitHub Stars/Forks** - Community interest
2. **Issue Reports** - Active usage and feedback
3. **Contribution PRs** - Developer engagement
4. **User Testimonials** - Qualitative feedback
5. **Export Usage** - Which formats users request most (via GitHub issues)

---

*Document maintained by the SpeakToText Local team*
