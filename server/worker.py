#!/usr/bin/env python3
"""
Transcription Worker - Runs in a separate subprocess

This script handles the actual Whisper transcription and optional speaker diarization.
It runs in a completely separate process to avoid stdout/stderr issues with the main server.

Output is JSON to stdout, which the main server parses.
"""

import os
import sys
import argparse
import tempfile
import subprocess
import json
from pathlib import Path


def convert_to_wav(input_path: str) -> str:
    """Convert audio to 16kHz mono WAV."""
    temp_wav = tempfile.NamedTemporaryFile(suffix='.wav', delete=False)
    temp_wav.close()

    result = subprocess.run(
        ['ffmpeg', '-i', input_path, '-acodec', 'pcm_s16le', '-ar', '16000',
         '-ac', '1', '-y', temp_wav.name],
        capture_output=True,
        text=True,
        timeout=3600  # 1 hour - sufficient for very long audio files
    )

    if result.returncode != 0:
        raise Exception(f"FFmpeg conversion failed: {result.stderr[:500]}")

    return temp_wav.name


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

        grouped = []
        current_speaker = None
        current_text = []
        current_start = None
        current_end = None

        for seg in segments:
            speaker = speaker_map.get(seg['speaker'], seg['speaker'])

            if speaker != current_speaker:
                if current_speaker and current_text:
                    grouped.append({
                        'timestamp': format_timestamp(current_start),
                        'speaker': current_speaker,
                        'text': ' '.join(current_text),
                        'start': current_start,  # Raw seconds (float) for precision
                        'end': current_end       # Raw seconds (float) for precision
                    })
                current_speaker = speaker
                current_text = [seg['text']]
                current_start = seg['start']
                current_end = seg['end']
            else:
                current_text.append(seg['text'])
                current_end = seg['end']  # Update end time as we accumulate

        if current_speaker and current_text:
            grouped.append({
                'timestamp': format_timestamp(current_start),
                'speaker': current_speaker,
                'text': ' '.join(current_text),
                'start': current_start,  # Raw seconds (float) for precision
                'end': current_end       # Raw seconds (float) for precision
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
                    'text': seg['text'].strip(),
                    'start': seg['start'],  # Raw seconds (float) for precision
                    'end': seg['end']       # Raw seconds (float) for precision
                }
                for seg in segments
            ],
            'full_text': ' '.join([seg['text'].strip() for seg in segments])
        }


def run_transcription(audio_path: str, model_name: str, hf_token: str = None) -> dict:
    """Run the transcription and return result."""
    import io
    import contextlib

    # Convert to WAV
    wav_path = convert_to_wav(audio_path)

    try:
        # Import and run Whisper
        import whisper
        model = whisper.load_model(model_name)

        # Suppress Whisper's stdout output (like "Detected language: English")
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            result = model.transcribe(wav_path, verbose=False)

        # Speaker diarization if token provided
        if hf_token:
            try:
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

                pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1")

                # Use MPS on Apple Silicon if available
                if torch.backends.mps.is_available():
                    pipeline.to(torch.device("mps"))

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
                formatted['diarization_status'] = 'success'
                formatted['diarization_error'] = None

            except Exception as e:
                # If diarization fails, log error and return without speakers
                import sys
                print(f"Diarization failed: {str(e)}", file=sys.stderr)
                formatted = format_transcript(result['segments'], with_speakers=False)
                formatted['diarization_status'] = 'failed'
                formatted['diarization_error'] = str(e)
        else:
            formatted = format_transcript(result['segments'], with_speakers=False)
            formatted['diarization_status'] = 'skipped'
            formatted['diarization_error'] = 'No Hugging Face token provided'

        return {
            'result': formatted,
            'language': result.get('language', 'unknown')
        }

    finally:
        # Cleanup WAV file
        Path(wav_path).unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description='Transcription Worker')
    parser.add_argument('--audio', required=True, help='Path to audio file')
    parser.add_argument('--model', default='base', help='Whisper model name')
    parser.add_argument('--hf-token', help='Hugging Face token for diarization')
    parser.add_argument('--job-id', help='Job ID (for logging)')

    args = parser.parse_args()

    try:
        result = run_transcription(args.audio, args.model, args.hf_token)
        # Output JSON to stdout - this is parsed by the main server
        print(json.dumps(result))
        sys.exit(0)
    except Exception as e:
        # Output error as JSON
        print(json.dumps({'error': str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
