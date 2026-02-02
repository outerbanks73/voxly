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
    version="1.0.0"
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

# Cache directory for downloaded audio
CACHE_DIR = Path(tempfile.gettempdir()) / "speaktotext_cache"
CACHE_DIR.mkdir(exist_ok=True)
CACHE_MAX_AGE = 24 * 60 * 60  # 24 hours in seconds

# Path to the worker script
WORKER_SCRIPT = Path(__file__).parent / "worker.py"

# Find the correct Python interpreter (handle venv)
def get_python_executable():
    """Get the Python executable, preferring venv if active."""
    # Check if we're in a venv
    venv_python = Path(__file__).parent / "venv" / "bin" / "python"
    if venv_python.exists():
        return str(venv_python)
    # Fall back to current interpreter
    return sys.executable

PYTHON_EXECUTABLE = get_python_executable()


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

        # Optimized yt-dlp command
        process = subprocess.Popen(
            [
                'yt-dlp', '-x',
                '--audio-format', 'mp3',
                '--audio-quality', '128K',
                '--socket-timeout', '30',
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


def run_transcription_worker(job_id: str, audio_path: str, hf_token: Optional[str], model_name: str):
    """Run transcription in a separate subprocess to avoid stdout/stderr issues."""
    try:
        jobs[job_id]['status'] = 'processing'
        jobs[job_id]['stage'] = 'transcribing'
        jobs[job_id]['progress'] = f'Transcribing with Whisper ({model_name})...'

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

        # Run worker in subprocess - completely isolated stdout/stderr
        # Use subprocess.DEVNULL for stderr to avoid broken pipe from tqdm progress bars
        result = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=1800  # 30 minute timeout
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
        jobs[job_id]['error'] = 'Transcription timed out after 30 minutes'
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


def process_url_transcription(job_id: str, url: str, hf_token: Optional[str], model_name: str):
    """Background task for URL download and transcription."""
    try:
        jobs[job_id]['status'] = 'downloading'
        audio_path = download_audio_from_url(url, job_id)
        run_transcription_worker(job_id, audio_path, hf_token, model_name)
    except Exception as e:
        jobs[job_id]['status'] = 'error'
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


@app.post("/transcribe/url")
async def transcribe_url(
    url: str = Form(...),
    hf_token: Optional[str] = Form(None),
    model: str = Form("base")
):
    """Transcribe audio from a URL (YouTube, podcast, etc.)."""
    import uuid
    job_id = str(uuid.uuid4())
    jobs[job_id] = {
        'status': 'queued',
        'progress': 'Starting download...',
        'stage': 'queued',
        'download_percent': 0,
        'url': url
    }

    # Start background thread
    thread = threading.Thread(
        target=process_url_transcription,
        args=(job_id, url, hf_token, model)
    )
    thread.start()

    return {"job_id": job_id, "status": "queued"}


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
