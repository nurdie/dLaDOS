const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { appendFile, writeFile } = require("node:fs/promises");
const prism = require("prism-media");
const dotenv = require("dotenv");
const pino = require("pino");
const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
const {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} = require("@discordjs/voice");
const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
} = require("discord.js");

dotenv.config();

const log = pino({
  level: process.env.LOG_LEVEL || "debug",
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "SYS:HH:MM:ss.l",
      ignore: "pid,hostname",
    },
  },
});

const token = process.env.DISCORD_TOKEN;
const audioDir = path.resolve(process.cwd(), "audio");
const logsDir = path.resolve(process.cwd(), "logs");
const promptLogPath = path.join(logsDir, "glados-prompts.log");
const ttsOutputPath = path.join(audioDir, "speech.mp3");
const recordingsDir = path.resolve(process.cwd(), "recordings");
const responseScriptPath = path.resolve(process.cwd(), "get_response.py");
const whisperScriptPath = path.resolve(process.cwd(), "transcribe_audio.py");
const venvPythonPath = path.resolve(process.cwd(), ".venv/bin/python");
const ttsEndpoint = process.env.TTS_ENDPOINT || "http://glados_voice:5050/v1/audio/speech";
const ttsVoice = process.env.TTS_VOICE || "glados";
const maxConversationChars = Number(process.env.MAX_CONVERSATION_CHARS || 6000);
const portalbeepPath = path.join(audioDir, "portalbeep.mp3");
const turretHelloPath = path.join(audioDir, "turret_hello.mp3");
const turretAreYouPath = path.join(audioDir, "turret_are-you-still-there.mp3");
const turretWhosPath = path.join(audioDir, "turret_whos-there.mp3");
const turretGoodbyePath = path.join(audioDir, "turret_goodbye.mp3");

// System prompt for LLM streaming path (mirrors get_response.py DEFAULT_SYSTEM_PROMPT)
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

class IdleTimeoutError extends Error {}

if (!token) {
  throw new Error("Missing DISCORD_TOKEN in .env");
}

if (!ffmpegPath) {
  throw new Error("FFMPEG_PATH is not set and ffmpeg is not available");
}

fs.mkdirSync(audioDir, { recursive: true });
fs.mkdirSync(logsDir, { recursive: true });
fs.mkdirSync(recordingsDir, { recursive: true });

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const player = createAudioPlayer({
  behaviors: {
    noSubscriber: NoSubscriberBehavior.Pause,
  },
});
const listeningSessions = new Map();
const playbackState = {
  current: null,
  serial: 0,
};

function getListeningSession(guildId) {
  return listeningSessions.get(guildId) || null;
}

async function logPrompt(source, prompt, mode, explicitUser = "") {
  const guildName = source.guild?.name || source.guildId || "unknown-guild";
  const userTag =
    explicitUser ||
    source.user?.tag ||
    source.user?.username ||
    source.member?.user?.tag ||
    source.member?.user?.username ||
    source.author?.tag ||
    source.author?.username ||
    "unknown-user";
  const entry =
    `[${new Date().toISOString()}] ` +
    `[${mode}] [${guildName}] [${userTag}] ${prompt.replace(/\s+/g, " ").trim()}\n`;

  log.info({ mode, guild: guildName, user: userTag }, `Prompt: ${prompt.replace(/\s+/g, " ").trim()}`);

  try {
    await appendFile(promptLogPath, entry, "utf8");
  } catch (error) {
    log.error({ err: error }, "Failed to write prompt log");
  }
}

