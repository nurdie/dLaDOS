require("./config"); // ensure env is loaded and dirs are created

const { Client, GatewayIntentBits } = require("discord.js");

const log = require("./logger");
const { token } = require("./config");
const { buildSlashCommands, registerSlashCommands, handleInteraction } = require("./commands");

require("./audio"); // registers player event handlers

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once("ready", async () => {
  log.info({ tag: client.user.tag }, "Bot ready");
  try {
    await registerSlashCommands(client);
    log.info({ guilds: client.guilds.cache.size }, "Slash commands registered");
  } catch (error) {
    log.error({ err: error }, "Failed to register slash commands");
  }
  log.info("Commands: /glados join | /glados join_wake | /glados ask <prompt> | /glados say <text> | /glados leave");
});

client.on("guildCreate", async (guild) => {
  log.info({ guild: guild.name, guildId: guild.id }, "Joined new guild, registering commands");
  try {
    await guild.commands.set(buildSlashCommands());
  } catch (error) {
    log.error({ err: error, guildId: guild.id }, "Failed to register slash commands for guild");
  }
});

client.on("interactionCreate", handleInteraction);

client.login(token);
