const log = require("./logger");
const { maxConversationChars } = require("./config");

const listeningSessions = new Map();

function getListeningSession(guildId) {
  return listeningSessions.get(guildId) || null;
}

function cleanupListeningSession(guildId) {
  const session = listeningSessions.get(guildId);
  if (!session) return;
  session.active = false;
  listeningSessions.delete(guildId);
  log.debug({ guildId }, "Listening session cleaned up");
}

function createConversationHistory() {
  return [];
}

function trimConversationHistory(history) {
  if (!history.length) return createConversationHistory();

  const [systemMessage, ...rest] = history;
  let totalChars = systemMessage.content.length;
  const kept = [];

  for (let index = rest.length - 1; index >= 0; index -= 1) {
    const message = rest[index];
    const nextChars = totalChars + message.content.length;

    if (nextChars > maxConversationChars && kept.length > 0) break;

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
  if (!trimmedContent) return;
  session.conversationHistory.push({ role, content: trimmedContent });
  session.conversationHistory = trimConversationHistory(session.conversationHistory);
}

module.exports = {
  listeningSessions,
  getListeningSession,
  cleanupListeningSession,
  createConversationHistory,
  appendConversationMessage,
};
