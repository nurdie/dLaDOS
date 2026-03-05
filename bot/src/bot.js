const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { appendFile, writeFile } = require("node:fs/promises");
const prism = require("prism-media");
const dotenv = require("dotenv");
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
const defaultSystemPrompt =
  process.env.GLADOS_SYSTEM_PROMPT ||
  "You are GLaDOS from Portal: dry, laconic, superior, sardonic, subtly menacing.";

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

  console.log(`Prompt logged (${mode}): ${prompt}`);

  try {
    await appendFile(promptLogPath, entry, "utf8");
  } catch (error) {
    console.error("Failed to write prompt log:", error);
  }
}

function buildSlashCommands() {
  return [
    new SlashCommandBuilder()
      .setName("glados")
      .setDescription("Start a voice session or speak a typed prompt.")
      .addStringOption((option) =>
        option
          .setName("say")
          .setDescription("Speak this text directly via TTS, no LLM involved")
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName("text")
          .setDescription("Optional text prompt to speak immediately")
          .setRequired(false),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("leave")
      .setDescription("Disconnect GLaDOS from the current voice channel.")
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
  return [
    {
      role: "system",
      content: defaultSystemPrompt,
    },
  ];
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

  const connection =
    getVoiceConnection(channel.guild.id) ||
    joinVoiceChannel({
      adapterCreator: channel.guild.voiceAdapterCreator,
      channelId: channel.id,
      guildId: channel.guild.id,
      selfDeaf: false,
    });

  connection.subscribe(player);
  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);

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

  console.log(
    `Listening for Opus audio in ${channel.guild.name} / ${channel.name} (${subscribedUserIds.size} users)`,
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
        return;
      }

      console.error(message);
    }
  });

  ffmpeg.on("error", (error) => {
    console.error("ffmpeg process failed:", error);
  });

  return {
    process: ffmpeg,
    resource: createAudioResource(ffmpeg.stdout, {
      inputType: StreamType.Raw,
      silencePaddingFrames: 5,
    }),
  };
}

function captureFirstSpeaker(connection, channel, subscribedUserIds) {
  if (subscribedUserIds.size === 0) {
    throw new Error("I could not subscribe to anyone in this voice channel.");
  }

  return new Promise((resolve, reject) => {
    let finished = false;
    let timeoutId;
    let input = null;
    let decoder = null;
    let ffmpeg = null;

    const cleanup = () => {
      connection.receiver.speaking.off("start", onSpeakingStart);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (input) {
        input.destroy();
      }
      if (decoder) {
        decoder.destroy();
      }
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

      const member = channel.members.get(userId);
      input = connection.receiver.subscribe(userId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: 2_500,
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

    timeoutId = setTimeout(() => {
      finish(reject, new Error("No one started speaking within 30 seconds."));
    }, 30_000);

    connection.receiver.speaking.on("start", onSpeakingStart);
  });
}

async function recordFirstSpeaker(message) {
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

  return captureFirstSpeaker(connection, channel, subscribedUserIds);
}

function getPythonExecutable() {
  return process.env.PYTHON || "python3";
}

function transcribeWithWhisper(audioPath) {
  if (!fs.existsSync(whisperScriptPath)) {
    throw new Error(`Missing Whisper wrapper script: ${whisperScriptPath}`);
  }

  return new Promise((resolve, reject) => {
    const python = getPythonExecutable();
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

      resolve(stdout.trim());
    });
  });
}

function generateResponseFromTranscript(transcript, typedPrompt = "") {
  if (!fs.existsSync(responseScriptPath)) {
    throw new Error(`Missing response script: ${responseScriptPath}`);
  }

  return new Promise((resolve, reject) => {
    const python = getPythonExecutable();
    const args = [responseScriptPath, transcript];

    if (typedPrompt.trim()) {
      args.push(typedPrompt.trim());
    }

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

      resolve(stdout.trim());
    });
  });
}

function generateResponseFromMessages(messages) {
  if (!fs.existsSync(responseScriptPath)) {
    throw new Error(`Missing response script: ${responseScriptPath}`);
  }

  return new Promise((resolve, reject) => {
    const python = getPythonExecutable();
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

      resolve(stdout.trim());
    });
  });
}

