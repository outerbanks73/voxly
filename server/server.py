#!/usr/bin/env python3
"""
Voxly - Python Server (formerly SpeakToText Local)

A FastAPI server that provides audio transcription with speaker diarization.
Supports instant YouTube transcript extraction and local Whisper transcription.
Designed to work with the Voxly Chrome extension.

Usage:
    python server.py
    # Server runs on http://localhost:5123
"""

import os
import sys
import tempfile
import subprocess
import hashlib
import time
import re
import threading
import secrets
from pathlib import Path
from typing import Optional
import json

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, BackgroundTasks, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import uvicorn
from urllib.parse import urlparse, parse_qs

# YouTube transcript extraction
try:
    from youtube_transcript_api import YouTubeTranscriptApi, TranscriptsDisabled, NoTranscriptFound
    YOUTUBE_TRANSCRIPT_AVAILABLE = True
except ImportError:
    YOUTUBE_TRANSCRIPT_AVAILABLE = False

# ============================================================
# Authentication
# ============================================================

AUTH_TOKEN_FILE = Path.home() / ".voxly" / "auth_token"

def load_or_create_auth_token() -> str:
    """Load auth token from file, or create one if it doesn't exist."""
    AUTH_TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    if AUTH_TOKEN_FILE.exists():
        token = AUTH_TOKEN_FILE.read_text().strip()
        if token:
            return token
    token = secrets.token_hex(32)
    AUTH_TOKEN_FILE.write_text(token)
    AUTH_TOKEN_FILE.chmod(0o600)
    return token

AUTH_TOKEN = load_or_create_auth_token()

async def verify_auth(request: Request):
    """Verify Bearer token on protected endpoints."""
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing auth token. Copy token from ~/.voxly/auth_token into extension settings.")
    if auth_header[7:] != AUTH_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid auth token")

app = FastAPI(
    title="Voxly",
    description="Instant transcripts - YouTube extraction and local Whisper transcription with speaker diarization",
    version="1.9.1"
)

# Allow CORS for Chrome extension
# Wildcard origin is kept because Chrome extension IDs are unstable for dev-loaded extensions.
# Security is enforced via the Bearer token in verify_auth, not via origin checks.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global state for job tracking
jobs = {}
MAX_JOBS = 100
MAX_JOB_AGE = 3600  # 1 hour

def sanitize_error_message(msg: str) -> str:
    """Strip absolute paths and sensitive info from error messages."""
    import re
    # Remove absolute file paths
    msg = re.sub(r'(/[^\s:]+/)+[^\s:]*', '<path>', msg)
    # Remove HF tokens
    msg = re.sub(r'hf_[a-zA-Z0-9]{10,}', '<redacted>', msg)
    return msg[:500]

def cleanup_old_jobs():
    """Remove completed/errored jobs older than MAX_JOB_AGE."""
    now = time.time()
    to_remove = [
        jid for jid, job in jobs.items()
        if job.get('status') in ('completed', 'error')
        and now - job.get('started_at', now) > MAX_JOB_AGE
    ]
    for jid in to_remove:
        del jobs[jid]

# Settings file for persistent configuration
SETTINGS_FILE = Path(__file__).parent / "settings.json"

def load_settings():
    """Load settings from file."""
    if SETTINGS_FILE.exists():
        try:
            with open(SETTINGS_FILE) as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    return {}

def save_settings(settings):
    """Save settings to file."""
    with open(SETTINGS_FILE, 'w') as f:
        json.dump(settings, f, indent=2)

def validate_storage_path(folder: str) -> Path:
    """Validate a storage path is safe (no traversal, under home dir)."""
    path = Path(folder).resolve()
    home = Path.home().resolve()
    if '..' in folder:
        raise ValueError("Path must not contain '..'")
    if not str(path).startswith(str(home)):
        raise ValueError("Storage path must be under the user's home directory")
    return path

def get_cache_dir():
    """Get the cache directory, respecting user settings."""
    settings = load_settings()
    custom_folder = settings.get('storage_folder', '').strip()
    if custom_folder:
        try:
            cache_path = validate_storage_path(custom_folder)
            cache_path.mkdir(parents=True, exist_ok=True)
            return cache_path
        except ValueError:
            print(f"[WARNING] Invalid storage path '{custom_folder}', using default")
    return Path(tempfile.gettempdir()) / "speaktotext_cache"

