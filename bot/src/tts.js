const fs = require("node:fs/promises");
const path = require("node:path");

const log = require("./logger");
const { ttsEndpoint, ttsVoice, ttsOutputPath } = require("./config");

async function synthesizeSpeechToMp3(text, outputPath = ttsOutputPath) {
  const t = Date.now();
  log.debug(
    { chars: text.length, outputPath: path.relative(process.cwd(), outputPath) },
    "TTS synthesis started",
  );

  const response = await fetch(ttsEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: text, voice: ttsVoice }),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`TTS HTTP ${response.status}: ${details}`);
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(outputPath, audioBuffer);
  log.debug({ durationMs: Date.now() - t, bytes: audioBuffer.length }, "TTS synthesis complete");
  return outputPath;
}

module.exports = { synthesizeSpeechToMp3 };
