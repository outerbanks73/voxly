# SpeakToText Local - Vision

## Mission

Provide a powerful, locally-run audio transcription tool that transforms spoken content into AI-ready data. Export to multiple formats (Markdown, JSON, SRT) with rich metadata for seamless integration with AI workflows, note-taking systems, and data pipelines.

## Core Principles

### 1. AI-Ready Output
Audio and video content is one of the richest sources of information, but it's trapped in formats that AI systems can't easily process. SpeakToText Local extracts and structures this content into formats optimized for LLM consumption, RAG pipelines, and knowledge management systems.

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

### 4. Local Processing
All transcription happens on your machine using OpenAI Whisper. Your audio never leaves your computer—important for confidential interviews, proprietary content, and sensitive recordings.

## Target Users

1. **AI/ML Engineers** - Building RAG systems, training data pipelines, and LLM applications
2. **Researchers** - Converting interviews and lectures into searchable, analyzable data
3. **Content Creators** - Generating show notes, blog posts, and repurposed content from podcasts/videos
4. **Knowledge Workers** - Building personal knowledge bases in Obsidian, Notion, or similar tools
5. **Data Teams** - Extracting structured data from audio/video archives

## The Data Preparation Workflow

```
┌─────────────────────────────────────────────────────────────────┐
│                      Audio/Video Source                          │
│         Files, YouTube, Podcasts, Tab Recording                  │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    SpeakToText Local                             │
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
```

## Long-Term Vision

### Version 2.0 - Cloud Platform
- User accounts with OAuth authentication
- Cloud storage for transcripts and media (Supabase backend)
- Transcript library with search and organization
- Sharing and collaboration features
- API access for automated workflows

### Version 2.5 - Custom Models
- Fine-tune Whisper on domain-specific vocabulary
- Custom speaker voice profiles
- Industry-specific terminology support

### Future Integrations
- Direct export to Notion, Obsidian, Google Docs
- Webhook support for automation (Zapier, n8n)
- CLI tool for batch processing
- Desktop app (Electron/Tauri)

## What Sets Us Apart

| Feature | Cloud Services | SpeakToText Local |
|---------|---------------|-------------------|
| Data Location | Their servers | Your machine |
| Export Formats | Limited | MD, JSON, SRT, VTT, TXT |
| Metadata | Basic | Rich, customizable |
| AI Integration | Proprietary | Open formats |
| Cost | Per-minute pricing | Free (open source) |
| Customization | None | Model selection, templates |

## Current Version: 1.4.0

This release focuses on AI-ready data preparation:
- JSON export with full metadata schema
- Enhanced Markdown with YAML frontmatter
- Metadata enrichment (source, duration, speakers, timestamps)
- Multiple export format options
- Edit transcripts before export