# Cache directory for downloaded audio
CACHE_DIR = get_cache_dir()
CACHE_DIR.mkdir(exist_ok=True)
CACHE_MAX_AGE = 24 * 60 * 60  # 24 hours in seconds

# Path to the worker script
WORKER_SCRIPT = Path(__file__).parent / "worker.py"

# Use the same Python interpreter that's running this server
# (start-server.sh activates venv before running, so sys.executable is correct)
PYTHON_EXECUTABLE = sys.executable

# Model processing speeds (real-time multiplier on CPU)
# e.g., tiny processes 32x faster than real-time
MODEL_SPEEDS = {
    'tiny': 32,
    'tiny.en': 32,
    'base': 16,
    'base.en': 16,
    'small': 6,
    'small.en': 6,
    'medium': 2,
    'medium.en': 2,
    'large': 1,
    'large-v2': 1,
    'large-v3': 1,
}

def format_duration(seconds: int) -> str:
    """Format seconds into human-readable duration."""
    if seconds < 60:
        return f"{seconds} seconds"
    elif seconds < 3600:
        mins = seconds // 60
        return f"{mins} minute{'s' if mins != 1 else ''}"
    else:
        hours = seconds // 3600
        mins = (seconds % 3600) // 60
        if mins > 0:
            return f"{hours}h {mins}m"
        return f"{hours} hour{'s' if hours != 1 else ''}"

def select_optimal_model(duration_seconds: int) -> str:
    """Select the best model based on video duration.

    Strategy: Use highest quality model that completes in reasonable time.
    - Short videos (<10 min): base (good quality, fast enough)
    - Medium videos (10-30 min): base (still reasonable)
    - Long videos (30-60 min): tiny (speed over quality)
    - Very long (>60 min): tiny (must be fast)
    """
    if duration_seconds <= 600:  # <= 10 minutes
        return 'base'
    elif duration_seconds <= 1800:  # <= 30 minutes
        return 'base'
    elif duration_seconds <= 3600:  # <= 60 minutes
        return 'tiny'
    else:  # > 60 minutes
        return 'tiny'

def calculate_timeout(duration_seconds: int, model: str) -> int:
    """Calculate appropriate timeout based on video duration and model.

    Formula: (duration / model_speed) * 1.5 + 180
    - 1.5x safety margin for slower CPUs
    - 180s buffer for download/conversion overhead
    """
    speed = MODEL_SPEEDS.get(model, 16)  # default to base speed
    process_time = duration_seconds / speed
    timeout = int((process_time * 1.5) + 180)
    # Min 5 minutes, max 4 hours
    return max(300, min(timeout, 14400))

def calculate_estimates(duration_seconds: int) -> dict:
    """Calculate estimated transcription time for each model."""
    estimates = {}
    for model in ['tiny', 'base', 'small', 'medium', 'large']:
        speed = MODEL_SPEEDS.get(model, 16)
        process_time = int(duration_seconds / speed) + 30  # 30s buffer
        estimates[model] = {
            'seconds': process_time,
            'formatted': format_duration(process_time)
        }
    return estimates


def cleanup_cache():
    """Remove cached files older than CACHE_MAX_AGE."""
    try:
        now = time.time()
        for cache_file in CACHE_DIR.glob("*.mp3"):
            if now - cache_file.stat().st_mtime > CACHE_MAX_AGE:
                cache_file.unlink(missing_ok=True)
    except OSError:
        pass  # Ignore cache cleanup errors (permissions, missing files, etc.)


# ============================================================
# YouTube Transcript Extraction
# ============================================================

def extract_youtube_video_id(url: str) -> Optional[str]:
    """Extract YouTube video ID from various URL formats.

    Supports:
    - youtube.com/watch?v=VIDEO_ID
    - youtu.be/VIDEO_ID
    - youtube.com/embed/VIDEO_ID
    - youtube.com/v/VIDEO_ID
    - youtube.com/shorts/VIDEO_ID
    """
    if not url:
        return None

    parsed = urlparse(url)

    if parsed.hostname in ('www.youtube.com', 'youtube.com', 'm.youtube.com'):
        if parsed.path == '/watch':
            return parse_qs(parsed.query).get('v', [None])[0]
        elif parsed.path.startswith('/embed/'):
            return parsed.path.split('/')[2].split('?')[0]
        elif parsed.path.startswith('/v/'):
            return parsed.path.split('/')[2].split('?')[0]
        elif parsed.path.startswith('/shorts/'):
            return parsed.path.split('/')[2].split('?')[0]
    elif parsed.hostname == 'youtu.be':
        return parsed.path[1:].split('?')[0]  # Remove leading slash and query params

    return None


