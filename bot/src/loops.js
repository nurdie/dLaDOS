const fs = require("node:fs");
const path = require("node:path");

const log = require("./logger");
const { audioDir, portalbeepPath, turretHelloPath, turretHoorayPath } = require("./config");
const { getListeningSession, cleanupListeningSession, appendConversationMessage } = require("./session");
const { playSpeechResponse, playbackState, playAndDisconnect } = require("./audio");
const { captureUntilTranscript, captureAndTranscribeNoTimeout, getInvokerVoiceChannel, IdleTimeoutError } = require("./capture");
const { streamLLMTokens, extractCompleteSentences, buildLLMMessages } = require("./llm");
const { synthesizeSpeechToMp3 } = require("./tts");

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

function containsWakeWord(transcript) {
  const normalized = transcript.toLowerCase();
  return (
    normalized.includes("gladoss") ||
    normalized.includes("glad os") ||
    normalized.includes("glados") ||
    normalized.includes("galatos") ||
    normalized.includes("glad o's") ||
    normalized.includes("glad us") ||
    normalized.includes("gladys") ||
    normalized.includes("glad of us") ||
    normalized.includes("glad else") ||
    normalized.includes("latos") ||
    normalized.includes("flat-o's") ||
    normalized.includes("laddows") ||
    normalized.includes("glad off") ||
    normalized.includes("glittos") ||
    normalized.includes("gladiffs") ||
    normalized.includes("glattos") ||
    normalized.includes("glad of") ||
    normalized.includes("gladto") ||
    normalized.includes("plattos")
  );
}

/**
 * Stream LLM tokens → sentence-chunked TTS → queued playback.
 * Shared by both conversation and wake-word loops.
 *
 * Returns a promise that resolves when all audio has finished playing.
 * `onFirstAudioReady` is called synchronously before the first sentence plays
 * (used to stop the portalbeep loop).
 */
async function streamResponseToAudio(channel, session, requestId, requestMessages) {
  const sentencePaths = [];
  let queueNotify = null;
  let llmDone = false;
  let fullResponseText = "";

  const enqueueSentenceTTS = (text, idx) => {
    const audioPath = path.join(audioDir, `speech-${channel.guild.id}-${requestId}-${idx}.mp3`);
    const p = synthesizeSpeechToMp3(text, audioPath).catch((err) => {
      log.error({ err, text: text.slice(0, 60) }, "Sentence TTS failed");
      fs.unlink(audioPath, () => {});
      return null;
    });
    sentencePaths.push(p);
    if (queueNotify) { const r = queueNotify; queueNotify = null; r(); }
  };

  let stopBeeping = () => {};

  // Start portalbeep loop (fire-and-forget; stopped when first audio is ready)
  if (fs.existsSync(portalbeepPath)) {
    let beeping = true;
    stopBeeping = () => { beeping = false; };

    (async () => {
      // Wait for any ongoing TTS to finish before beeping
      while (beeping && playbackState.current && !playbackState.current.keepFile) {
        await new Promise((r) => setTimeout(r, 100));
      }
      while (beeping) {
        try {
          const result = await playSpeechResponse(channel.guild.id, portalbeepPath, false, true);
          if (!beeping || result.interrupted) break;
          await new Promise((r) => setTimeout(r, 1000));
        } catch { break; }
      }
    })();
  }

  // Play loop: drains sentencePaths in order as TTS resolves
  const playbackLoop = (async () => {
    let idx = 0;
    let firstAudio = true;

    while (true) {
      if (idx < sentencePaths.length) {
        const audioPath = await sentencePaths[idx++];
        if (!audioPath) continue;

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
        await new Promise((r) => { queueNotify = r; });
      }
    }
  })();

  // Stream LLM tokens → sentence detection → TTS queue
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

  const flush = buffer.trim();
  if (flush) {
    log.debug({ sentence: flush.slice(0, 80), sentenceIdx: sentenceCount }, "Flushing final sentence to TTS");
    enqueueSentenceTTS(flush, sentenceCount++);
  }

  log.info({ durationMs: Date.now() - tStart, response: fullResponseText || "[empty]" }, "LLM stream complete");
  llmDone = true;
  if (queueNotify) { const r = queueNotify; queueNotify = null; r(); }

  const activeSession = getListeningSession(channel.guild.id);
  if (activeSession?.active) {
    appendConversationMessage(activeSession, "assistant", fullResponseText);
  }

  await playbackLoop;
  stopBeeping(); // guard for empty-response case
}

