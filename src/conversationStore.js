// In-memory store for active conversations per JID
// Persistence of known clients is handled by clientsDb.js

const conversations = new Map();

const MAX_IDLE_MS = 2 * 60 * 60 * 1000;
const MAX_MESSAGES = 40;

function getConversation(jid) {
  return conversations.get(jid) || null;
}

function initConversation(jid, isExistingClient = false) {
  const conv = {
    history: [],
    classification: 'PENDIENTE',
    lastActivity: new Date(),
    messageCount: 0,
    summarySet: false,
    isExistingClient,
    drNotified: false,
  };
  conversations.set(jid, conv);
  return conv;
}

function addMessage(jid, role, content) {
  let conv = conversations.get(jid);
  if (!conv) conv = initConversation(jid);

  conv.history.push({ role, content });
  conv.lastActivity = new Date();
  conv.messageCount++;

  if (conv.history.length > MAX_MESSAGES) {
    conv.history = conv.history.slice(conv.history.length - MAX_MESSAGES);
  }

  return conv;
}

function updateClassification(jid, classification, summary) {
  const conv = conversations.get(jid);
  if (!conv) return;
  conv.classification = classification;
  if (summary) conv.summary = summary;
}

function markSummarySent(jid) {
  const conv = conversations.get(jid);
  if (conv) conv.summarySet = true;
}

function markDrNotified(jid) {
  const conv = conversations.get(jid);
  if (conv) conv.drNotified = true;
}

setInterval(() => {
  const now = Date.now();
  for (const [jid, conv] of conversations.entries()) {
    if (now - conv.lastActivity.getTime() > MAX_IDLE_MS) {
      conversations.delete(jid);
    }
  }
}, 20 * 60 * 1000);

module.exports = {
  getConversation,
  initConversation,
  addMessage,
  updateClassification,
  markSummarySent,
  markDrNotified,
};