def check_youtube_transcript(video_id: str) -> dict:
    """Check if YouTube transcript is available and return metadata.

    Returns:
        {
            'available': bool,
            'transcripts': [
                {
                    'language': 'English',
                    'language_code': 'en',
                    'is_generated': bool,
                    'is_translatable': bool
                }
            ],
            'error': str or None
        }
    """
    if not YOUTUBE_TRANSCRIPT_AVAILABLE:
        return {
            'available': False,
            'transcripts': [],
            'error': 'youtube-transcript-api not installed'
        }

    try:
        transcript_list = YouTubeTranscriptApi.list_transcripts(video_id)

        transcripts = []
        for transcript in transcript_list:
            transcripts.append({
                'language': transcript.language,
                'language_code': transcript.language_code,
                'is_generated': transcript.is_generated,
                'is_translatable': transcript.is_translatable
            })

        return {
            'available': len(transcripts) > 0,
            'transcripts': transcripts,
            'error': None
        }
    except TranscriptsDisabled:
        return {
            'available': False,
            'transcripts': [],
            'error': 'Transcripts are disabled for this video'
        }
    except NoTranscriptFound:
        return {
            'available': False,
            'transcripts': [],
            'error': 'No transcript found for this video'
        }
    except Exception as e:
        return {
            'available': False,
            'transcripts': [],
            'error': str(e)
        }


def format_transcript_timestamp(seconds: float) -> str:
    """Format seconds to MM:SS or HH:MM:SS timestamp."""
    total_seconds = int(seconds)
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    secs = total_seconds % 60

    if hours > 0:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def get_cache_path(url: str) -> Path:
    """Get cache file path for a URL."""
    url_hash = hashlib.sha256(url.encode()).hexdigest()[:12]
    return CACHE_DIR / f"{url_hash}.mp3"


