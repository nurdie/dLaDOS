const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const log = require("./logger");
const { whisperScriptPath } = require("./config");

function getPythonExecutable() {
  return process.env.PYTHON || "python3";
}

function transcribeWithWhisper(audioPath) {
  if (!fs.existsSync(whisperScriptPath)) {
    throw new Error(`Missing Whisper wrapper script: ${whisperScriptPath}`);
  }

  return new Promise((resolve, reject) => {
    const t = Date.now();
    const python = getPythonExecutable();
    log.debug({ audioPath: path.relative(process.cwd(), audioPath) }, "Whisper transcription started");
    const child = spawn(python, [whisperScriptPath, audioPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => { reject(error); });
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Whisper exited with code ${code}`));
        return;
      }
      log.debug({ durationMs: Date.now() - t }, "Whisper transcription complete");
      resolve(stdout.trim());
    });
  });
}

async function transcribeWithWhisperHttp(audioPath) {
  const endpoint = process.env.WHISPER_ENDPOINT || "";
  if (!endpoint) return transcribeWithWhisper(audioPath);

  const t = Date.now();
  log.debug({ audioPath: path.relative(process.cwd(), audioPath) }, "Whisper HTTP transcription started");

  const formData = new FormData();
  const fileBuffer = await fs.promises.readFile(audioPath);
  formData.append("file", new Blob([fileBuffer], { type: "audio/mpeg" }), path.basename(audioPath));
  formData.append("model", process.env.WHISPER_MODEL || "base");

  const response = await fetch(endpoint, { method: "POST", body: formData });
  if (!response.ok) {
    throw new Error(`Whisper HTTP ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  const text = (data.text || "").trim();
  log.debug({ durationMs: Date.now() - t }, "Whisper HTTP transcription complete");
  return text;
}

module.exports = { transcribeWithWhisper, transcribeWithWhisperHttp };