function buildSlashCommands() {
  return [
    new SlashCommandBuilder()
      .setName("glados")
      .setDescription("GLaDOS voice commands.")
      .addSubcommand((sub) =>
        sub
          .setName("join")
          .setDescription("Join your voice channel and start listening."),
      )
      .addSubcommand((sub) =>
        sub
          .setName("ask")
          .setDescription("Send a text prompt through the LLM and speak the response.")
          .addStringOption((option) =>
            option
              .setName("prompt")
              .setDescription("Your prompt for GLaDOS")
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("say")
          .setDescription("Speak text directly via TTS, no LLM involved.")
          .addStringOption((option) =>
            option
              .setName("text")
              .setDescription("Text to speak")
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("leave")
          .setDescription("Disconnect GLaDOS from the current voice channel."),
      )
      .toJSON(),
  ];
}

async function registerSlashCommands() {
  const commands = buildSlashCommands();
  const guilds = [...client.guilds.cache.values()];
  await Promise.all(guilds.map((guild) => guild.commands.set(commands)));
}

async function replyEphemeral(interaction, content) {
  if (interaction.replied || interaction.deferred) {
    await interaction.editReply({ content });
    return;
  }

  await interaction.reply({
    content,
    ephemeral: true,
  });
}

function createConversationHistory() {
  return [];
}

function trimConversationHistory(history) {
  if (!history.length) {
    return createConversationHistory();
  }

  const [systemMessage, ...rest] = history;
  let totalChars = systemMessage.content.length;
  const kept = [];

  for (let index = rest.length - 1; index >= 0; index -= 1) {
    const message = rest[index];
    const nextChars = totalChars + message.content.length;

    if (nextChars > maxConversationChars && kept.length > 0) {
      break;
    }

    if (nextChars > maxConversationChars && kept.length === 0) {
      kept.unshift({
        role: message.role,
        content: message.content.slice(-(maxConversationChars - totalChars)),
      });
      totalChars = maxConversationChars;
      break;
    }

    kept.unshift(message);
    totalChars = nextChars;
  }

  return [systemMessage, ...kept];
}

function appendConversationMessage(session, role, content) {
  const trimmedContent = content.trim();

  if (!trimmedContent) {
    return;
  }

  session.conversationHistory.push({
    role,
    content: trimmedContent,
  });
  session.conversationHistory = trimConversationHistory(session.conversationHistory);
}

function getInvokerVoiceChannel(source) {
  const directChannel = source.member?.voice?.channel;

  if (directChannel) {
    return directChannel;
  }

  const userId = source.user?.id || source.author?.id;
  return source.guild?.members?.cache?.get(userId)?.voice?.channel || null;
}

async function connectToMemberChannel(message) {
  const channel = getInvokerVoiceChannel(message);

  if (!channel) {
    throw new Error("Join a voice channel before using this command.");
  }

  const existing = getVoiceConnection(channel.guild.id);
  const connection =
    existing ||
    joinVoiceChannel({
      adapterCreator: channel.guild.voiceAdapterCreator,
      channelId: channel.id,
      guildId: channel.guild.id,
      selfDeaf: false,
    });

  if (!existing) {
    log.debug({ guild: channel.guild.name, channel: channel.name }, "Joining voice channel");
  }

  connection.subscribe(player);
  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  log.debug({ guild: channel.guild.name, channel: channel.name }, "Voice connection ready");

  return connection;
}

function subscribeToChannelUsers(connection, channel) {
  const subscribedUserIds = new Set();

  for (const [userId, member] of channel.members) {
    if (member.user.bot) {
      continue;
    }

    subscribedUserIds.add(userId);
  }

  return subscribedUserIds;
}

function cleanupListeningSession(guildId) {
  const existingSession = listeningSessions.get(guildId);

  if (!existingSession) {
    return;
  }

  existingSession.active = false;
  listeningSessions.delete(guildId);
  log.debug({ guildId }, "Listening session cleaned up");
}

async function startOpusListening(message) {
  const channel = getInvokerVoiceChannel(message);

  if (!channel) {
    throw new Error("Join a voice channel before using this command.");
  }

  const connection = await connectToMemberChannel(message);
  cleanupListeningSession(channel.guild.id);

  const subscribedUserIds = subscribeToChannelUsers(connection, channel);
  listeningSessions.set(channel.guild.id, {
    active: true,
    channelId: channel.id,
    conversationHistory: createConversationHistory(),
    latestStartedPlaybackRequestId: 0,
    requestSerial: 0,
    subscribedUserIds,
  });

  log.info(
    { guild: channel.guild.name, channel: channel.name, users: subscribedUserIds.size },
    "Listening session started",
  );

  return connection;
}

function sanitizeFilenamePart(value) {
  return value.replace(/[^a-z0-9_-]/gi, "_");
}

function createMp3Resource(mp3Path) {
  const ffmpeg = spawn(ffmpegPath, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    mp3Path,
    "-f",
    "s16le",
    "-ar",
    "48000",
    "-ac",
    "2",
    "pipe:1",
  ]);

  ffmpeg.stderr.on("data", (chunk) => {
    const message = chunk.toString().trim();
    if (message) {
      const expectedPreemptionErrors = [
        "Connection reset by peer",
        "Error submitting a packet to the muxer",
        "Error muxing a packet",
        "Task finished with error code: -104",
        "Terminating thread with return code -104",
        "Error writing trailer",
        "Error closing file",
      ];

      if (expectedPreemptionErrors.some((pattern) => message.includes(pattern))) {
        log.debug({ message }, "ffmpeg preemption (expected)");
        return;
      }

      log.error({ message }, "ffmpeg stderr");
    }
  });

  ffmpeg.on("error", (error) => {
    log.error({ err: error }, "ffmpeg process failed");
  });

  return {
    process: ffmpeg,
    resource: createAudioResource(ffmpeg.stdout, {
      inputType: StreamType.Raw,
      silencePaddingFrames: 5,
    }),
  };
}

function captureFirstSpeaker(connection, channel, subscribedUserIds, delayTimersUntil = null) {
  if (subscribedUserIds.size === 0) {
    throw new Error("I could not subscribe to anyone in this voice channel.");
  }

  return new Promise((resolve, reject) => {
    let finished = false;
    let t10 = null;
    let t20 = null;
    let t30 = null;
    let input = null;
    let decoder = null;
    let ffmpeg = null;

    const cleanup = () => {
      connection.receiver.speaking.off("start", onSpeakingStart);
      clearTimeout(t10);
      clearTimeout(t20);
      clearTimeout(t30);
      if (input) {
        input.destroy();
      }
      if (decoder) {
        decoder.destroy();
      }
    };

    const playIdle = (soundPath) => {
      if (finished || !fs.existsSync(soundPath)) return;
      playSpeechResponse(channel.guild.id, soundPath, false, true).catch(() => {});
    };

    const finish = (handler, value) => {
      if (finished) {
        return;
      }

      finished = true;
      cleanup();
      handler(value);
    };

    const onSpeakingStart = (userId) => {
      if (finished || !subscribedUserIds.has(userId)) {
        return;
      }

      clearTimeout(t10);
      clearTimeout(t20);
      clearTimeout(t30);
      t10 = null;
      t20 = null;
      t30 = null;

      const member = channel.members.get(userId);
      log.debug({ userId, username: member?.user?.tag || userId }, "Speaking detected");

      input = connection.receiver.subscribe(userId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: 800,
        },
      });
      decoder = new prism.opus.Decoder({
        channels: 2,
        frameSize: 960,
        rate: 48_000,
      });
      const filename = `${Date.now()}-${sanitizeFilenamePart(userId)}.mp3`;
      const outputPath = path.join(recordingsDir, filename);
      ffmpeg = spawn(ffmpegPath, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "s16le",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-i",
        "pipe:0",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-codec:a",
        "libmp3lame",
        "-b:a",
        "64k",
        "-y",
        outputPath,
      ]);

      let stderr = "";

      ffmpeg.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      ffmpeg.once("error", (error) => {
        finish(reject, error);
      });

      ffmpeg.once("close", (code) => {
        if (code !== 0) {
          const details = stderr.trim() || `ffmpeg exited with code ${code}`;
          finish(reject, new Error(details));
          return;
        }

        finish(resolve, {
          outputPath,
          userId,
          username: member?.user?.tag || userId,
        });
      });

      input.once("error", (error) => {
        decoder.destroy(error);
      });

      decoder.once("error", (error) => {
        ffmpeg.stdin.destroy(error);
      });

      input.pipe(decoder).pipe(ffmpeg.stdin);
    };

    const startTimers = () => {
      if (finished) return;
      t10 = setTimeout(() => { playIdle(turretAreYouPath); }, 10_000);
      t20 = setTimeout(() => { playIdle(turretWhosPath); }, 20_000);
      t30 = setTimeout(() => {
        finish(reject, new IdleTimeoutError("No voice detected for 30 seconds."));
      }, 30_000);
    };

    if (delayTimersUntil) {
      delayTimersUntil.then(startTimers, startTimers);
    } else {
      startTimers();
    }

    connection.receiver.speaking.on("start", onSpeakingStart);
  });
}

