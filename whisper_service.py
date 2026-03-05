#!/usr/bin/env python3
"""
Persistent Whisper transcription service.

Exposes an OpenAI-compatible endpoint:
  POST /v1/audio/transcriptions
    - file: audio file (multipart/form-data)
    - model: ignored; controlled by WHISPER_MODEL env var

Returns: {"text": "transcribed text"}

The model is loaded once at startup.  Subsequent requests pay only inference
cost, not model-loading cost — which is the main source of latency when calling
openai-whisper as a subprocess.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse
import uvicorn

app = FastAPI(title="Whisper Transcription Service")

MODEL_NAME = os.environ.get("WHISPER_MODEL", "base")

print(f"Loading Whisper model '{MODEL_NAME}'…", flush=True)
from faster_whisper import WhisperModel  # noqa: E402

# int8 quantisation: runs well on CPU with minimal accuracy loss
_model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8")
print("Model ready.", flush=True)


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model: str = Form(default="whisper-1"),  # ignored; kept for API compat
) -> JSONResponse:
    suffix = Path(file.filename or "audio.mp3").suffix or ".mp3"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name

    try:
        segments, _ = _model.transcribe(tmp_path, beam_size=5)
        text = " ".join(seg.text for seg in segments).strip()
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    return JSONResponse({"text": text})


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "model": MODEL_NAME}


if __name__ == "__main__":
    host = os.environ.get("WHISPER_HOST", "0.0.0.0")
    port = int(os.environ.get("WHISPER_PORT", "9000"))
    uvicorn.run(app, host=host, port=port)