def download_audio_from_url(url: str, job_id: str = None) -> str:
    """Download audio from URL using yt-dlp with optimizations."""
    # Check cache first
    cache_path = get_cache_path(url)
    if cache_path.exists():
        cache_age = time.time() - cache_path.stat().st_mtime
        if cache_age < CACHE_MAX_AGE:
            if job_id:
                jobs[job_id]['progress'] = 'Using cached audio...'
            return str(cache_path)

    # Cleanup old cache files
    cleanup_cache()

    temp_dir = tempfile.mkdtemp()
    output_path = os.path.join(temp_dir, "audio.%(ext)s")

    try:
        if job_id:
            jobs[job_id]['progress'] = 'Downloading audio...'
            jobs[job_id]['stage'] = 'downloading'
            jobs[job_id]['download_percent'] = 0

        # Optimized yt-dlp command (use android client to avoid YouTube 403 errors)
        process = subprocess.Popen(
            [
                'yt-dlp', '-x',
                '--audio-format', 'mp3',
                '--audio-quality', '128K',
                '--socket-timeout', '30',
                '--extractor-args', 'youtube:player_client=android',
                '--newline',
                '-o', output_path,
                url
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True
        )

        # Parse progress from output
        try:
            for line in process.stdout:
                if job_id and '[download]' in line:
                    match = re.search(r'(\d+\.?\d*)%', line)
                    if match:
                        percent = float(match.group(1))
                        jobs[job_id]['download_percent'] = int(percent)
                        jobs[job_id]['progress'] = f'Downloading audio... {int(percent)}%'
        except Exception:
            pass

        process.wait(timeout=600)

        if process.returncode != 0:
            raise Exception(f"yt-dlp failed with exit code {process.returncode}")

        # Find the downloaded file
        audio_file = None
        for f in os.listdir(temp_dir):
            if f.startswith("audio"):
                audio_file = os.path.join(temp_dir, f)
                break

        if not audio_file:
            raise Exception("Download completed but audio file not found")

        # Copy to cache
        import shutil
        shutil.copy2(audio_file, cache_path)

        if job_id:
            jobs[job_id]['progress'] = 'Download complete'
            jobs[job_id]['download_percent'] = 100

        return audio_file

    except subprocess.TimeoutExpired:
        process.kill()
        raise Exception("Download timed out after 10 minutes")
    except FileNotFoundError:
        raise Exception("yt-dlp not installed. Please install it with: brew install yt-dlp")


def run_transcription_worker(job_id: str, audio_path: str, hf_token: Optional[str], model_name: str, timeout: int = 1800):
    """Run transcription in a separate subprocess to avoid stdout/stderr issues."""
    try:
        jobs[job_id]['status'] = 'processing'
        jobs[job_id]['stage'] = 'transcribing'

        # Show model being used and estimated time if available
        estimated_time = jobs[job_id].get('estimated_time')
        if estimated_time:
            jobs[job_id]['progress'] = f'Transcribing with {model_name} (~{format_duration(estimated_time)} remaining)...'
        else:
            jobs[job_id]['progress'] = f'Transcribing with {model_name}...'

        # Verify audio file exists before starting worker
        if not Path(audio_path).exists():
            raise Exception(f"Audio file not found: {audio_path}")

        print(f"[TRANSCRIBE] Processing: {audio_path}")

        # Build command to run worker script
        cmd = [
            PYTHON_EXECUTABLE,
            str(WORKER_SCRIPT),
            '--audio', audio_path,
            '--model', model_name,
            '--job-id', job_id
        ]

        # Pass HF token via environment variable (not CLI arg, which is visible in ps)
        env = os.environ.copy()
        if hf_token:
            env['HF_TOKEN'] = hf_token

        # Run worker in subprocess with dynamic timeout
        # Capture stderr for diagnostic logging
        result = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
            env=env
        )

        # Log worker stderr for debugging (especially diarization issues)
        if result.stderr:
            for line in result.stderr.strip().split('\n'):
                if line.strip():
                    print(f"[WORKER] {line}")

        if result.returncode != 0:
            error_msg = result.stderr or result.stdout or "Transcription failed"
            raise Exception(error_msg[:500])

        # Parse result from stdout (worker outputs JSON)
        try:
            output = json.loads(result.stdout)
            if output.get('error'):
                raise Exception(output['error'])

            jobs[job_id]['status'] = 'completed'
            jobs[job_id]['stage'] = 'complete'
            jobs[job_id]['progress'] = 'Done!'
            jobs[job_id]['result'] = output['result']
            jobs[job_id]['language'] = output.get('language', 'unknown')
        except json.JSONDecodeError:
            raise Exception(f"Worker output parsing failed: {result.stdout[:200]}")

    except subprocess.TimeoutExpired:
        jobs[job_id]['status'] = 'error'
        duration = jobs[job_id].get('duration_seconds')
        if duration:
            jobs[job_id]['error'] = f'Transcription timed out for this {format_duration(duration)} video. This is unusual - please try again.'
        else:
            jobs[job_id]['error'] = f'Transcription timed out after {format_duration(timeout)}. Try with a shorter video.'
    except Exception as e:
        jobs[job_id]['status'] = 'error'
        jobs[job_id]['error'] = sanitize_error_message(str(e))

        # Provide helpful error messages
        error_str = str(e).lower()
        if 'token' in error_str or 'auth' in error_str:
            jobs[job_id]['error_hint'] = 'Your Hugging Face token may be invalid.'
        elif 'access' in error_str or 'denied' in error_str:
            jobs[job_id]['error_hint'] = 'Please accept the model licenses at huggingface.co'
        elif 'no such file' in error_str or 'errno 2' in error_str:
            jobs[job_id]['error_hint'] = 'Audio file was not found. Try again.'
    # Note: Don't cleanup temp files here - worker.py handles its own cleanup
    # and cached files (in speaktotext_cache) should persist for reuse


def process_transcription_thread(job_id: str, audio_path: str, hf_token: Optional[str], model_name: str):
    """Background thread that runs the transcription worker."""
    run_transcription_worker(job_id, audio_path, hf_token, model_name)


