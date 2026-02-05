#!/usr/bin/env python3
"""
SpeakToText Local - Python Server

A FastAPI server that provides audio transcription with speaker diarization.
Designed to work with the SpeakToText Local Chrome extension.

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
from pathlib import Path
from typing import Optional
import json

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import uvicorn

app = FastAPI(
    title="SpeakToText Local",
    description="Local audio transcription server with speaker diarization",
    version="1.3.0"
)

# Allow CORS for Chrome extension
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Chrome extensions have unique origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global state for job tracking
jobs = {}

# Settings file for persistent configuration
SETTINGS_FILE = Path(__file__).parent / "settings.json"

def load_settings():
    """Load settings from file."""
    if SETTINGS_FILE.exists():
        try:
            with open(SETTINGS_FILE) as f:
                return json.load(f)
        except:
            pass
    return {}

def save_settings(settings):
    """Save settings to file."""
    with open(SETTINGS_FILE, 'w') as f:
        json.dump(settings, f, indent=2)

def get_cache_dir():
    """Get the cache directory, respecting user settings."""
    settings = load_settings()
    custom_folder = settings.get('storage_folder', '').strip()
    if custom_folder:
        cache_path = Path(custom_folder)
        cache_path.mkdir(parents=True, exist_ok=True)
        return cache_path
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
    except Exception:
        pass  # Ignore cache cleanup errors


def get_cache_path(url: str) -> Path:
    """Get cache file path for a URL."""
    url_hash = hashlib.md5(url.encode()).hexdigest()[:12]
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

        # Build command to run worker script
        cmd = [
            PYTHON_EXECUTABLE,
            str(WORKER_SCRIPT),
            '--audio', audio_path,
            '--model', model_name,
            '--job-id', job_id
        ]

        if hf_token:
            cmd.extend(['--hf-token', hf_token])

        # Run worker in subprocess with dynamic timeout
        result = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=timeout
        )

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
        jobs[job_id]['error'] = str(e)

        # Provide helpful error messages
        error_str = str(e).lower()
        if 'token' in error_str or 'auth' in error_str:
            jobs[job_id]['error_hint'] = 'Your Hugging Face token may be invalid.'
        elif 'access' in error_str or 'denied' in error_str:
            jobs[job_id]['error_hint'] = 'Please accept the model licenses at huggingface.co'
    finally:
        # Cleanup temp files
        if audio_path.startswith(tempfile.gettempdir()) and 'speaktotext_cache' not in audio_path:
            Path(audio_path).unlink(missing_ok=True)


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
            jobs[job_id]['error'] = str(e)


@app.get("/")
async def root():
    """Health check endpoint."""
    return {"status": "ok", "service": "SpeakToText Local", "version": "1.0.0"}


@app.get("/health")
async def health():
    """Health check for extension to verify server is running."""
    return {"status": "ok"}


@app.post("/transcribe/file")
async def transcribe_file(
    file: UploadFile = File(...),
    hf_token: Optional[str] = Form(None),
    model: str = Form("base")
):
    """Transcribe an uploaded audio file."""
    # Save uploaded file
    temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=Path(file.filename).suffix)
    content = await file.read()
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
async def start_realtime(model: str = Form("tiny")):
    """Start a real-time transcription session."""
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
    chunk: UploadFile = File(...)
):
    """Add an audio chunk to a real-time session and get transcription."""
    if session_id not in realtime_sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    session = realtime_sessions[session_id]
    if session['status'] != 'active':
        raise HTTPException(status_code=400, detail="Session not active")

    # Save chunk to temp file
    chunk_data = await chunk.read()
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
            timeout=chunk_timeout
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
async def stop_realtime(session_id: str):
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
async def preflight_check(url: str = Form(...)):
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

        # Calculate estimates and select optimal model
        estimates = calculate_estimates(duration_seconds)
        recommended_model = select_optimal_model(duration_seconds)
        timeout = calculate_timeout(duration_seconds, recommended_model)

        return {
            "duration_seconds": duration_seconds,
            "duration_formatted": format_duration(duration_seconds),
            "title": title,
            "estimates": estimates,
            "recommended_model": recommended_model,
            "timeout_seconds": timeout
        }

    except subprocess.TimeoutExpired:
        return {"error": "Metadata fetch timed out", "duration_seconds": None}
    except json.JSONDecodeError:
        return {"error": "Failed to parse video metadata", "duration_seconds": None}
    except FileNotFoundError:
        return {"error": "yt-dlp not installed", "duration_seconds": None}
    except Exception as e:
        return {"error": str(e), "duration_seconds": None}


@app.post("/transcribe/url")
async def transcribe_url(
    url: str = Form(...),
    hf_token: Optional[str] = Form(None),
    model: str = Form(None),
    duration_seconds: Optional[int] = Form(None)
):
    """Transcribe audio from a URL (YouTube, podcast, etc.)."""
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
async def get_job_status(job_id: str):
    """Get the status of a transcription job."""
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    return jobs[job_id]


@app.delete("/job/{job_id}")
async def delete_job(job_id: str):
    """Delete a completed job."""
    if job_id in jobs:
        del jobs[job_id]
    return {"status": "deleted"}


@app.get("/models")
async def list_models():
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
async def update_storage_settings(request: dict):
    """Update storage folder setting."""
    global CACHE_DIR
    folder = request.get('folder', '').strip()

    settings = load_settings()
    settings['storage_folder'] = folder
    save_settings(settings)

    # Update the cache directory
    CACHE_DIR = get_cache_dir()
    CACHE_DIR.mkdir(exist_ok=True)

    return {"status": "ok", "storage_folder": str(CACHE_DIR)}


@app.get("/settings")
async def get_settings():
    """Get current settings."""
    settings = load_settings()
    return {
        "storage_folder": settings.get('storage_folder', ''),
        "current_cache_dir": str(CACHE_DIR)
    }


def main():
    """Run the server."""
    print("=" * 60)
    print("SpeakToText Local Server")
    print("=" * 60)
    print()
    print("Server starting on http://localhost:5123")
    print()
    print("Make sure the Chrome extension is configured to connect to this address.")
    print("Press Ctrl+C to stop the server.")
    print()

    uvicorn.run(app, host="127.0.0.1", port=5123, log_level="info")


if __name__ == "__main__":
    main()