async function captureUntilTranscript(message, label, maxAttempts = 5) {
  let lastCapture = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const capture = await captureAndTranscribe(message, `${label} attempt ${attempt}`);
    lastCapture = capture;

    if (capture.transcript) {
      return capture;
    }

    console.log(`${label}: transcript was empty on attempt ${attempt}, listening again.`);
  }

  throw new Error(
    `Whisper returned an empty transcript after ${maxAttempts} attempts${
      lastCapture ? ` (last file: ${path.relative(process.cwd(), lastCapture.outputPath)})` : ""
    }`,
  );
}

async function synthesizeSpeechToMp3(text, outputPath = ttsOutputPath) {
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
  return outputPath;
}

function stopPlaybackForGuild(guildId) {
  const currentPlayback = playbackState.current;

  if (!currentPlayback || currentPlayback.guildId !== guildId) {
    return;
  }

  playbackState.current = null;
  if (currentPlayback.transcoder && !currentPlayback.transcoder.killed) {
    currentPlayback.transcoder.kill("SIGTERM");
  }

  if (currentPlayback.mp3Path) {
    fs.unlink(currentPlayback.mp3Path, (err) => {
      if (err) console.error(`Failed to delete TTS file ${currentPlayback.mp3Path}:`, err);
    });
  }

  currentPlayback.resolve({ interrupted: true });
  player.stop(true);
}

function playSpeechResponse(guildId, mp3Path, disconnectOnFinish = false) {
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
      mp3Path,
      reject,
      resolve,
      token: ++playbackState.serial,
      transcoder,
    };

    player.play(resource);
  });
}

