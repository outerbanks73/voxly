# Voxly - Vision

## Mission

Provide a powerful audio transcription platform that transforms spoken content into AI-ready data. Local Whisper transcription for privacy, cloud storage for convenience, and flexible exports (Markdown, JSON, SRT) for seamless integration with AI workflows, note-taking systems, and data pipelines.

## Core Principles

### 1. AI-Ready Output
Audio and video content is one of the richest sources of information, but it's trapped in formats that AI systems can't easily process. Voxly extracts and structures this content into formats optimized for LLM consumption, RAG pipelines, and knowledge management systems.

### 2. Rich Metadata
A transcript alone isn't enough. We enrich every export with:
- Source information (URL, filename, platform)
- Timing data (duration, word count, timestamps)
- Speaker identification and labeling
- Language detection
- Processing metadata (model used, date processed)

### 3. Format Flexibility
Different workflows need different formats:
- **Markdown** - Perfect for Obsidian, Notion, and note-taking apps
- **JSON** - Structured data for APIs, databases, and custom integrations
- **SRT/VTT** - Industry-standard subtitles for video editing
- **Plain Text** - Universal compatibility

### 4. Local-First, Cloud-Enhanced
All transcription happens on your machine using OpenAI Whisper. Your audio never leaves your computer. Premium users can optionally sync transcripts to the cloud for search, sharing, and API access — but local-only mode is fully preserved.

## Target Users

1. **AI/ML Engineers** - Building RAG systems, training data pipelines, and LLM applications
2. **Researchers** - Converting interviews and lectures into searchable, analyzable data
3. **Content Creators** - Generating show notes, blog posts, and repurposed content from podcasts/videos
4. **Knowledge Workers** - Building personal knowledge bases in Obsidian, Notion, or similar tools
5. **Data Teams** - Extracting structured data from audio/video archives
6. **Developers** - Accessing transcripts programmatically via the REST API

## The Platform

```
┌─────────────────────────────────────────────────────────────────┐
│                      Audio/Video Source                          │
│         Files, YouTube, Podcasts, Tab Recording                  │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                         Voxly                                    │
│  ┌─────────────┐  ┌─────────────┐  ┌────────────────────┐      │
│  │  Whisper    │  │  Speaker    │  │    Metadata        │      │
│  │ Transcribe  │→ │  Diarize    │→ │    Enrichment      │      │
│  └─────────────┘  └─────────────┘  └────────────────────┘      │
└────────────────────────────┬────────────────────────────────────┘
                             │
          ┌──────────────────┼──────────────────┐
          ▼                  ▼                  ▼
     ┌─────────┐      ┌───────────┐      ┌───────────┐
     │Markdown │      │   JSON    │      │  SRT/VTT  │
     │ + YAML  │      │ + Schema  │      │ Subtitles │
     └────┬────┘      └─────┬─────┘      └─────┬─────┘
          │                 │                  │
          ▼                 ▼                  ▼
     Obsidian          Vector DB           Video
     Notion            RAG Pipeline        Editors
     PKM Tools         Custom Apps         YouTube
                             │
                             ▼
                    ┌─────────────────┐
                    │  Cloud (opt-in) │
                    │  Library, Share, │
                    │  Search, API     │
                    └─────────────────┘
```

## What Sets Us Apart

| Feature | Cloud Services | Voxly |
|---------|---------------|-------|
| Data Location | Their servers | Your machine |
| Cloud Sync | Required | Optional (premium) |
| Export Formats | Limited | MD, JSON, SRT, VTT, TXT |
| Metadata | Basic | Rich, customizable |
| AI Integration | Proprietary | Open formats |
| API Access | Vendor lock-in | Developer-friendly REST API |
| Sharing | Platform-specific | Public links + user-to-user |
| Cost | Per-minute pricing | Free core (premium for cloud) |

## Current Version: 2.0.0

This release transforms Voxly into a cloud-enabled platform:
- **OAuth accounts** — Google, GitHub, email/password, magic links via Supabase Auth
- **Cloud transcript storage** — Supabase Postgres with automatic sync after transcription
- **Transcript library** — Full-text search, pagination, "Shared with me" tab
- **Sharing** — Public share links and user-to-user sharing with read/write permissions
- **Developer API** — REST API via Supabase Edge Functions with API key authentication
- **Local-only mode preserved** — All core functionality works without an account

## Roadmap

### Version 2.5 - Integrations & Custom Models
- Direct export to Notion, Obsidian, Google Docs
- Fine-tune Whisper on domain-specific vocabulary
- Custom speaker voice profiles
- Industry-specific terminology support

### Version 3.0 - Desktop App
- Standalone desktop application (Tauri)
- System-wide keyboard shortcuts
- Menu bar quick access
- Offline-first architecture
- Webhook support for automation (Zapier, n8n)
- CLI tool for batch processing