def process_url_transcription(job_id: str, url: str, hf_token: Optional[str], model_name: str, timeout: int = 1800):
    """Background task for URL download and transcription."""
    try:
        jobs[job_id]['status'] = 'downloading'
        audio_path = download_audio_from_url(url, job_id)
        run_transcription_worker(job_id, audio_path, hf_token, model_name, timeout)
    except Exception as e:
        jobs[job_id]['status'] = 'error'
        duration = jobs[job_id].get('duration_seconds')
        model = jobs[job_id].get('model', model_name)
        if 'timeout' in str(e).lower():
            # Provide helpful error for timeouts
            if duration:
                jobs[job_id]['error'] = f"Transcription timed out for this {format_duration(duration)} video using {model} model. The video may be too long for this model."
            else:
                jobs[job_id]['error'] = f"Transcription timed out. Try with a shorter video."
        else:
            jobs[job_id]['error'] = sanitize_error_message(str(e))


@app.get("/")
async def root():
    """Health check endpoint."""
    return {"status": "ok", "service": "Voxly", "version": "1.9.1"}


@app.get("/health")
async def health():
    """Health check for extension to verify server is running."""
    return {"status": "ok"}


@app.get("/auth/token")
async def get_auth_token(request: Request):
    """Return auth token to Chrome extensions for auto-configuration.

    Only responds to requests with a chrome-extension:// Origin header,
    which browsers enforce and web pages cannot spoof.
    """
    origin = request.headers.get("Origin", "")
    if not origin.startswith("chrome-extension://"):
        raise HTTPException(status_code=403, detail="Only Chrome extensions can auto-fetch the token")
    return {"token": AUTH_TOKEN}


@app.post("/transcribe/file")
async def transcribe_file(
    file: UploadFile = File(...),
    hf_token: Optional[str] = Form(None),
    model: str = Form("base"),
    _auth=Depends(verify_auth)
):
    """Transcribe an uploaded audio file."""
    cleanup_old_jobs()
    if len(jobs) >= MAX_JOBS:
        raise HTTPException(status_code=429, detail="Too many active jobs. Please wait for existing jobs to complete.")

    MAX_UPLOAD_SIZE = 500 * 1024 * 1024  # 500 MB

    # Save uploaded file
    temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=Path(file.filename).suffix)
    content = await file.read()
    if len(content) > MAX_UPLOAD_SIZE:
        raise HTTPException(status_code=413, detail=f"File too large. Maximum size is {MAX_UPLOAD_SIZE // (1024*1024)} MB.")
    temp_file.write(content)
    temp_file.close()

    # Create job
    import uuid
    job_id = str(uuid.uuid4())
    jobs[job_id] = {
        'status': 'queued',
        'progress': 'Starting...',
        'filename': file.filename
    }

    # Start background thread
    thread = threading.Thread(
        target=process_transcription_thread,
        args=(job_id, temp_file.name, hf_token, model)
    )
    thread.start()

    return {"job_id": job_id, "status": "queued"}


# Real-time transcription state
realtime_sessions = {}


@app.post("/transcribe/realtime/start")
async def start_realtime(model: str = Form("tiny"), _auth=Depends(verify_auth)):
    """Start a real-time transcription session."""
    cleanup_old_jobs()
    import uuid
    session_id = str(uuid.uuid4())
    realtime_sessions[session_id] = {
        'model': model,
        'chunks': [],
        'transcripts': [],
        'status': 'active',
        'created': time.time()
    }
    return {"session_id": session_id, "status": "active"}


