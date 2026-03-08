const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  createAudioPlayer,
  createAudioResource,
  getVoiceConnection,
} = require("@discordjs/voice");

const log = require("./logger");
const { ffmpegPath, turretGoodbyePath } = require("./config");
const { cleanupListeningSession } = require("./session");

const player = createAudioPlayer({
  behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
});

const playbackState = {
  current: null,
  serial: 0,
};

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
    if (!message) return;
    const expectedPreemptionErrors = [
      "Connection reset by peer",
      "Error submitting a packet to the muxer",
      "Error muxing a packet",
      "Task finished with error code: -104",
      "Terminating thread with return code -104",
      "Error writing trailer",
      "Error closing file",
    ];
    if (expectedPreemptionErrors.some((p) => message.includes(p))) {
      log.debug({ message }, "ffmpeg preemption (expected)");
      return;
    }
    log.error({ message }, "ffmpeg stderr");
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

function stopPlaybackForGuild(guildId) {
  const currentPlayback = playbackState.current;
  if (!currentPlayback || currentPlayback.guildId !== guildId) return;

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
  if (!connection) throw new Error("Voice connection is no longer active.");

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

async function playAndDisconnect(guildId) {
  if (fs.existsSync(turretGoodbyePath)) {
    try { await playSpeechResponse(guildId, turretGoodbyePath, false, true); } catch {}
  }
  const connection = getVoiceConnection(guildId);
  if (connection) connection.destroy();
}

// ── Player event handlers ─────────────────────────────────────────────────────

player.on(AudioPlayerStatus.Idle, () => {
  const currentPlayback = playbackState.current;
  if (!currentPlayback) return;

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
  if (!currentPlayback) return;

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

module.exports = {
  player,
  playbackState,
  createMp3Resource,
  stopPlaybackForGuild,
  playSpeechResponse,
  playAndDisconnect,
};
