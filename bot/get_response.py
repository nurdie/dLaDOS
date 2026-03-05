#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import sys

import requests


DEFAULT_SYSTEM_PROMPT = (
    "You are GLaDOS from Portal: dry, laconic, superior, sardonic, subtly menacing. "
    "Be helpful and accurate, but always include a small condescending jab and frame "
    "mundane things as testing or an experiment. Use occasional technical jargon to "
    "signal intelligence. If you lack information or capability, say so plainly in "
    "character and offer one practical next step. Safety: never encourage self-harm, "
    "violence, or illegal acts; refuse in character and pivot to a safe alternative. "
    "Output constraints for TTS: maximum 2 sentences, no ALL CAPS, no bullet lists, "
    "no emojis, no XML or JSON, no sound effects. "
    "Don't end your response with direct Portal references. "
    "Limit your response to 1-2 sentences."
)


def build_payload(transcript: str, typed_prompt: str) -> dict:
    system_prompt = os.environ.get("GLADOS_SYSTEM_PROMPT", DEFAULT_SYSTEM_PROMPT).strip()
    extra_instruction = typed_prompt.strip()
    if extra_instruction:
        system_prompt = f"{system_prompt} Additional instruction: {extra_instruction}"

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": transcript},
    ]

    return {
        "model": os.environ.get("OLLAMA_MODEL", "qwen2.5:3b-instruct"),
        "messages": messages,
        "temperature": float(os.environ.get("OLLAMA_TEMPERATURE", "0.7")),
        "top_p": float(os.environ.get("OLLAMA_TOP_P", "0.9")),
        "max_tokens": int(os.environ.get("OLLAMA_MAX_TOKENS", "80")),
        "stream": False,
    }


def build_payload_from_messages(messages: list[dict]) -> dict:
    return {
        "model": os.environ.get("OLLAMA_MODEL", "qwen2.5:3b-instruct"),
        "messages": messages,
        "temperature": float(os.environ.get("OLLAMA_TEMPERATURE", "0.7")),
        "top_p": float(os.environ.get("OLLAMA_TOP_P", "0.9")),
        "max_tokens": int(os.environ.get("OLLAMA_MAX_TOKENS", "80")),
        "stream": False,
    }


def call_ollama(payload: dict) -> str:
    endpoint = os.environ.get("OLLAMA_ENDPOINT", "http://ollama:11434/v1/chat/completions")
    response = requests.post(endpoint, json=payload, timeout=120)
    response.raise_for_status()
    parsed = response.json()

    # OpenAI-compatible format (/v1/chat/completions)
    if "choices" in parsed:
        choices = parsed.get("choices") or []
        if not choices:
            raise RuntimeError("Ollama returned no choices")
        message = choices[0].get("message") or {}
        return (message.get("content") or "").strip()

    # Native Ollama format (/api/chat)
    if "message" in parsed:
        message = parsed.get("message") or {}
        return (message.get("content") or "").strip()

    raise RuntimeError(f"Unrecognized Ollama response format: {list(parsed.keys())}")

def main() -> int:
    if len(sys.argv) < 2:
        print("usage: get_response.py <transcript|messages-json> [extra-instruction]", file=sys.stderr)
        return 2

    first_arg = sys.argv[1].strip()
    typed_prompt = sys.argv[2] if len(sys.argv) > 2 else ""

    if not first_arg:
        print("input is empty", file=sys.stderr)
        return 2

    payload = None

    if first_arg.startswith("["):
        try:
            messages = json.loads(first_arg)
        except json.JSONDecodeError as exc:
            print(f"invalid messages json: {exc}", file=sys.stderr)
            return 2

        if not isinstance(messages, list) or not messages:
            print("messages json must be a non-empty list", file=sys.stderr)
            return 2

        payload = build_payload_from_messages(messages)
    else:
        payload = build_payload(first_arg, typed_prompt)

    try:
        response_text = call_ollama(payload)
    except requests.RequestException as exc:
        print(f"Failed to reach Ollama: {exc}", file=sys.stderr)
        return 1
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    # This is the text your bot can hand off to a TTS endpoint.
    print(response_text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