async function speakTextResponse(message, text) {
  await logPrompt(
    message,
    text,
    "slash-text",
    message.user?.tag || message.user?.username || "",
  );
  const responseTextForTts = await generateResponseFromTranscript(text);
  console.log(`!glados response: ${responseTextForTts || "[empty]"}`);

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

async function captureAndTranscribe(message, label) {
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

    result = await captureFirstSpeaker(connection, channel, existingSession.subscribedUserIds);
  } else {
    result = await recordFirstSpeaker(message);
  }

  console.log(`Recorded ${result.username} to ${path.relative(process.cwd(), result.outputPath)}`);

  const transcript = await transcribeWithWhisper(result.outputPath);
  console.log(`${label} transcript (${result.username}): ${transcript || "[empty]"}`);

  fs.unlink(result.outputPath, (err) => {
    if (err) console.error(`Failed to delete recording ${result.outputPath}:`, err);
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

async function runVoiceConversationLoop(message) {
  const channel = getInvokerVoiceChannel(message);

  if (!channel) {
    throw new Error("Join a voice channel before using this command.");
  }

  while (true) {
    const session = getListeningSession(channel.guild.id);

    if (!session || !session.active || session.channelId !== channel.id) {
      return;
    }

    let capture;

    try {
      capture = await captureUntilTranscript(message, "!glados");
    } catch (error) {
      console.error("!glados listen cycle failed:", error);
      continue;
    }

    if (shouldDisconnectOnTranscript(capture.transcript)) {
      console.log("!glados shutdown phrase detected; disconnecting.");
      const connection = getVoiceConnection(channel.guild.id);
      cleanupListeningSession(channel.guild.id);
      if (connection) {
        stopPlaybackForGuild(channel.guild.id);
        connection.destroy();
      }
      return;
    }

    session.requestSerial += 1;
    const requestId = session.requestSerial;
    await logPrompt(message, capture.transcript, "voice");
    appendConversationMessage(session, "user", capture.transcript);
    const requestMessages = session.conversationHistory.map((entry) => ({ ...entry }));

    void (async () => {
      try {
        const responseTextForTts = await generateResponseFromMessages(requestMessages);
        console.log(`!glados response: ${responseTextForTts || "[empty]"}`);

        if (!responseTextForTts) {
          return;
        }

        const activeSession = getListeningSession(channel.guild.id);
        if (!activeSession || !activeSession.active || activeSession.channelId !== channel.id) {
          return;
        }

        appendConversationMessage(activeSession, "assistant", responseTextForTts);

        if (requestId < activeSession.latestStartedPlaybackRequestId) {
          return;
        }

        const speechPath = await synthesizeSpeechToMp3(
          responseTextForTts,
          path.join(audioDir, `speech-${channel.guild.id}-${requestId}.mp3`),
        );

        const latestSession = getListeningSession(channel.guild.id);
        if (!latestSession || !latestSession.active || latestSession.channelId !== channel.id) {
          return;
        }

        if (requestId < latestSession.latestStartedPlaybackRequestId) {
          return;
        }

        latestSession.latestStartedPlaybackRequestId = requestId;
        await playSpeechResponse(channel.guild.id, speechPath, false);
      } catch (error) {
        console.error("!glados response cycle failed:", error);
      }
    })();
  }
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    await registerSlashCommands();
    console.log("Registered slash commands for connected guilds.");
  } catch (error) {
    console.error("Failed to register slash commands:", error);
  }

  console.log("Slash commands:");
  console.log("  /glados");
  console.log("  /glados say:<text>");
  console.log("  /glados text:<prompt>");
  console.log("  /leave");
});

client.on("guildCreate", async (guild) => {
  try {
    await guild.commands.set(buildSlashCommands());
  } catch (error) {
    console.error(`Failed to register slash commands for guild ${guild.id}:`, error);
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.guildId) {
    return;
  }

  if (interaction.commandName === "glados") {
    const sayText = (interaction.options.getString("say") || "").trim();
    const typedPrompt = (interaction.options.getString("text") || "").trim();

    try {
      if (sayText) {
        await replyEphemeral(interaction, "Speaking in your voice channel.");
        void sayDirectText(interaction, sayText)
          .then(() => replyEphemeral(interaction, "Done."))
          .catch(async (error) => {
            console.error("/glados say pipeline failed:", error);
            await replyEphemeral(interaction, `Error: ${error.message}`);
          });
        return;
      }

      if (typedPrompt) {
        await replyEphemeral(interaction, "Generating a voice response.");
        void speakTextResponse(interaction, typedPrompt)
          .then(() => replyEphemeral(interaction, "Played the response in your voice channel."))
          .catch(async (error) => {
            console.error("/glados text pipeline failed:", error);
            await replyEphemeral(interaction, `Error: ${error.message}`);
          });
        return;
      }

      await startOpusListening(interaction);
      await replyEphemeral(
        interaction,
        "Listening in your voice channel. Say 'go away gladoss' to disconnect.",
      );
      void runVoiceConversationLoop(interaction).catch(async (error) => {
        console.error("/glados pipeline failed:", error);
        if (getListeningSession(interaction.guildId)) {
          await replyEphemeral(interaction, `Error: ${error.message}`);
        }
      });
    } catch (error) {
      console.error("/glados failed:", error);
      await replyEphemeral(interaction, `Error: ${error.message}`);
    }

    return;
  }

  if (interaction.commandName === "leave") {
    const connection = getVoiceConnection(interaction.guildId);

    if (!connection) {
      await replyEphemeral(interaction, "GLaDOS is not connected.");
      return;
    }

    cleanupListeningSession(interaction.guildId);
    stopPlaybackForGuild(interaction.guildId);
    connection.destroy();
    await replyEphemeral(interaction, "Disconnected.");
  }
});

player.on(AudioPlayerStatus.Idle, () => {
  console.log("Playback finished.");

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
      if (err) console.error(`Failed to delete TTS file ${currentPlayback.mp3Path}:`, err);
    });
  }

  if (currentPlayback.disconnectOnFinish) {
    const connection = getVoiceConnection(currentPlayback.guildId);
    if (connection) {
      cleanupListeningSession(currentPlayback.guildId);
      connection.destroy();
    }
  }

  currentPlayback.resolve({ interrupted: false });
});

player.on("error", (error) => {
  console.error("Audio player error:", error);

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
      if (err) console.error(`Failed to delete TTS file ${currentPlayback.mp3Path}:`, err);
    });
  }

  currentPlayback.reject(error);
});

client.login(token);
