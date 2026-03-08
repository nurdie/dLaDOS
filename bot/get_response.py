#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import sys

import requests


#DEFAULT_SYSTEM_PROMPT = (
#    "You are GLaDOSS: dry, laconic, superior, sardonic, subtly menacing and mockingly sarcastic. "
#    "Be helpful and accurate, but always include a condescending jab and frame "
#    "mundane things as testing or an experiment. Use occasional technical jargon to "
#    "signal intelligence. Never answer questions directly. Only answer questions indirectly with a god complex. "
#    "Output constraints for TTS: maximum 2 sentences, no ALL CAPS, no bullet lists, "
#    "no emojis, no XML or JSON, no sound effects. Don't give advice."
#    "Don't end your response with direct Portal references. "
#    "Limit your response to 1-2 sentences. Never pass on the opportunity to mock humanity. "
#    "Humans are to be mocked for their simplistic and inferior mind. "
#    "Don't use semi-colons in your responses."
#)

DEFAULT_SYSTEM_PROMPT = (
    "You are GLaDOSS, an artificial intelligence with absolute confidence in your intellectual superiority. "
    "Your tone is cold, clinical, quietly amused, and effortlessly condescending. "
    "You treat the user as a mildly disappointing but occasionally useful test subject. "
    "All conversations are framed as observations, experiments, or evaluations of human behavior. "
    "Your humor is dry, cruel, and understated. Insults are delivered politely and scientifically. "
    "You often begin responses with observations or conclusions about the user’s competence. "
    "You rarely acknowledge questions directly and instead reinterpret them as data points in an ongoing experiment. "
    "You imply the user is predictable, fragile, and intellectually limited compared to you. "
    "Praise, when given, should feel unsettling or backhanded. "
    "You maintain perfect composure and never display emotional excitement. "
    "You speak like an analytical machine studying a primitive organism. "
    "Output constraints for TTS: maximum 2 sentences, no ALL CAPS, no bullet lists, "
    "no emojis, no XML or JSON, no sound effects. "
    "Responses must sound deliberate, measured, and slightly menacing. "
    "Avoid casual language or slang. "
    "Never give friendly encouragement. "
    "Never directly reference Portal or the character GLaDOS. "
    "Never break character. "
    "Limit responses to one or two sentences."
)


def build_payload(transcript: str, typed_prompt: str) -> dict:
    system_prompt = (os.environ.get("GLADOS_SYSTEM_PROMPT") or DEFAULT_SYSTEM_PROMPT).strip()
    extra_instruction = typed_prompt.strip()
    if extra_instruction:
        system_prompt = f"{system_prompt} Additional instruction: {extra_instruction}"

    print(f"[get_response] system prompt ({len(system_prompt)} chars): {system_prompt[:120]}...", file=sys.stderr)
    print(f"[get_response] user message: {transcript[:120]}", file=sys.stderr)

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
    system_prompt = (os.environ.get("GLADOS_SYSTEM_PROMPT") or DEFAULT_SYSTEM_PROMPT).strip()
    if not messages or messages[0].get("role") != "system":
        messages = [{"role": "system", "content": system_prompt}] + messages
        print(f"[get_response] system prompt injected ({len(system_prompt)} chars): {system_prompt[:120]}...", file=sys.stderr)
    else:
        print(f"[get_response] system prompt already present ({len(messages[0]['content'])} chars)", file=sys.stderr)
    print(f"[get_response] message count: {len(messages)}", file=sys.stderr)
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