@app.post("/transcribe/realtime/chunk/{session_id}")
async def add_realtime_chunk(
    session_id: str,
    chunk: UploadFile = File(...),
    _auth=Depends(verify_auth)
):
    """Add an audio chunk to a real-time session and get transcription."""
    if session_id not in realtime_sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    session = realtime_sessions[session_id]
    if session['status'] != 'active':
        raise HTTPException(status_code=400, detail="Session not active")

    # Save chunk to temp file
    MAX_CHUNK_SIZE = 50 * 1024 * 1024  # 50 MB
    chunk_data = await chunk.read()
    if len(chunk_data) > MAX_CHUNK_SIZE:
        raise HTTPException(status_code=413, detail=f"Chunk too large. Maximum size is {MAX_CHUNK_SIZE // (1024*1024)} MB.")
    temp_file = tempfile.NamedTemporaryFile(delete=False, suffix='.webm')
    temp_file.write(chunk_data)
    temp_file.close()

    # Transcribe the chunk using worker subprocess
    # Dynamic timeout based on model size - larger models need more time
    model_timeouts = {
        'tiny': 60, 'tiny.en': 60,
        'base': 120, 'base.en': 120,
        'small': 180, 'small.en': 180,
        'medium': 300, 'medium.en': 300,
        'large': 600, 'large-v2': 600, 'large-v3': 600
    }
    chunk_timeout = model_timeouts.get(session['model'], 120)

    try:
        cmd = [
            PYTHON_EXECUTABLE,
            str(WORKER_SCRIPT),
            '--audio', temp_file.name,
            '--model', session['model'],
            '--job-id', f'realtime-{session_id}'
        ]

        result = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=chunk_timeout,
            env=os.environ.copy()
        )

        Path(temp_file.name).unlink(missing_ok=True)

        if result.returncode == 0:
            output = json.loads(result.stdout)
            if output.get('result'):
                transcript = output['result'].get('full_text', '')
                session['transcripts'].append(transcript)
                return {
                    "status": "ok",
                    "transcript": transcript,
                    "all_transcripts": session['transcripts']
                }

        return {"status": "ok", "transcript": "", "all_transcripts": session['transcripts']}

    except subprocess.TimeoutExpired:
        print(f"⚠️  Chunk transcription timed out after {chunk_timeout}s for model {session['model']}")
        Path(temp_file.name).unlink(missing_ok=True)
        return {"status": "error", "error": f"Chunk timeout after {chunk_timeout}s - try a faster model"}

    except Exception as e:
        Path(temp_file.name).unlink(missing_ok=True)
        return {"status": "error", "error": str(e)}


@app.post("/transcribe/realtime/stop/{session_id}")
async def stop_realtime(session_id: str, _auth=Depends(verify_auth)):
    """Stop a real-time transcription session."""
    if session_id not in realtime_sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    session = realtime_sessions[session_id]
    session['status'] = 'stopped'

    full_transcript = ' '.join(session['transcripts'])

    # Clean up old sessions (older than 1 hour)
    now = time.time()
    for sid in list(realtime_sessions.keys()):
        if now - realtime_sessions[sid].get('created', 0) > 3600:
            del realtime_sessions[sid]

    return {
        "status": "stopped",
        "full_transcript": full_transcript,
        "segments": session['transcripts']
    }


@app.post("/transcribe/preflight")
async def preflight_check(url: str = Form(...), _auth=Depends(verify_auth)):
    """Get video duration and metadata without downloading.

    Uses yt-dlp --dump-json to fetch metadata quickly.
    Returns duration, title, and estimated transcription times.
    """
    try:
        result = subprocess.run(
            ['yt-dlp', '--dump-json', '--no-download',
             '--extractor-args', 'youtube:player_client=android', url],
            capture_output=True,
            text=True,
            timeout=30
        )

        if result.returncode != 0:
            # Try to extract error message
            error_msg = result.stderr or "Failed to get video info"
            return {"error": error_msg, "duration_seconds": None}

        metadata = json.loads(result.stdout)
        duration_seconds = int(metadata.get('duration', 0))
        title = metadata.get('title', 'Unknown')
        uploader = metadata.get('uploader') or metadata.get('channel') or metadata.get('creator', '')
        upload_date = metadata.get('upload_date', '')  # Format: YYYYMMDD

        # Calculate estimates and select optimal model
        estimates = calculate_estimates(duration_seconds)
        recommended_model = select_optimal_model(duration_seconds)
        timeout = calculate_timeout(duration_seconds, recommended_model)

        response = {
            "duration_seconds": duration_seconds,
            "duration_formatted": format_duration(duration_seconds),
            "title": title,
            "uploader": uploader,
            "upload_date": upload_date,
            "estimates": estimates,
            "recommended_model": recommended_model,
            "timeout_seconds": timeout,
            "is_youtube": False,
            "youtube_transcript": None
        }

        # Check if this is a YouTube URL and if transcript is available
        video_id = extract_youtube_video_id(url)
        if video_id:
            response["is_youtube"] = True
            response["youtube_transcript"] = check_youtube_transcript(video_id)

        return response

    except subprocess.TimeoutExpired:
        return {"error": "Metadata fetch timed out", "duration_seconds": None}
    except json.JSONDecodeError:
        return {"error": "Failed to parse video metadata", "duration_seconds": None}
    except FileNotFoundError:
        return {"error": "yt-dlp not installed", "duration_seconds": None}
    except Exception as e:
        return {"error": str(e), "duration_seconds": None}


