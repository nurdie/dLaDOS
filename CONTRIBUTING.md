# Contributing

Contributions are welcome. Please read this document before opening a pull request.

## Ground Rules

- Be respectful and constructive.
- Keep changes focused — one feature or fix per PR.
- Don't break existing functionality without a good reason and discussion.

## Development Setup

1. Fork the repo and clone your fork:
   ```bash
   git clone --recurse-submodules https://github.com/YOUR_USERNAME/glados-discord-bot.git
   ```

2. Follow the [Quick Start](README.md#quick-start) in the README to get the stack running locally.

3. Create a branch for your change:
   ```bash
   git checkout -b feat/my-feature
   ```

## What to Work On

Good first contributions:

- **Better voice activity detection** — the current silence threshold (2.5 s) is a fixed value; adaptive VAD would improve responsiveness.
- **Streaming LLM + TTS** — pipe Ollama's streaming output directly into the TTS engine to reduce time-to-first-audio.
- **Multi-user support** — the bot currently only listens to one speaker at a time in a conversation session.
- **Web dashboard** — a simple status page showing active sessions, conversation history, and service health.
- **Platform improvements** — testing on x86-64 Linux and reporting/fixing issues.

## Coding Style

- **JavaScript (bot.js):** Follow the existing style (CommonJS, `async`/`await`, no external linter config — keep it consistent with what's there).
- **Python:** PEP 8, type hints on new functions, `from __future__ import annotations`.
- Keep functions small and single-purpose.
- Do not add dependencies without discussing in an issue first.

## Pull Request Checklist

- [ ] The stack builds and starts with `docker compose up --build`
- [ ] The bot joins a voice channel and responds correctly
- [ ] No secrets or tokens committed (check `.gitignore`)
- [ ] Description explains *what* changed and *why*

## Reporting Issues

Open a GitHub issue with:
- What you expected to happen
- What actually happened
- Docker / OS version
- Relevant logs (redact any tokens)
