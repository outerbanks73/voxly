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
import asyncio
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
whisper_model = None
diarization_pipeline = None


def get_whisper_model(model_name: str = "base"):
    """Lazy-load Whisper model."""
    global whisper_model
    if whisper_model is None:
        import whisper
        print(f"Loading Whisper model '{model_name}'...")
        whisper_model = whisper.load_model(model_name)
    return whisper_model


def get_diarization_pipeline(hf_token: str):
    """Lazy-load diarization pipeline."""
    global diarization_pipeline
    if diarization_pipeline is None and hf_token:
        import torch

        # Set token
        os.environ["HF_TOKEN"] = hf_token
        os.environ["HUGGING_FACE_HUB_TOKEN"] = hf_token

        # Fix PyTorch 2.6+ weights_only security issue
        torch.serialization.add_safe_globals([torch.torch_version.TorchVersion])

        # Monkey-patch huggingface_hub
        import huggingface_hub
        original_hf_hub_download = huggingface_hub.hf_hub_download

        def patched_hf_hub_download(*args, **kwargs):
            if 'use_auth_token' in kwargs:
                kwargs['token'] = kwargs.pop('use_auth_token')
            return original_hf_hub_download(*args, **kwargs)

        huggingface_hub.hf_hub_download = patched_hf_hub_download
        import huggingface_hub.file_download
        huggingface_hub.file_download.hf_hub_download = patched_hf_hub_download

        # Patch torch.load
        original_torch_load = torch.load

        def patched_torch_load(*args, **kwargs):
            kwargs['weights_only'] = False
            return original_torch_load(*args, **kwargs)

        torch.load = patched_torch_load

        # Patch lightning_fabric
        import lightning_fabric.utilities.cloud_io

        def patched_pl_load(path_or_url, map_location=None, **kwargs):
            return original_torch_load(path_or_url, map_location=map_location, weights_only=False)

        lightning_fabric.utilities.cloud_io._load = patched_pl_load

        from pyannote.audio import Pipeline

        print("Loading speaker diarization model...")
        diarization_pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1")

        # Use MPS on Apple Silicon if available
        if torch.backends.mps.is_available():
            print("Using Apple Silicon GPU (MPS)...")
            diarization_pipeline.to(torch.device("mps"))

    return diarization_pipeline


def convert_to_wav(input_path: str) -> str:
    """Convert audio to 16kHz mono WAV."""
    temp_wav = tempfile.NamedTemporaryFile(suffix='.wav', delete=False)
    temp_wav.close()

    subprocess.run(
        ['ffmpeg', '-i', input_path, '-acodec', 'pcm_s16le', '-ar', '16000',
         '-ac', '1', '-y', temp_wav.name],
        capture_output=True,
        check=True
    )
    return temp_wav.name


def download_audio_from_url(url: str) -> str:
    """Download audio from URL using yt-dlp."""
    temp_dir = tempfile.mkdtemp()
    output_path = os.path.join(temp_dir, "audio.%(ext)s")

    try:
        subprocess.run(
            ['yt-dlp', '-x', '--audio-format', 'wav', '-o', output_path, url],
            capture_output=True,
            check=True
        )
        # Find the downloaded file
        for f in os.listdir(temp_dir):
            if f.startswith("audio"):
                return os.path.join(temp_dir, f)
        raise Exception("Download completed but audio file not found")
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="yt-dlp not installed. Run: pip install yt-dlp")


def format_timestamp(seconds: float) -> str:
    """Convert seconds to HH:MM:SS format."""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    if hours > 0:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def assign_speakers(whisper_segments: list, diarization_segments: list) -> list:
    """Assign speaker labels to transcript segments."""
    result = []

    for w_seg in whisper_segments:
        w_start = w_seg['start']
        w_end = w_seg['end']
        w_mid = (w_start + w_end) / 2

        best_speaker = "UNKNOWN"
        best_overlap = 0

        for d_seg in diarization_segments:
            overlap_start = max(w_start, d_seg['start'])
            overlap_end = min(w_end, d_seg['end'])
            overlap = max(0, overlap_end - overlap_start)

            if overlap > best_overlap:
                best_overlap = overlap
                best_speaker = d_seg['speaker']

        if best_overlap == 0:
            for d_seg in diarization_segments:
                if d_seg['start'] <= w_mid <= d_seg['end']:
                    best_speaker = d_seg['speaker']
                    break

        result.append({
            'start': w_start,
            'end': w_end,
            'text': w_seg['text'].strip(),
            'speaker': best_speaker
        })

    return result