@app.post("/transcribe/youtube/transcript")
async def extract_youtube_transcript_endpoint(
    url: str = Form(...),
    language_code: Optional[str] = Form(None),
    _auth=Depends(verify_auth)
):
    """Extract existing YouTube transcript directly (instant).

    This is much faster than downloading and transcribing with Whisper,
    as it extracts the existing captions/subtitles from YouTube.

    Args:
        url: YouTube video URL
        language_code: Preferred language code (e.g., 'en', 'es').
                       If not specified, uses first available (prefers manual over auto).

    Returns:
        Result in same format as Whisper transcription for compatibility.
    """
    if not YOUTUBE_TRANSCRIPT_AVAILABLE:
        raise HTTPException(
            status_code=501,
            detail="youtube-transcript-api not installed. Run: pip install youtube-transcript-api"
        )

    video_id = extract_youtube_video_id(url)
    if not video_id:
        raise HTTPException(status_code=400, detail="Invalid YouTube URL")

    try:
        transcript_list = YouTubeTranscriptApi.list_transcripts(video_id)

        # Find the requested transcript
        transcript = None
        transcript_metadata = None

        if language_code:
            try:
                transcript = transcript_list.find_transcript([language_code])
            except NoTranscriptFound:
                # Fall back to any available transcript
                pass

        if not transcript:
            # Try to get manually created first, then auto-generated
            try:
                # Get all available language codes
                all_transcripts = list(transcript_list)
                manual_codes = [t.language_code for t in all_transcripts if not t.is_generated]
                auto_codes = [t.language_code for t in all_transcripts if t.is_generated]

                if manual_codes:
                    transcript = transcript_list.find_transcript(manual_codes)
                elif auto_codes:
                    transcript = transcript_list.find_transcript(auto_codes)
                else:
                    raise NoTranscriptFound(video_id, [], None)
            except NoTranscriptFound:
                raise HTTPException(
                    status_code=404,
                    detail="No transcript found for this video"
                )

        # Fetch the actual transcript data
        transcript_data = transcript.fetch()

        transcript_metadata = {
            'language': transcript.language,
            'language_code': transcript.language_code,
            'is_generated': transcript.is_generated
        }

        # Convert to our standard segment format
        segments = []
        for entry in transcript_data:
            start_seconds = entry['start']
            segments.append({
                'timestamp': format_transcript_timestamp(start_seconds),
                'text': entry['text'].strip().replace('\n', ' '),
                'start': start_seconds,
                'duration': entry.get('duration', 0)
            })

        # Build full text
        full_text = ' '.join([seg['text'] for seg in segments])

        return {
            "status": "completed",
            "result": {
                "segments": segments,
                "full_text": full_text
            },
            "language": transcript_metadata['language_code'],
            "transcript_type": "auto-generated" if transcript_metadata['is_generated'] else "manual",
            "source": "youtube_transcript"
        }

    except TranscriptsDisabled:
        raise HTTPException(
            status_code=404,
            detail="Transcripts are disabled for this video"
        )
    except NoTranscriptFound:
        raise HTTPException(
            status_code=404,
            detail="No transcript found for this video"
        )
    except HTTPException:
        raise  # Re-raise HTTP exceptions
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/transcribe/url")
async def transcribe_url(
    url: str = Form(...),
    hf_token: Optional[str] = Form(None),
    model: str = Form(None),
    duration_seconds: Optional[int] = Form(None),
    _auth=Depends(verify_auth)
):
    """Transcribe audio from a URL (YouTube, podcast, etc.)."""
    cleanup_old_jobs()
    if len(jobs) >= MAX_JOBS:
        raise HTTPException(status_code=429, detail="Too many active jobs. Please wait for existing jobs to complete.")

    import uuid

    # Smart model selection if not specified
    if not model or model == 'auto':
        if duration_seconds:
            model = select_optimal_model(duration_seconds)
        else:
            model = 'base'  # Safe default

    # Calculate dynamic timeout
    if duration_seconds:
        timeout = calculate_timeout(duration_seconds, model)
        estimated_time = int(duration_seconds / MODEL_SPEEDS.get(model, 16)) + 30
    else:
        timeout = 1800  # 30 min default if duration unknown
        estimated_time = None

    job_id = str(uuid.uuid4())
    jobs[job_id] = {
        'status': 'queued',
        'progress': 'Starting download...',
        'stage': 'queued',
        'download_percent': 0,
        'url': url,
        'model': model,
        'duration_seconds': duration_seconds,
        'timeout': timeout,
        'estimated_time': estimated_time,
        'started_at': time.time()
    }

    # Start background thread
    thread = threading.Thread(
        target=process_url_transcription,
        args=(job_id, url, hf_token, model, timeout)
    )
    thread.start()

    return {
        "job_id": job_id,
        "status": "queued",
        "model": model,
        "estimated_time": estimated_time,
        "timeout": timeout
    }


