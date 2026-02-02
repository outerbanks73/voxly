# SpeakToText Local - Product Requirements Document

**Version:** 1.1.0
**Last Updated:** February 2025

---

## 1. Overview

SpeakToText Local is a privacy-focused audio transcription tool consisting of a Chrome extension frontend and a local Python server backend. It transcribes audio from files, URLs, and browser tabs using OpenAI's Whisper model, with optional speaker diarization via pyannote.audio.

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

### 3.4 Output

- Timestamped segments with speaker labels (if diarization enabled)
- Full text concatenation
- Copy to clipboard functionality
- Download as text file

---

## 4. Non-Functional Requirements

### 4.1 Privacy
- Zero data transmission to external servers (except yt-dlp fetches)
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

## 5. User Interface

### 5.1 Extension Popup

```
┌─────────────────────────────────────┐
│  🎙️ SpeakToText Local      [⚙️]    │
│  Private audio transcription        │
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

### 5.3 Settings Page

- Hugging Face token input (for speaker diarization)
- Token validation status
- Link to pyannote model access request

---

## 6. API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Server status check |
| `/transcribe/file` | POST | Upload file for transcription |
| `/transcribe/url` | POST | Submit URL for transcription |
| `/job/{job_id}` | GET | Poll job status |

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
    "full_text": "Hello... Hi there..."
  },
  "language": "en"
}
```

---

## 7. Version 1.1.0 Release Notes

### New Features
- URL auto-population for streaming sites
- Stage indicator in progress UI
- Improved tab labels ("Record this Tab")

### Bug Fixes
- Fixed `[Errno 32] Broken pipe` error during transcription
- Fixed subprocess Python path to use venv
- Suppressed Whisper stdout pollution in worker

### Architecture Changes
- Introduced `worker.py` for isolated transcription
- Refactored server to use subprocess-based job execution

---

## 8. Future Roadmap

### 1.2.0 (Planned)
- Real-time transcription for tab recording
- Transcript editing in UI
- Export to SRT/VTT subtitle formats
- **Markdown/Obsidian export** - Save transcripts as `.md` files with configurable templates, YAML frontmatter, and folder selection (works with Obsidian, Logseq, or any markdown-based system)

### 1.3.0 (Planned)
- Multiple language detection and transcription
- Custom vocabulary/terminology support
- Batch file processing

### 2.0.0 (Vision)
- Standalone desktop app (Tauri)
- Local model fine-tuning
- **Notion integration** - OAuth-based export directly to Notion pages/databases
- Additional integrations (Google Docs, Confluence, Apple Notes)

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

---

*Document maintained by the SpeakToText Local team*
