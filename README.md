# SpeakToText Local

A privacy-focused audio transcription Chrome extension that runs entirely on your machine. No audio is ever sent to external servers.

## Features

- **File Upload**: Transcribe audio/video files (MP3, WAV, M4A, MP4, etc.)
- **URL Support**: Transcribe from YouTube, podcasts, and other audio URLs
- **Tab Recording**: Record and transcribe audio playing in browser tabs
- **Speaker Diarization**: Identify who is speaking (optional, requires free Hugging Face account)
- **Multiple Models**: Choose accuracy vs. speed with different Whisper models
- **100% Local**: All processing happens on your machine

## Requirements

- Python 3.9 or higher
- ffmpeg
- Google Chrome

## Installation

### macOS / Linux

```bash
# Clone or download this folder
cd speaktotext-local

# Run the installer
./install.sh
```

### Windows

```batch
# Double-click install.bat
# Or run from Command Prompt:
install.bat
```

### Manual Installation

1. Create a Python virtual environment:
   ```bash
   cd server
   python3 -m venv venv
   source venv/bin/activate  # Windows: venv\Scripts\activate
   pip install -r requirements.txt
   ```

2. Install the Chrome extension:
   - Open Chrome and go to `chrome://extensions`
   - Enable "Developer mode" (top right)
   - Click "Load unpacked"
   - Select the `extension` folder

## Usage

### Start the Server

```bash
./start-server.sh  # macOS/Linux
start-server.bat   # Windows
```

The server runs on `http://localhost:5123`

### Use the Extension

1. Click the SpeakToText Local icon in Chrome
2. Choose your input method:
   - **File**: Upload an audio/video file
   - **URL**: Enter a YouTube or podcast URL
   - **Record Tab**: Record audio from the current tab
3. Select a Whisper model (Base is recommended)
4. Click Transcribe

### Enable Speaker Diarization (Optional)

To identify different speakers:

1. Create a free account at [huggingface.co](https://huggingface.co/join)
2. Go to Settings → Access Tokens → Create new token (Read access)
3. Accept the terms at [pyannote/speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1)
4. In the extension, click Settings and paste your token

## Whisper Models

| Model | Speed | Accuracy | VRAM |
|-------|-------|----------|------|
| Tiny | Fastest | Basic | ~1GB |
| Base | Fast | Good | ~1GB |
| Small | Medium | Better | ~2GB |
| Medium | Slow | High | ~5GB |
| Large | Slowest | Best | ~10GB |

## Publishing to Chrome Web Store

To publish this extension:

1. Create a Chrome Developer account ($5 one-time fee)
2. Zip the `extension` folder
3. Upload to the Chrome Developer Dashboard
4. Add store listing information
5. Submit for review

**Important**: Update the README/description to clearly explain that users must:
- Download and run the local Python server
- The extension alone won't work without the server

## Troubleshooting

### "Server not running"
Make sure you've started the server with `./start-server.sh`

### Slow transcription
- Use a smaller model (Tiny or Base)
- For Apple Silicon Macs, the server uses GPU acceleration automatically

### ffmpeg errors
Make sure ffmpeg is installed:
- macOS: `brew install ffmpeg`
- Ubuntu: `sudo apt install ffmpeg`
- Windows: Download from ffmpeg.org and add to PATH

## License

MIT License

## Credits

- [OpenAI Whisper](https://github.com/openai/whisper) - Speech recognition
- [pyannote.audio](https://github.com/pyannote/pyannote-audio) - Speaker diarization
- [FastAPI](https://fastapi.tiangolo.com/) - API server
