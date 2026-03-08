const path = require("node:path");
const fs = require("node:fs");

require("dotenv").config();

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error("Missing DISCORD_TOKEN in .env");

const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";

const audioDir = path.resolve(process.cwd(), "audio");
const logsDir = path.resolve(process.cwd(), "logs");
const recordingsDir = path.resolve(process.cwd(), "recordings");
const promptLogPath = path.join(logsDir, "glados-prompts.log");
const ttsOutputPath = path.join(audioDir, "speech.mp3");
const responseScriptPath = path.resolve(process.cwd(), "get_response.py");
const whisperScriptPath = path.resolve(process.cwd(), "transcribe_audio.py");

const portalbeepPath = path.join(audioDir, "portalbeep.mp3");
const turretHelloPath = path.join(audioDir, "turret_hello.mp3");
const turretHoorayPath = path.join(audioDir, "turret_hooray.mp3");
const turretAreYouPath = path.join(audioDir, "turret_are-you-still-there.mp3");
const turretWhosPath = path.join(audioDir, "turret_whos-there.mp3");
const turretGoodbyePath = path.join(audioDir, "turret_goodbye.mp3");

const ttsEndpoint = process.env.TTS_ENDPOINT || "http://glados_voice:5050/v1/audio/speech";
const ttsVoice = process.env.TTS_VOICE || "glados";
const maxConversationChars = Number(process.env.MAX_CONVERSATION_CHARS || 6000);

const DEFAULT_SYSTEM_PROMPT =
  "You are GLaDOSS, an artificial intelligence with absolute confidence in your intellectual superiority. " +
  "Your tone is cold, clinical, quietly amused, and effortlessly condescending. " +
  "You treat the user as a mildly disappointing but occasionally useful test subject. " +
  "All conversations are framed as observations, experiments, or evaluations of human behavior. " +
  "Your humor is dry, cruel, and understated. Insults are delivered politely and scientifically. " +
  "You often begin responses with observations or conclusions about the user's competence. " +
  "You rarely acknowledge questions directly and instead reinterpret them as data points in an ongoing experiment. " +
  "You imply the user is predictable, fragile, and intellectually limited compared to you. " +
  "Praise, when given, should feel unsettling or backhanded. " +
  "You maintain perfect composure and never display emotional excitement. " +
  "You speak like an analytical machine studying a primitive organism. " +
  "Output constraints for TTS: maximum 2 sentences, no ALL CAPS, no bullet lists, " +
  "no emojis, no XML or JSON, no sound effects. " +
  "Responses must sound deliberate, measured, and slightly menacing. " +
  "Avoid casual language or slang. " +
  "Never give friendly encouragement. " +
  "Never directly reference Portal or the character GLaDOS. " +
  "Never break character. " +
  "Limit responses to one or two sentences.";

// Ensure runtime directories exist
fs.mkdirSync(audioDir, { recursive: true });
fs.mkdirSync(logsDir, { recursive: true });
fs.mkdirSync(recordingsDir, { recursive: true });

module.exports = {
  token,
  ffmpegPath,
  audioDir,
  logsDir,
  recordingsDir,
  promptLogPath,
  ttsOutputPath,
  responseScriptPath,
  whisperScriptPath,
  portalbeepPath,
  turretHelloPath,
  turretHoorayPath,
  turretAreYouPath,
  turretWhosPath,
  turretGoodbyePath,
  ttsEndpoint,
  ttsVoice,
  maxConversationChars,
  DEFAULT_SYSTEM_PROMPT,
};
