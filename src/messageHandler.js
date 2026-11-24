const logger = require('./logger');
const { sendHumanLike } = require('./humanSimulator');
const { getAIResponse, generateFinalSummary, transcribeAudio } = require('./gemini');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const { getClient, saveClient, isKnownClient } = require('./clientsDb');
const { recordConversation } = require('./dailyLog');
const { getDrSendTargets } = require('./drConfig');
const {
  getConversation,
  initConversation,
  addMessage,
  updateClassification,
  markSummarySent,
  markDrNotified,
} = require('./conversationStore');

async function sendToDr(sock, text) {
  // Brief delay so Signal session renegotiation (triggered by the incoming message)
  // finishes before we send. Without this, the reply arrives before the admin's
  // WhatsApp has the new session keys and shows "esperando mensaje".
  await new Promise(r => setTimeout(r, 2000));
  const targets = getDrSendTargets();
  for (const jid of targets) {
    try {
      await sock.sendMessage(jid, { text: String(text ?? '') });
      logger.info(`Message sent to Dr. at ${jid}`);
      return;
    } catch (err) {
      logger.warn(`Failed to send to ${jid}: ${err.message}`);
    }
  }
  logger.error('Could not deliver message to admin on any JID');
}

const processing = new Set();

function extractText(msg) {
  const m = msg.message;
  return (
    m?.conversation ||
    m?.extendedTextMessage?.text ||
    m?.imageMessage?.caption ||
    m?.videoMessage?.caption ||
    ''
  ).trim();
}

function isAudioMessage(msg) {
  const m = msg.message;
  return !!(m?.audioMessage || m?.pttMessage);
}

async function downloadAndTranscribeAudio(sock, msg) {
  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
      logger,
      reuploadRequest: sock.updateMediaMessage,
    });
    const mimeType = msg.message?.audioMessage?.mimetype ||
                     msg.message?.pttMessage?.mimetype ||
                     'audio/ogg; codecs=opus';
    const transcription = await transcribeAudio(buffer, mimeType);
    logger.info(`Audio transcribed: "${transcription.slice(0, 80)}..."`);
    return transcription;
  } catch (err) {
    logger.error('Failed to transcribe audio:', err);
    return null;
  }
}

function extractContactNumber(jid) {
  // @lid JIDs don't contain the real phone number — use the raw ID as identifier
  if (jid.endsWith('@lid')) return jid.replace('@lid', '');
  return jid.replace('@s.whatsapp.net', '');
}

async function handleMessage(sock, msg, pushName = null) {
  const jid = msg.key.remoteJid;
  // @lid JIDs silently fail for outgoing — resolve to phone JID when available
  const replyJid = (jid.endsWith('@lid') && global.lidToPhone?.get(jid))
    ? global.lidToPhone.get(jid)
    : jid;
  const text = extractText(msg);

  if (processing.has(jid)) return;
  processing.add(jid);

  try {
    await sock.readMessages([msg.key]);

    let text = extractText(msg);
    if (!text && isAudioMessage(msg)) {
      const transcription = await downloadAndTranscribeAudio(sock, msg);
      if (!transcription) {
        text = '[El cliente envió un audio que no se pudo procesar. Pedile amablemente y de forma natural que te lo escriba, sin mencionar nada técnico.]';
      } else {
        text = `[Audio transcripto]: ${transcription}`;
      }
    }

    if (!text) return;

    const clientRecord = getClient(jid);
    const knownClient = isKnownClient(jid);
    const clientName = clientRecord?.name || pushName || null;
    const contactNumber = extractContactNumber(jid);

    let conv = getConversation(jid);
    const isNewConversation = !conv;

    if (!conv) {
      conv = initConversation(jid, knownClient);
    }

    // Notify admin when a known contact opens a new conversation
    if (knownClient && isNewConversation && !conv.drNotified) {
      const displayName = clientName || contactNumber;
      const alertText = `Aviso: ${displayName} (contacto registrado, numero ${contactNumber}) inicio una nueva conversacion. Se le esta atendiendo.`;
      await sendToDr(sock, alertText);
      markDrNotified(jid);
    }

    addMessage(jid, 'user', text);

    const historyForAI = conv.history.slice(0, -1);
    const { text: replyText, classification, summary, extractedName, extractedPhone } = await getAIResponse(
      historyForAI,
      text,
      clientName
    );

    addMessage(jid, 'model', replyText);
    updateClassification(jid, classification, summary);

    // Persist name and phone as soon as the AI extracts them
    if (extractedName || extractedPhone) {
      const update = {};
      if (extractedName) update.name = extractedName;
      if (extractedPhone) update.phone = extractedPhone;
      saveClient(jid, update);
      logger.info(`[${jid}] Saved: ${JSON.stringify(update)}`);
    }

    logger.info(`[${jid}] sending reply to ${replyJid}`);
    await sendHumanLike(sock, replyJid, replyText, text);
    logger.info(`[${jid}] reply sent ok`);

    if (classification === 'INTERESADO' && !conv.summarySet) {
      saveClient(jid, { name: extractedName });
      await handleClientSummary(sock, jid, conv, pushName);
    } else if (classification === 'CONSULTANDO' && !conv.summarySet) {
      markSummarySent(jid);
      logger.info(`[${jid}] Classified as CONSULTANDO — no summary sent`);
      logConversation(jid, conv, extractedName, classification);
    }
  } catch (err) {
    logger.error(`Error handling message from ${jid}: ${err.message}`);
    logger.error(err.stack);
  } finally {
    processing.delete(jid);
  }
}

async function handleClientSummary(sock, jid, conv, pushName = null) {
  try {
    const rawId = extractContactNumber(jid);
    const isLid = jid.endsWith('@lid');
    // For @lid contacts the rawId is not a phone number
    const contactDisplay = isLid
      ? `Perfil: ${pushName || 'desconocido'} (ID interno: ${rawId})`
      : rawId;
    const summaryText = await generateFinalSummary(
      conv.history,
      contactDisplay,
      conv.isExistingClient
    );

    await sendToDr(sock, summaryText);
    markSummarySent(jid);
    logConversation(jid, conv, null, 'INTERESADO', conv.summary);

    logger.info(`[${jid}] INTERESADO — summary sent to admin`);
  } catch (err) {
    logger.error('Failed to send summary to admin:', err);
  }
}

function logConversation(jid, conv, extractedName, classification, summary = null) {
  try {
    const clientRecord = getClient(jid);
    const name = extractedName || clientRecord?.name || null;
    const number = extractContactNumber(jid);
    recordConversation(jid, { name, number, classification, summary, history: conv.history });
  } catch (err) {
    logger.error('Failed to log conversation to daily log:', err);
  }
}

module.exports = { handleMessage };