@app.get("/job/{job_id}")
async def get_job_status(job_id: str, _auth=Depends(verify_auth)):
    """Get the status of a transcription job."""
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    return jobs[job_id]


@app.delete("/job/{job_id}")
async def delete_job(job_id: str, _auth=Depends(verify_auth)):
    """Delete a completed job."""
    if job_id in jobs:
        del jobs[job_id]
    return {"status": "deleted"}


@app.get("/models")
async def list_models(_auth=Depends(verify_auth)):
    """List available Whisper models."""
    return {
        "models": [
            {"id": "tiny", "name": "Tiny", "description": "Fastest, least accurate (~1GB)"},
            {"id": "base", "name": "Base", "description": "Good balance (default)"},
            {"id": "small", "name": "Small", "description": "Better accuracy (~2GB)"},
            {"id": "medium", "name": "Medium", "description": "High accuracy (~5GB)"},
            {"id": "large", "name": "Large", "description": "Best accuracy (~10GB)"},
        ]
    }


@app.post("/settings/storage")
async def update_storage_settings(request: dict, _auth=Depends(verify_auth)):
    """Update storage folder setting."""
    global CACHE_DIR
    folder = request.get('folder', '').strip()

    if folder:
        try:
            validate_storage_path(folder)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    settings = load_settings()
    settings['storage_folder'] = folder
    save_settings(settings)

    # Update the cache directory
    CACHE_DIR = get_cache_dir()
    CACHE_DIR.mkdir(exist_ok=True)

    return {"status": "ok", "storage_folder": str(CACHE_DIR)}


@app.get("/settings")
async def get_settings(_auth=Depends(verify_auth)):
    """Get current settings."""
    settings = load_settings()
    return {
        "storage_folder": settings.get('storage_folder', ''),
        "current_cache_dir": str(CACHE_DIR)
    }


@app.post("/verify-token")
async def verify_token(hf_token: str = Form(...), _auth=Depends(verify_auth)):
    """Verify HuggingFace token and check access to diarization model.

    This endpoint tests if the token is valid and has access to the
    pyannote speaker diarization model.
    """
    if not hf_token:
        return {"valid": False, "error": "No token provided"}

    if not hf_token.startswith('hf_'):
        return {"valid": False, "error": "Invalid token format (should start with 'hf_')"}

    try:
        from huggingface_hub import HfApi

        api = HfApi(token=hf_token)

        # Try to access the diarization model info
        model_info = api.model_info("pyannote/speaker-diarization-3.1")

        return {
            "valid": True,
            "message": "Token valid and model accessible",
            "model_id": model_info.id,
            "gated": model_info.gated if hasattr(model_info, 'gated') else None
        }
    except Exception as e:
        error_msg = str(e)
        if "401" in error_msg or "unauthorized" in error_msg.lower():
            return {"valid": False, "error": "Invalid or expired token"}
        elif "403" in error_msg or "access" in error_msg.lower():
            return {
                "valid": False,
                "error": "Token valid but model access not granted. Please accept the license at https://huggingface.co/pyannote/speaker-diarization-3.1"
            }
        else:
            return {"valid": False, "error": error_msg}


def main():
    """Run the server."""
    print("=" * 60)
    print("Voxly Server")
    print("=" * 60)
    print()
    print("Server starting on http://localhost:5123")
    print()
    print(f"Auth token file: {AUTH_TOKEN_FILE}")
    print(f"Auth token: {AUTH_TOKEN}")
    print()
    print("Copy the auth token above into the Voxly extension settings.")
    print("Press Ctrl+C to stop the server.")
    print()

    uvicorn.run(app, host="127.0.0.1", port=5123, log_level="info")


if __name__ == "__main__":
    main()
