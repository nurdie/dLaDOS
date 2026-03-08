const fs = require("node:fs");
const { spawn } = require("node:child_process");

const log = require("./logger");
const { responseScriptPath, DEFAULT_SYSTEM_PROMPT } = require("./config");

function getPythonExecutable() {
  return process.env.PYTHON || "python3";
}

/**
 * Prepend the system prompt to a messages array if not already present.
 */
function buildLLMMessages(messages) {
  const systemPrompt = (process.env.GLADOS_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT).trim();
  if (!messages.length || messages[0].role !== "system") {
    return [{ role: "system", content: systemPrompt }, ...messages];
  }
  return messages;
}

/**
 * Split accumulated streaming text into complete sentences.
 * Returns { sentences, remainder }.
 */
function extractCompleteSentences(text) {
  const sentences = [];
  const re = /(?<![.!?])[.!?](?![.!?])\s+/g;
  let lastEnd = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    const end = match.index + match[0].length;
    const sentence = text.slice(lastEnd, end).trim();
    if (sentence.length >= 4) {
      sentences.push(sentence);
      lastEnd = end;
    }
  }
  return { sentences, remainder: text.slice(lastEnd) };
}

/**
 * Async generator that streams tokens from the Ollama OpenAI-compatible SSE endpoint.
 */
async function* streamLLMTokens(messages) {
  const endpoint = process.env.OLLAMA_ENDPOINT || "http://localhost:11434/v1/chat/completions";
  const body = {
    model: process.env.OLLAMA_MODEL || "qwen2.5:3b-instruct",
    messages,
    temperature: parseFloat(process.env.OLLAMA_TEMPERATURE || "0.7"),
    top_p: parseFloat(process.env.OLLAMA_TOP_P || "0.9"),
    max_tokens: parseInt(process.env.OLLAMA_MAX_TOKENS || "80", 10),
    stream: true,
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`LLM HTTP ${response.status}: ${await response.text()}`);
  }

  const decoder = new TextDecoder();
  let lineBuffer = "";

  for await (const chunk of response.body) {
    lineBuffer += decoder.decode(chunk, { stream: true });
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") return;
      try {
        const parsed = JSON.parse(data);
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) yield content;
      } catch {
        // ignore malformed SSE frames
      }
    }
  }
}

function generateResponseFromTranscript(transcript, typedPrompt = "") {
  if (!fs.existsSync(responseScriptPath)) {
    throw new Error(`Missing response script: ${responseScriptPath}`);
  }

  return new Promise((resolve, reject) => {
    const t = Date.now();
    const python = getPythonExecutable();
    const args = [responseScriptPath, transcript];
    if (typedPrompt.trim()) args.push(typedPrompt.trim());

    log.debug({ transcript: transcript.slice(0, 80) }, "LLM request started (transcript)");
    const child = spawn(python, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) log.debug({ py: line.trim() }, "get_response");
      }
    });
    child.once("error", (error) => { reject(error); });
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `get_response.py exited with code ${code}`));
        return;
      }
      log.debug({ durationMs: Date.now() - t }, "LLM response received");
      resolve(stdout.trim());
    });
  });
}

module.exports = {
  buildLLMMessages,
  extractCompleteSentences,
  streamLLMTokens,
  generateResponseFromTranscript,
};
