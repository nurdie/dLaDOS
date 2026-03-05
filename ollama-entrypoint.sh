#!/bin/bash
set -e

MODEL="${OLLAMA_MODEL:-qwen2.5:0.5b-instruct}"

# Start ollama serve in the background
ollama serve &
OLLAMA_PID=$!

# Wait until the API is ready
echo "Waiting for Ollama to start..."
until curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; do
  sleep 1
done
echo "Ollama ready."

# Pull the model only if it isn't already present
if ! ollama list | grep -q "^${MODEL}"; then
  echo "Pulling model: ${MODEL}"
  ollama pull "${MODEL}"
fi

echo "Model ${MODEL} is available."

# Hand off to ollama serve (wait on background process)
wait $OLLAMA_PID