async function recordFirstSpeaker(message, delayTimersUntil = null) {
  const channel = getInvokerVoiceChannel(message);

  if (!channel) {
    throw new Error("Join a voice channel before using this command.");
  }

  const humanMembers = [...channel.members.values()].filter((member) => !member.user.bot);

  if (humanMembers.length === 0) {
    throw new Error("There are no non-bot users in this voice channel.");
  }

  const connection = await connectToMemberChannel(message);
  const subscribedUserIds = subscribeToChannelUsers(connection, channel);

  return captureFirstSpeaker(connection, channel, subscribedUserIds, delayTimersUntil);
}

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

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.once("error", (error) => {
      reject(error);
    });

    child.once("close", (code) => {
      if (code !== 0) {
        const details = stderr.trim() || `Whisper exited with code ${code}`;
        reject(new Error(details));
        return;
      }

      log.debug({ durationMs: Date.now() - t }, "Whisper transcription complete");
      resolve(stdout.trim());
    });
  });
}

function generateResponseFromTranscript(transcript, typedPrompt = "") {
  if (!fs.existsSync(responseScriptPath)) {
    throw new Error(`Missing response script: ${responseScriptPath}`);
  }

  return new Promise((resolve, reject) => {
    const t = Date.now();
    const python = getPythonExecutable();
    const args = [responseScriptPath, transcript];

    if (typedPrompt.trim()) {
      args.push(typedPrompt.trim());
    }

    log.debug({ transcript: transcript.slice(0, 80) }, "LLM request started (transcript)");
    const child = spawn(python, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) log.debug({ py: line.trim() }, "get_response");
      }
    });

    child.once("error", (error) => {
      reject(error);
    });

    child.once("close", (code) => {
      if (code !== 0) {
        const details = stderr.trim() || `get_response.py exited with code ${code}`;
        reject(new Error(details));
        return;
      }

      log.debug({ durationMs: Date.now() - t }, "LLM response received");
      resolve(stdout.trim());
    });
  });
}

