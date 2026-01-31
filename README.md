# 🎙️ SpeakToText Local

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Python 3.9+](https://img.shields.io/badge/python-3.9+-blue.svg)](https://www.python.org/downloads/)
[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-green.svg)](https://developer.chrome.com/docs/extensions/)

**A privacy-focused audio transcription Chrome extension that runs entirely on your machine.** No audio is ever sent to external servers.

<p align="center">
  <img src="https://img.shields.io/badge/Powered%20by-OpenAI%20Whisper-orange" alt="Powered by Whisper">
  <img src="https://img.shields.io/badge/Speaker%20ID-pyannote.audio-purple" alt="Speaker diarization">
</p>

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 📁 **File Upload** | Transcribe audio/video files (MP3, WAV, M4A, MP4, FLAC, etc.) |
| 🔗 **URL Support** | Transcribe from YouTube, podcasts, and other audio URLs |
| 🎬 **Tab Recording** | Record and transcribe audio playing in browser tabs |
| 👥 **Speaker Diarization** | Identify who is speaking (optional, requires free Hugging Face account) |
| ⚡ **Multiple Models** | Choose accuracy vs. speed with different Whisper models |
| 🔒 **100% Local** | All processing happens on your machine - complete privacy |

---

## 🖥️ Screenshots

```
┌─────────────────────────────────────┐
│  🎙️ SpeakToText Local              │
│  Private audio transcription        │
│                                     │
│  ┌─────┐ ┌─────┐ ┌───────────┐     │
│  │File │ │ URL │ │Record Tab │     │
│  └─────┘ └─────┘ └───────────┘     │
│                                     │
│  📁 Click or drag file here         │
│                                     │
│  Model: [Base (recommended) ▼]      │
│                                     │
│  [    Transcribe File    ]          │
└─────────────────────────────────────┘
```

---

## 📋 Requirements

- **Python 3.9** or higher
- **ffmpeg** (for audio conversion)
- **Google Chrome** browser

---

## 🚀 Quick Start

### 1. Download

```bash
git clone https://github.com/outerbanks73/speaktotext-local.git
cd speaktotext-local
```

Or [download the ZIP](https://github.com/outerbanks73/speaktotext-local/archive/refs/heads/main.zip) and extract it.

### 2. Install

**macOS / Linux:**
```bash
./install.sh
```

**Windows:**
```batch
install.bat
```

This will:
- Create a Python virtual environment
- Install all dependencies (Whisper, pyannote, etc.)
- Create a launcher script

### 3. Start the Server

```bash
./start-server.sh      # macOS/Linux
start-server.bat       # Windows
```

The server runs on `http://localhost:5123`

### 4. Install Chrome Extension

1. Open Chrome and go to `chrome://extensions`
2. Enable **"Developer mode"** (toggle in top right)
3. Click **"Load unpacked"**
4. Select the `extension` folder from this project

### 5. Use It!

1. Click the SpeakToText Local icon in Chrome toolbar
2. Choose your input method (File, URL, or Record Tab)
3. Select a Whisper model
4. Click Transcribe
5. Copy or download your transcript

---

## 👥 Enable Speaker Diarization (Optional)

To identify different speakers in your audio:

1. Create a free account at [huggingface.co](https://huggingface.co/join)
2. Go to [Settings → Access Tokens](https://huggingface.co/settings/tokens)
3. Create a new token with **"Read"** access
4. Accept the model terms at [pyannote/speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1)
5. In the extension, click **Settings** and paste your token

---

## 🎛️ Whisper Models

| Model | Speed | Accuracy | Memory |
|-------|-------|----------|--------|
| `tiny` | ⚡⚡⚡⚡⚡ | ⭐ | ~1GB |
| `base` | ⚡⚡⚡⚡ | ⭐⭐ | ~1GB |
| `small` | ⚡⚡⚡ | ⭐⭐⭐ | ~2GB |
| `medium` | ⚡⚡ | ⭐⭐⭐⭐ | ~5GB |
| `large` | ⚡ | ⭐⭐⭐⭐⭐ | ~10GB |

**Recommendation:** Start with `base` for a good balance. Use `tiny` for quick drafts, `medium` or `large` for important transcriptions.

---

## 🔧 Manual Installation

If the installer doesn't work, you can set up manually:

```bash
# Create virtual environment
cd server
python3 -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Start server
python server.py
```

---

## 🐛 Troubleshooting

### "Server not running"
Make sure you've started the server with `./start-server.sh`

### "Address already in use"
Another process is using port 5123. Kill it with:
```bash
lsof -ti:5123 | xargs kill -9   # macOS/Linux
netstat -ano | findstr :5123    # Windows (then kill the PID)
```

### Slow transcription
- Use a smaller model (`tiny` or `base`)
- Apple Silicon Macs automatically use GPU acceleration

### ffmpeg errors
Make sure ffmpeg is installed:
```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt install ffmpeg

# Windows
# Download from https://ffmpeg.org/download.html and add to PATH
```

### Speaker diarization not working
1. Verify your Hugging Face token is correct
2. Make sure you accepted the model terms at the pyannote link
3. Check the server console for error messages

---

## 📁 Project Structure

```
speaktotext-local/
├── extension/           # Chrome extension
│   ├── manifest.json
│   ├── popup.html/js    # Main UI
│   ├── options.html/js  # Settings page
│   ├── background.js
│   └── icons/
├── server/
│   ├── server.py        # FastAPI server
│   └── requirements.txt
├── install.sh           # macOS/Linux installer
├── install.bat          # Windows installer
└── start-server.sh      # Server launcher
```

---

## 🛡️ Privacy

**Your audio never leaves your machine.**

- All transcription is done locally using OpenAI Whisper
- Speaker diarization runs locally using pyannote.audio
- The only external connection is to Hugging Face to download model weights (one-time)
- URL transcription uses yt-dlp to download audio locally before processing

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

## 🙏 Credits

- [OpenAI Whisper](https://github.com/openai/whisper) - Speech recognition
- [pyannote.audio](https://github.com/pyannote/pyannote-audio) - Speaker diarization
- [FastAPI](https://fastapi.tiangolo.com/) - API server
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) - URL audio extraction

---

<p align="center">
  Made with ❤️ for privacy-conscious transcription
</p>
