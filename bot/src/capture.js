const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const prism = require("prism-media");
const {
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} = require("@discordjs/voice");

const log = require("./logger");
const { ffmpegPath, recordingsDir, turretAreYouPath, turretWhosPath } = require("./config");
const { listeningSessions, getListeningSession, cleanupListeningSession, createConversationHistory } = require("./session");
const { player, playSpeechResponse } = require("./audio");
const { transcribeWithWhisperHttp } = require("./transcribe");

class IdleTimeoutError extends Error {}

function sanitizeFilenamePart(value) {
  return value.replace(/[^a-z0-9_-]/gi, "_");
}

function getInvokerVoiceChannel(source) {
  const directChannel = source.member?.voice?.channel;
  if (directChannel) return directChannel;
  const userId = source.user?.id || source.author?.id;
  return source.guild?.members?.cache?.get(userId)?.voice?.channel || null;
}

async function connectToMemberChannel(message) {
  const channel = getInvokerVoiceChannel(message);
  if (!channel) throw new Error("Join a voice channel before using this command.");

  const existing = getVoiceConnection(channel.guild.id);
  const connection =
    existing ||
    joinVoiceChannel({
      adapterCreator: channel.guild.voiceAdapterCreator,
      channelId: channel.id,
      guildId: channel.guild.id,
      selfDeaf: false,
    });

  if (!existing) log.debug({ guild: channel.guild.name, channel: channel.name }, "Joining voice channel");
  connection.subscribe(player);
  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  log.debug({ guild: channel.guild.name, channel: channel.name }, "Voice connection ready");
  return connection;
}

function subscribeToChannelUsers(connection, channel) {
  const subscribedUserIds = new Set();
  for (const [userId, member] of channel.members) {
    if (!member.user.bot) subscribedUserIds.add(userId);
  }
  return subscribedUserIds;
}

/**
 * Core voice capture promise. withTimers=true enables the 10/20/30-second idle
 * timers (used by /glados join). withTimers=false listens indefinitely (used by
 * /glados join_wake).
 */
function _buildSpeakerCapture(connection, channel, subscribedUserIds, withTimers, delayTimersUntil = null) {
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
      if (input) input.destroy();
      if (decoder) decoder.destroy();
    };

    const playIdle = (soundPath) => {
      if (finished || !fs.existsSync(soundPath)) return;
      playSpeechResponse(channel.guild.id, soundPath, false, true).catch(() => {});
    };

    const finish = (handler, value) => {
      if (finished) return;
      finished = true;
      cleanup();
      handler(value);
    };

    const onSpeakingStart = (userId) => {
      if (finished || !subscribedUserIds.has(userId)) return;

      if (withTimers) {
        clearTimeout(t10);
        clearTimeout(t20);
        clearTimeout(t30);
        t10 = t20 = t30 = null;
      }

      const member = channel.members.get(userId);
      log.debug({ userId, username: member?.user?.tag || userId }, "Speaking detected");

      input = connection.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 800 },
      });
      decoder = new prism.opus.Decoder({ channels: 2, frameSize: 960, rate: 48_000 });

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
      ffmpeg.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      ffmpeg.once("error", (error) => { finish(reject, error); });
      ffmpeg.once("close", (code) => {
        if (code !== 0) {
          finish(reject, new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
          return;
        }
        finish(resolve, { outputPath, userId, username: member?.user?.tag || userId });
      });

      input.once("error", (error) => { decoder.destroy(error); });
      decoder.once("error", (error) => { ffmpeg.stdin.destroy(error); });
      input.pipe(decoder).pipe(ffmpeg.stdin);
    };

    const startTimers = () => {
      if (finished || !withTimers) return;
      t10 = setTimeout(() => { playIdle(turretAreYouPath); }, 10_000);
      t20 = setTimeout(() => { playIdle(turretWhosPath); }, 20_000);
      t30 = setTimeout(() => {
        finish(reject, new IdleTimeoutError("No voice detected for 30 seconds."));
      }, 30_000);
    };

    if (withTimers) {
      if (delayTimersUntil) delayTimersUntil.then(startTimers, startTimers);
      else startTimers();
    }

    connection.receiver.speaking.on("start", onSpeakingStart);
  });
}

function captureFirstSpeaker(connection, channel, subscribedUserIds, delayTimersUntil = null) {
  return _buildSpeakerCapture(connection, channel, subscribedUserIds, true, delayTimersUntil);
}

function captureFirstSpeakerNoTimeout(connection, channel, subscribedUserIds) {
  return _buildSpeakerCapture(connection, channel, subscribedUserIds, false, null);
}

async function _captureAndTranscribeCore(message, label, captureFn) {
  const channel = getInvokerVoiceChannel(message);
  if (!channel) throw new Error("Join a voice channel before using this command.");

  const existingSession = listeningSessions.get(channel.guild.id);
  let result;

  if (existingSession && existingSession.channelId === channel.id) {
    const connection = getVoiceConnection(channel.guild.id);
    if (!connection) {
      listeningSessions.delete(channel.guild.id);
      throw new Error("Voice connection is no longer active.");
    }
    result = await captureFn(connection, channel, existingSession.subscribedUserIds);
  } else {
    const connection = await connectToMemberChannel(message);
    const subscribedUserIds = subscribeToChannelUsers(connection, channel);
    result = await captureFn(connection, channel, subscribedUserIds);
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

  return { ...result, transcript };
}

async function captureAndTranscribe(message, label, delayTimersUntil = null) {
  return _captureAndTranscribeCore(message, label, (conn, ch, ids) =>
    captureFirstSpeaker(conn, ch, ids, delayTimersUntil),
  );
}

async function captureAndTranscribeNoTimeout(message, label) {
  return _captureAndTranscribeCore(message, label, captureFirstSpeakerNoTimeout);
}

async function captureUntilTranscript(message, label, maxAttempts = 5, delayTimersUntil = null) {
  let lastCapture = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const capture = await captureAndTranscribe(message, `${label} attempt ${attempt}`, delayTimersUntil);
    lastCapture = capture;

    if (capture.transcript) return capture;

    log.debug({ attempt, maxAttempts, label }, "Empty transcript, retrying");
  }

  throw new Error(
    `Whisper returned an empty transcript after ${maxAttempts} attempts${
      lastCapture ? ` (last file: ${path.relative(process.cwd(), lastCapture.outputPath)})` : ""
    }`,
  );
}

async function startOpusListening(message) {
  const channel = getInvokerVoiceChannel(message);
  if (!channel) throw new Error("Join a voice channel before using this command.");

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

module.exports = {
  IdleTimeoutError,
  getInvokerVoiceChannel,
  connectToMemberChannel,
  subscribeToChannelUsers,
  captureFirstSpeaker,
  captureFirstSpeakerNoTimeout,
  captureAndTranscribe,
  captureAndTranscribeNoTimeout,
  captureUntilTranscript,
  startOpusListening,
};