// ── /glados join ──────────────────────────────────────────────────────────────

async function runVoiceConversationLoop(message) {
  const channel = getInvokerVoiceChannel(message);
  if (!channel) throw new Error("Join a voice channel before using this command.");

  if (fs.existsSync(turretHelloPath)) {
    try { await playSpeechResponse(channel.guild.id, turretHelloPath, false, true); } catch {}
  }

  let responseReadyPromise = Promise.resolve();

  while (true) {
    const session = getListeningSession(channel.guild.id);
    if (!session || !session.active || session.channelId !== channel.id) return;

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

    const session2 = getListeningSession(channel.guild.id);
    if (!session2) return;

    session2.requestSerial += 1;
    const requestId = session2.requestSerial;
    appendConversationMessage(session2, "user", capture.transcript);
    const requestMessages = session2.conversationHistory.map((entry) => ({ ...entry }));

    let signalResponseReady;
    responseReadyPromise = new Promise((resolve) => { signalResponseReady = resolve; });

    void (async () => {
      try {
        await streamResponseToAudio(channel, session2, requestId, requestMessages);
        signalResponseReady();
      } catch (error) {
        signalResponseReady();
        log.error({ err: error, requestId }, "Response cycle failed");
      }
    })();
  }
}

// ── /glados join_wake ─────────────────────────────────────────────────────────

const WAKE_HELLO_COOLDOWN_MS = 60_000;

async function runWakeWordLoop(message) {
  const channel = getInvokerVoiceChannel(message);
  if (!channel) throw new Error("Join a voice channel before using this command.");

  if (fs.existsSync(turretHoorayPath)) {
    try { await playSpeechResponse(channel.guild.id, turretHoorayPath, false, true); } catch {}
  }

  let lastWakeWordAt = 0;

  while (true) {
    const session = getListeningSession(channel.guild.id);
    if (!session || !session.active || session.channelId !== channel.id) return;

    let capture;

    try {
      capture = await captureAndTranscribeNoTimeout(message, "wake-word");
    } catch (error) {
      log.error({ err: error }, "Wake-word listen cycle failed");
      continue;
    }

    const { transcript } = capture;

    if (shouldDisconnectOnTranscript(transcript)) {
      log.info({ transcript }, "Shutdown phrase detected, disconnecting");
      cleanupListeningSession(channel.guild.id);
      await playAndDisconnect(channel.guild.id);
      return;
    }

    if (!containsWakeWord(transcript)) {
      log.debug({ transcript: transcript || "[empty]" }, "Wake word not detected, ignoring");
      continue;
    }

    log.info({ transcript }, "Wake word detected, engaging LLM pipeline");

    // Play greeting only if the wake word hasn't been used in over 60 seconds.
    const now = Date.now();
    if (fs.existsSync(turretHelloPath) && now - lastWakeWordAt > WAKE_HELLO_COOLDOWN_MS) {
      try { await playSpeechResponse(channel.guild.id, turretHelloPath, false, true); } catch {}
    }
    lastWakeWordAt = now;

    const session2 = getListeningSession(channel.guild.id);
    if (!session2 || !session2.active) return;

    session2.requestSerial += 1;
    const requestId = session2.requestSerial;
    appendConversationMessage(session2, "user", transcript);
    const requestMessages = session2.conversationHistory.map((entry) => ({ ...entry }));

    try {
      await streamResponseToAudio(channel, session2, requestId, requestMessages);
    } catch (error) {
      log.error({ err: error, requestId }, "Wake-word response cycle failed");
    }
  }
}

module.exports = { runVoiceConversationLoop, runWakeWordLoop };