function generateResponseFromMessages(messages) {
  if (!fs.existsSync(responseScriptPath)) {
    throw new Error(`Missing response script: ${responseScriptPath}`);
  }

  return new Promise((resolve, reject) => {
    const t = Date.now();
    const python = getPythonExecutable();
    log.debug({ messageCount: messages.length }, "LLM request started (messages)");
    const child = spawn(python, [responseScriptPath, JSON.stringify(messages)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) log.debug({ py: line.trim() }, "get_response");
      }
    });

    child.once("error", (error) => {
      reject(error);
    });

    child.once("close", (code) => {
      if (code !== 0) {
        const details = stderr.trim() || `get_response.py exited with code ${code}`;
        reject(new Error(details));
        return;
      }

      log.debug({ durationMs: Date.now() - t }, "LLM response received");
      resolve(stdout.trim());
    });
  });
}

async function captureUntilTranscript(message, label, maxAttempts = 5, delayTimersUntil = null) {
  let lastCapture = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const capture = await captureAndTranscribe(message, `${label} attempt ${attempt}`, delayTimersUntil);
    lastCapture = capture;

    if (capture.transcript) {
      return capture;
    }

    log.debug({ attempt, maxAttempts, label }, "Empty transcript, retrying");
  }

  throw new Error(
    `Whisper returned an empty transcript after ${maxAttempts} attempts${
      lastCapture ? ` (last file: ${path.relative(process.cwd(), lastCapture.outputPath)})` : ""
    }`,
  );
}

async function synthesizeSpeechToMp3(text, outputPath = ttsOutputPath) {
  const t = Date.now();
  log.debug({ chars: text.length, outputPath: path.relative(process.cwd(), outputPath) }, "TTS synthesis started");

  const response = await fetch(ttsEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: text,
      voice: ttsVoice,
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`TTS HTTP ${response.status}: ${details}`);
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  await writeFile(outputPath, audioBuffer);
  log.debug({ durationMs: Date.now() - t, bytes: audioBuffer.length }, "TTS synthesis complete");
  return outputPath;
}

// ── LLM streaming + sentence-chunked TTS helpers ─────────────────────────────

/**
 * Prepend the system prompt to a messages array if it isn't already present.
 */
function buildLLMMessages(messages) {
  const systemPrompt = (process.env.GLADOS_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT).trim();
  if (!messages.length || messages[0].role !== "system") {
    return [{ role: "system", content: systemPrompt }, ...messages];
  }
  return messages;
}

/**
 * Split accumulated streaming text into complete sentences, returning the
 * completed sentences and the leftover remainder still being built.
 *
 * Splits on . ! ? that are NOT part of an ellipsis or multi-punct sequence,
 * followed by whitespace.  End-of-stream remainder is flushed by the caller.
 */
