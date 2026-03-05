#!/usr/bin/env python3
"""
Transcribe an audio file to text.

Preferred path: POST to the Whisper HTTP service (WHISPER_ENDPOINT env var).
The service keeps the model warm in memory, so transcription is fast.

Fallback path: load openai-whisper in-process when WHISPER_ENDPOINT is unset
or unreachable.  This is slow on the first call because the model loads from
disk, but requires no separate service.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


def transcribe_via_http(audio_path: Path, endpoint: str) -> str:
    import requests

    with audio_path.open("rb") as f:
        resp = requests.post(
            endpoint,
            files={"file": (audio_path.name, f, "audio/mpeg")},
            data={"model": os.environ.get("WHISPER_MODEL", "base")},
            timeout=60,
        )
    resp.raise_for_status()
    return (resp.json().get("text") or "").strip()


def transcribe_locally(audio_path: Path) -> str:
    try:
        import whisper
    except ImportError as exc:
        print(
            "openai-whisper is not installed. "
            "Either set WHISPER_ENDPOINT to point at the containerised Whisper "
            "service, or install: pip install openai-whisper",
            file=sys.stderr,
        )
        print(str(exc), file=sys.stderr)
        sys.exit(1)

    model_name = os.environ.get("WHISPER_MODEL", "base")
    model = whisper.load_model(model_name)
    result = model.transcribe(str(audio_path), fp16=False)
    return (result.get("text") or "").strip()


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: transcribe_audio.py <path-to-audio>", file=sys.stderr)
        return 2

    audio_path = Path(sys.argv[1]).expanduser().resolve()
    if not audio_path.exists():
        print(f"audio file not found: {audio_path}", file=sys.stderr)
        return 2

    endpoint = os.environ.get("WHISPER_ENDPOINT", "").strip()

    if endpoint:
        try:
            text = transcribe_via_http(audio_path, endpoint)
        except Exception as exc:
            print(
                f"HTTP transcription failed ({exc}); falling back to local Whisper",
                file=sys.stderr,
            )
            text = transcribe_locally(audio_path)
    else:
        text = transcribe_locally(audio_path)

    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