def create_speaker_mapping(segments: list) -> dict:
    """Map SPEAKER_XX to Speaker 1, Speaker 2, etc."""
    speakers_seen = []
    for seg in segments:
        if seg['speaker'] not in speakers_seen:
            speakers_seen.append(seg['speaker'])
    return {spk: f"Speaker {i+1}" for i, spk in enumerate(speakers_seen)}


def format_transcript(segments: list, with_speakers: bool = False) -> dict:
    """Format transcript for API response."""
    if with_speakers:
        speaker_map = create_speaker_mapping(segments)

        # Group consecutive segments by speaker
        grouped = []
        current_speaker = None
        current_text = []
        current_start = None

        for seg in segments:
            speaker = speaker_map.get(seg['speaker'], seg['speaker'])

            if speaker != current_speaker:
                if current_speaker and current_text:
                    grouped.append({
                        'timestamp': format_timestamp(current_start),
                        'speaker': current_speaker,
                        'text': ' '.join(current_text)
                    })
                current_speaker = speaker
                current_text = [seg['text']]
                current_start = seg['start']
            else:
                current_text.append(seg['text'])

        if current_speaker and current_text:
            grouped.append({
                'timestamp': format_timestamp(current_start),
                'speaker': current_speaker,
                'text': ' '.join(current_text)
            })

        return {
            'speakers': list(set(speaker_map.values())),
            'segments': grouped,
            'full_text': '\n\n'.join([
                f"[{s['timestamp']}] {s['speaker']}:\n{s['text']}"
                for s in grouped
            ])
        }
    else:
        return {
            'segments': [
                {
                    'timestamp': format_timestamp(seg['start']),
                    'text': seg['text'].strip()
                }
                for seg in segments
            ],
            'full_text': ' '.join([seg['text'].strip() for seg in segments])
        }


async def process_transcription(
    job_id: str,
    audio_path: str,
    hf_token: Optional[str],
    model_name: str
):
    """Background task for transcription."""
    try:
        jobs[job_id]['status'] = 'processing'
        jobs[job_id]['progress'] = 'Converting audio...'

        # Convert to WAV
        wav_path = convert_to_wav(audio_path)

        try:
            # Transcribe with Whisper
            jobs[job_id]['progress'] = 'Transcribing audio...'
            model = get_whisper_model(model_name)
            result = model.transcribe(wav_path, verbose=False)

            jobs[job_id]['progress'] = 'Transcription complete'

            # Speaker diarization if token provided
            if hf_token:
                jobs[job_id]['progress'] = 'Identifying speakers...'
                pipeline = get_diarization_pipeline(hf_token)

                if pipeline:
                    diarization = pipeline(wav_path)

                    diarization_segments = []
                    for turn, _, speaker in diarization.itertracks(yield_label=True):
                        diarization_segments.append({
                            'start': turn.start,
                            'end': turn.end,
                            'speaker': speaker
                        })

                    combined = assign_speakers(result['segments'], diarization_segments)
                    formatted = format_transcript(combined, with_speakers=True)
                else:
                    formatted = format_transcript(result['segments'], with_speakers=False)
            else:
                formatted = format_transcript(result['segments'], with_speakers=False)

            jobs[job_id]['status'] = 'completed'
            jobs[job_id]['result'] = formatted
            jobs[job_id]['language'] = result.get('language', 'unknown')

        finally:
            # Cleanup WAV file
            Path(wav_path).unlink(missing_ok=True)

    except Exception as e:
        jobs[job_id]['status'] = 'error'
        jobs[job_id]['error'] = str(e)
    finally:
        # Cleanup original audio if it was a temp file
        if audio_path.startswith(tempfile.gettempdir()):
            Path(audio_path).unlink(missing_ok=True)


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
    background_tasks: BackgroundTasks,
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

    # Start background processing
    background_tasks.add_task(
        process_transcription,
        job_id,
        temp_file.name,
        hf_token,
        model
    )

    return {"job_id": job_id, "status": "queued"}


@app.post("/transcribe/url")
async def transcribe_url(
    background_tasks: BackgroundTasks,
    url: str = Form(...),
    hf_token: Optional[str] = Form(None),
    model: str = Form("base")
):
    """Transcribe audio from a URL (YouTube, podcast, etc.)."""
    # Create job first
    import uuid
    job_id = str(uuid.uuid4())
    jobs[job_id] = {
        'status': 'queued',
        'progress': 'Downloading audio...',
        'url': url
    }

    try:
        audio_path = download_audio_from_url(url)
    except Exception as e:
        jobs[job_id] = {'status': 'error', 'error': str(e)}
        return {"job_id": job_id, "status": "error", "error": str(e)}

    # Start background processing
    background_tasks.add_task(
        process_transcription,
        job_id,
        audio_path,
        hf_token,
        model
    )

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