function extractCompleteSentences(text) {
  const sentences = [];
  // Match a single sentence-ending punct not adjacent to another punct, then whitespace.
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
 * Async generator that streams tokens from the Ollama OpenAI-compatible SSE
 * endpoint.  Yields string content deltas as they arrive.
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

/**
 * Transcribe an audio file by POSTing directly to the Whisper HTTP service.
 * Falls back to the Python subprocess wrapper if WHISPER_ENDPOINT is unset.
 */
async function transcribeWithWhisperHttp(audioPath) {
  const endpoint = process.env.WHISPER_ENDPOINT || "";
  if (!endpoint) {
    return transcribeWithWhisper(audioPath);
  }

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

// ─────────────────────────────────────────────────────────────────────────────

function stopPlaybackForGuild(guildId) {
  const currentPlayback = playbackState.current;

  if (!currentPlayback || currentPlayback.guildId !== guildId) {
    return;
  }

  log.debug({ guildId }, "Stopping current playback");
  playbackState.current = null;
  if (currentPlayback.transcoder && !currentPlayback.transcoder.killed) {
    currentPlayback.transcoder.kill("SIGTERM");
  }

  if (currentPlayback.mp3Path && !currentPlayback.keepFile) {
    fs.unlink(currentPlayback.mp3Path, (err) => {
      if (err) log.error({ err, mp3Path: currentPlayback.mp3Path }, "Failed to delete TTS file");
    });
  }

  currentPlayback.resolve({ interrupted: true });
  player.stop(true);
}

function playSpeechResponse(guildId, mp3Path, disconnectOnFinish = false, keepFile = false) {
  const connection = getVoiceConnection(guildId);

  if (!connection) {
    throw new Error("Voice connection is no longer active.");
  }

  return new Promise((resolve, reject) => {
    stopPlaybackForGuild(guildId);
    const { process: transcoder, resource } = createMp3Resource(mp3Path);

    playbackState.current = {
      disconnectOnFinish,
      guildId,
      keepFile,
      mp3Path,
      reject,
      resolve,
      token: ++playbackState.serial,
      transcoder,
    };

    log.debug({ guildId, mp3Path: path.relative(process.cwd(), mp3Path) }, "Playback started");
    player.play(resource);
  });
}

async function speakTextResponse(message, text) {
  await logPrompt(
    message,
    text,
    "slash-ask",
    message.user?.tag || message.user?.username || "",
  );
  const responseTextForTts = await generateResponseFromTranscript(text);
  log.info({ response: responseTextForTts || "[empty]" }, "LLM response (ask)");

  if (!responseTextForTts) {
    return;
  }

  await connectToMemberChannel(message);
  const speechPath = await synthesizeSpeechToMp3(
    responseTextForTts,
    path.join(audioDir, `speech-${message.guild.id}-${Date.now()}.mp3`),
  );
  await playSpeechResponse(message.guild.id, speechPath, true);
}

async function sayDirectText(interaction, text) {
  await connectToMemberChannel(interaction);
  const speechPath = await synthesizeSpeechToMp3(
    text,
    path.join(audioDir, `speech-${interaction.guild.id}-${Date.now()}.mp3`),
  );
  await playSpeechResponse(interaction.guild.id, speechPath, true);
}

async function captureAndTranscribe(message, label, delayTimersUntil = null) {
  const channel = getInvokerVoiceChannel(message);
  let result;

  if (!channel) {
    throw new Error("Join a voice channel before using this command.");
  }

  const existingSession = listeningSessions.get(channel.guild.id);

  if (existingSession && existingSession.channelId === channel.id) {
    const connection = getVoiceConnection(channel.guild.id);

    if (!connection) {
      listeningSessions.delete(channel.guild.id);
      throw new Error("Voice connection is no longer active.");
    }

    result = await captureFirstSpeaker(connection, channel, existingSession.subscribedUserIds, delayTimersUntil);
  } else {
    result = await recordFirstSpeaker(message, delayTimersUntil);
  }

  log.debug(
    { username: result.username, file: path.relative(process.cwd(), result.outputPath) },
    "Recording captured",
  );

  const transcript = await transcribeWithWhisperHttp(result.outputPath);
  log.info({ label, username: result.username, transcript: transcript || "[empty]" }, "Transcript");

  fs.unlink(result.outputPath, (err) => {
    if (err) log.error({ err, file: result.outputPath }, "Failed to delete recording");
  });

  return {
    ...result,
    transcript,
  };
}

function shouldDisconnectOnTranscript(transcript) {
  const normalized = transcript.toLowerCase();
  return (
    normalized.includes("go away gladoss") ||
    normalized.includes("go away glados") ||
    normalized.includes("go away, gladys") ||
    normalized.includes("please leave") ||
    normalized.includes("go away") ||
    normalized.includes("fuck you")
  );
}

async function playAndDisconnect(guildId) {
  if (fs.existsSync(turretGoodbyePath)) {
    try {
      await playSpeechResponse(guildId, turretGoodbyePath, false, true);
    } catch {}
  }

  const connection = getVoiceConnection(guildId);
  if (connection) {
    connection.destroy();
  }
}

async function runVoiceConversationLoop(message) {
  const channel = getInvokerVoiceChannel(message);

  if (!channel) {
    throw new Error("Join a voice channel before using this command.");
  }

  if (fs.existsSync(turretHelloPath)) {
    try {
      await playSpeechResponse(channel.guild.id, turretHelloPath, false, true);
    } catch {}
  }

  // On the very first listen, timers start immediately (no response to wait for).
  let responseReadyPromise = Promise.resolve();

  while (true) {
    const session = getListeningSession(channel.guild.id);

    if (!session || !session.active || session.channelId !== channel.id) {
      return;
    }

    let capture;

    try {
      capture = await captureUntilTranscript(message, "voice", 5, responseReadyPromise);
    } catch (error) {
      if (error instanceof IdleTimeoutError) {
        log.info({ guildId: channel.guild.id }, "Idle timeout, disconnecting");
        cleanupListeningSession(channel.guild.id);
        await playAndDisconnect(channel.guild.id);
        return;
      }

      log.error({ err: error }, "Listen cycle failed");
      continue;
    }

    if (shouldDisconnectOnTranscript(capture.transcript)) {
      log.info({ transcript: capture.transcript }, "Shutdown phrase detected, disconnecting");
      cleanupListeningSession(channel.guild.id);
      await playAndDisconnect(channel.guild.id);
      return;
    }

    session.requestSerial += 1;
    const requestId = session.requestSerial;
    await logPrompt(message, capture.transcript, "voice");
    appendConversationMessage(session, "user", capture.transcript);
    const requestMessages = session.conversationHistory.map((entry) => ({ ...entry }));

    // Create a promise that resolves when this response finishes playing (or is skipped/errored).
    // The next captureUntilTranscript call waits on it before starting idle timers.
    let signalResponseReady;
    responseReadyPromise = new Promise((resolve) => { signalResponseReady = resolve; });

    void (async () => {
      let beeping = true;
      const stopBeeping = () => { beeping = false; };

      if (fs.existsSync(portalbeepPath)) {
        (async () => {
          // Wait for any currently-playing TTS audio to finish before beeping.
          // keepFile=false identifies TTS files; keepFile=true is sound effects.
          // We must not interrupt an ongoing TTS response just because a new
          // recording came in — beeping is only for the "thinking" gap.
          while (beeping && playbackState.current && !playbackState.current.keepFile) {
            await new Promise((r) => setTimeout(r, 100));
          }
          while (beeping) {
            try {
              const result = await playSpeechResponse(channel.guild.id, portalbeepPath, false, true);
              if (!beeping || result.interrupted) break;
              await new Promise((r) => setTimeout(r, 1000));
            } catch {
              break;
            }
          }
        })();
      }

      try {
        // ── Streaming LLM → sentence-chunked TTS → queued playback ────────────
        //
        // As LLM tokens arrive we accumulate them into a buffer and detect
        // sentence boundaries.  Each complete sentence is immediately handed to
        // TTS (non-blocking).  A concurrent play loop drains the TTS promises
        // in order, starting playback as soon as the first audio is ready.
        // This means Discord starts hearing audio after ~(first-sentence LLM
        // time + single-sentence TTS time) instead of the full round trip.

        // sentencePaths[i] is a Promise<string|null> — resolves to a file path
        // once TTS finishes, or null if TTS failed (skipped during playback).
        const sentencePaths = [];
        let queueNotify = null; // resolved to wake the play loop when a new entry is pushed
        let llmDone = false;
        let fullResponseText = "";

        const enqueueSentenceTTS = (text, idx) => {
          const audioPath = path.join(audioDir, `speech-${channel.guild.id}-${requestId}-${idx}.mp3`);
          const p = synthesizeSpeechToMp3(text, audioPath).catch((err) => {
            log.error({ err, text: text.slice(0, 60) }, "Sentence TTS failed");
            // Delete partial file if it exists
            fs.unlink(audioPath, () => {});
            return null;
          });
          sentencePaths.push(p);
          if (queueNotify) { const r = queueNotify; queueNotify = null; r(); }
        };

        // Play loop: runs concurrently with LLM streaming.
        // Awaits each TTS promise in order, then plays the audio.
        const playbackLoop = (async () => {
          let idx = 0;
          let firstAudio = true;

          while (true) {
            if (idx < sentencePaths.length) {
              const audioPath = await sentencePaths[idx++];

              if (!audioPath) continue; // TTS failed for this sentence — skip

              if (firstAudio) {
                firstAudio = false;
                stopBeeping();
                const activeSession = getListeningSession(channel.guild.id);
                if (!activeSession?.active || activeSession.channelId !== channel.id) {
                  fs.unlink(audioPath, () => {});
                  break;
                }
                if (requestId < activeSession.latestStartedPlaybackRequestId) {
                  log.debug({ requestId, latest: activeSession.latestStartedPlaybackRequestId }, "Skipping stale streaming response");
                  fs.unlink(audioPath, () => {});
                  break;
                }
                activeSession.latestStartedPlaybackRequestId = requestId;
              } else {
                const currentSession = getListeningSession(channel.guild.id);
                if (!currentSession?.active || currentSession.channelId !== channel.id) {
                  fs.unlink(audioPath, () => {});
                  break;
                }
              }

              const result = await playSpeechResponse(channel.guild.id, audioPath, false);
              if (result.interrupted) break;
            } else if (llmDone) {
              break;
            } else {
              // Queue is empty but LLM is still running — wait for next sentence.
              await new Promise((r) => { queueNotify = r; });
            }
          }
        })();

        // Stream LLM tokens, detect sentence boundaries, enqueue TTS per sentence.
        const llmMessages = buildLLMMessages(requestMessages);
        let buffer = "";
        let sentenceCount = 0;
        const tStart = Date.now();

        log.debug({ messageCount: llmMessages.length }, "LLM stream started");

        for await (const token of streamLLMTokens(llmMessages)) {
          buffer += token;
          fullResponseText += token;

          const { sentences, remainder } = extractCompleteSentences(buffer);
          buffer = remainder;

          for (const sentence of sentences) {
            log.debug({ sentence: sentence.slice(0, 80), sentenceIdx: sentenceCount }, "Queuing sentence for TTS");
            enqueueSentenceTTS(sentence, sentenceCount++);
          }
        }

        // Flush any trailing text that didn't end with whitespace-terminated punct.
        const flush = buffer.trim();
        if (flush) {
          log.debug({ sentence: flush.slice(0, 80), sentenceIdx: sentenceCount }, "Flushing final sentence to TTS");
          enqueueSentenceTTS(flush, sentenceCount++);
        }

        log.info({ durationMs: Date.now() - tStart, response: fullResponseText || "[empty]" }, "LLM stream complete");
        llmDone = true;
        if (queueNotify) { const r = queueNotify; queueNotify = null; r(); } // wake play loop if it's waiting

        // Persist assistant turn to conversation history now that we have the full text.
        const activeSession = getListeningSession(channel.guild.id);
        if (activeSession?.active) {
          appendConversationMessage(activeSession, "assistant", fullResponseText);
        }

        await playbackLoop;
        stopBeeping(); // no-op if already stopped; guards the empty-response case
        signalResponseReady();
      } catch (error) {
        stopBeeping();
        signalResponseReady();
        log.error({ err: error, requestId }, "Response cycle failed");
      }
    })();
  }
}

client.once("ready", async () => {
  log.info({ tag: client.user.tag }, "Bot ready");
  try {
    await registerSlashCommands();
    log.info({ guilds: client.guilds.cache.size }, "Slash commands registered");
  } catch (error) {
    log.error({ err: error }, "Failed to register slash commands");
  }

  log.info("Commands: /glados join | /glados ask <prompt> | /glados say <text> | /glados leave");
});

client.on("guildCreate", async (guild) => {
  log.info({ guild: guild.name, guildId: guild.id }, "Joined new guild, registering commands");
  try {
    await guild.commands.set(buildSlashCommands());
  } catch (error) {
    log.error({ err: error, guildId: guild.id }, "Failed to register slash commands for guild");
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.guildId) {
    return;
  }

  if (interaction.commandName === "glados") {
    const sub = interaction.options.getSubcommand();
    const user = interaction.user?.tag || interaction.user?.username || "unknown";
    const guild = interaction.guild?.name || interaction.guildId;
    const channel = getInvokerVoiceChannel(interaction)?.name || "unknown";

    log.info({ sub, user, guild, channel }, "/glados invoked");

    try {
      if (sub === "say") {
        const sayText = interaction.options.getString("text", true).trim();
        log.debug({ chars: sayText.length }, "/glados say text received");
        await replyEphemeral(interaction, "Speaking in your voice channel.");
        void sayDirectText(interaction, sayText)
          .then(() => replyEphemeral(interaction, "Done."))
          .catch(async (error) => {
            log.error({ err: error }, "/glados say pipeline failed");
            await replyEphemeral(interaction, `Error: ${error.message}`);
          });
        return;
      }

      if (sub === "ask") {
        const typedPrompt = interaction.options.getString("prompt", true).trim();
        log.debug({ chars: typedPrompt.length }, "/glados ask prompt received");
        await replyEphemeral(interaction, "Generating a voice response.");
        void speakTextResponse(interaction, typedPrompt)
          .then(() => replyEphemeral(interaction, "Played the response in your voice channel."))
          .catch(async (error) => {
            log.error({ err: error }, "/glados ask pipeline failed");
            await replyEphemeral(interaction, `Error: ${error.message}`);
          });
        return;
      }

      if (sub === "leave") {
        const connection = getVoiceConnection(interaction.guildId);
        if (!connection) {
          await replyEphemeral(interaction, "GLaDOS is not connected.");
          return;
        }
        cleanupListeningSession(interaction.guildId);
        await playAndDisconnect(interaction.guildId);
        log.info({ guild }, "Disconnected by user request");
        await replyEphemeral(interaction, "Disconnected.");
        return;
      }

      // sub === "join"
      await startOpusListening(interaction);
      await replyEphemeral(
        interaction,
        "Listening in your voice channel. Say 'go away GLaDOS' to disconnect.",
      );
      void runVoiceConversationLoop(interaction).catch(async (error) => {
        log.error({ err: error }, "/glados join pipeline failed");
        if (getListeningSession(interaction.guildId)) {
          await replyEphemeral(interaction, `Error: ${error.message}`);
        }
      });
    } catch (error) {
      log.error({ err: error, sub }, "/glados command failed");
      await replyEphemeral(interaction, `Error: ${error.message}`);
    }
  }
});

player.on(AudioPlayerStatus.Idle, () => {
  const currentPlayback = playbackState.current;

  if (!currentPlayback) {
    return;
  }

  log.info({ guildId: currentPlayback.guildId }, "Playback finished");
  playbackState.current = null;
  if (currentPlayback.transcoder && !currentPlayback.transcoder.killed) {
    currentPlayback.transcoder.kill("SIGTERM");
  }

  if (currentPlayback.mp3Path && !currentPlayback.keepFile) {
    fs.unlink(currentPlayback.mp3Path, (err) => {
      if (err) log.error({ err, mp3Path: currentPlayback.mp3Path }, "Failed to delete TTS file");
    });
  }

  if (currentPlayback.disconnectOnFinish) {
    const connection = getVoiceConnection(currentPlayback.guildId);
    if (connection) {
      cleanupListeningSession(currentPlayback.guildId);
      connection.destroy();
      log.info({ guildId: currentPlayback.guildId }, "Disconnected after playback");
    }
  }

  currentPlayback.resolve({ interrupted: false });
});

player.on("error", (error) => {
  log.error({ err: error }, "Audio player error");

  const currentPlayback = playbackState.current;

  if (!currentPlayback) {
    return;
  }

  playbackState.current = null;
  if (currentPlayback.transcoder && !currentPlayback.transcoder.killed) {
    currentPlayback.transcoder.kill("SIGTERM");
  }

  if (currentPlayback.mp3Path) {
    fs.unlink(currentPlayback.mp3Path, (err) => {
      if (err) log.error({ err, mp3Path: currentPlayback.mp3Path }, "Failed to delete TTS file");
    });
  }

  currentPlayback.reject(error);
});

client.login(token);
