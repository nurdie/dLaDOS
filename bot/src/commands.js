const fs = require("node:fs");
const path = require("node:path");
const { appendFile } = require("node:fs/promises");
const { SlashCommandBuilder } = require("discord.js");

const log = require("./logger");
const { audioDir, promptLogPath } = require("./config");
const { getListeningSession, cleanupListeningSession } = require("./session");
const { playSpeechResponse, playAndDisconnect } = require("./audio");
const { getInvokerVoiceChannel, connectToMemberChannel, startOpusListening } = require("./capture");
const { generateResponseFromTranscript } = require("./llm");
const { synthesizeSpeechToMp3 } = require("./tts");
const { runVoiceConversationLoop, runWakeWordLoop } = require("./loops");
const { getVoiceConnection } = require("@discordjs/voice");

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

async function replyEphemeral(interaction, content) {
  if (interaction.replied || interaction.deferred) {
    await interaction.editReply({ content });
    return;
  }
  await interaction.reply({ content, ephemeral: true });
}

async function speakTextResponse(interaction, text) {
  await logPrompt(interaction, text, "slash-ask", interaction.user?.tag || interaction.user?.username || "");
  const responseTextForTts = await generateResponseFromTranscript(text);
  log.info({ response: responseTextForTts || "[empty]" }, "LLM response (ask)");

  if (!responseTextForTts) return;

  await connectToMemberChannel(interaction);
  const speechPath = await synthesizeSpeechToMp3(
    responseTextForTts,
    path.join(audioDir, `speech-${interaction.guild.id}-${Date.now()}.mp3`),
  );
  await playSpeechResponse(interaction.guild.id, speechPath, true);
}

async function sayDirectText(interaction, text) {
  await connectToMemberChannel(interaction);
  const speechPath = await synthesizeSpeechToMp3(
    text,
    path.join(audioDir, `speech-${interaction.guild.id}-${Date.now()}.mp3`),
  );
  await playSpeechResponse(interaction.guild.id, speechPath, true);
}

function buildSlashCommands() {
  return [
    new SlashCommandBuilder()
      .setName("glados")
      .setDescription("GLaDOS voice commands.")
      .addSubcommand((sub) =>
        sub.setName("join").setDescription("Join your voice channel and start listening."),
      )
      .addSubcommand((sub) =>
        sub
          .setName("join_wake")
          .setDescription("Join your voice channel and listen for the wake word 'GLaDOS'."),
      )
      .addSubcommand((sub) =>
        sub
          .setName("ask")
          .setDescription("Send a text prompt through the LLM and speak the response.")
          .addStringOption((option) =>
            option.setName("prompt").setDescription("Your prompt for GLaDOS").setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("say")
          .setDescription("Speak text directly via TTS, no LLM involved.")
          .addStringOption((option) =>
            option.setName("text").setDescription("Text to speak").setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName("leave").setDescription("Disconnect GLaDOS from the current voice channel."),
      )
      .toJSON(),
  ];
}

async function registerSlashCommands(client) {
  const commands = buildSlashCommands();
  const guilds = [...client.guilds.cache.values()];
  await Promise.all(guilds.map((guild) => guild.commands.set(commands)));
}

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand() || !interaction.guildId) return;
  if (interaction.commandName !== "glados") return;

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

    if (sub === "join_wake") {
      await startOpusListening(interaction);
      await replyEphemeral(
        interaction,
        "Listening for the wake word 'GLaDOS'. Say 'go away GLaDOS' to disconnect.",
      );
      void runWakeWordLoop(interaction).catch(async (error) => {
        log.error({ err: error }, "/glados join_wake pipeline failed");
        if (getListeningSession(interaction.guildId)) {
          await replyEphemeral(interaction, `Error: ${error.message}`);
        }
      });
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

module.exports = { buildSlashCommands, registerSlashCommands, handleInteraction };
