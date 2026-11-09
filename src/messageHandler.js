const logger = require('./logger');
const { sendHumanLike } = require('./humanSimulator');
const { getAIResponse, generateFinalSummary, transcribeAudio } = require('./gemini');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const { getClient, saveClient, isKnownClient } = require('./clientsDb');
const { recordConversation } = require('./dailyLog');
const { addReminder, saveReminder, formatReminderConfirmation, notifyClient, loadAgenda, saveAgenda } = require('./agenda');
const { isDrCastro, getDrJid, getDrSendTargets } = require('./drConfig');
const {
  getConversation,
  initConversation,
  addMessage,
  updateClassification,
  markSummarySent,
  markDrNotified,
} = require('./conversationStore');

// Pending agenda item awaiting Dr. Castro's confirmation
let pendingAgendaItem = null;

async function sendToDr(sock, text) {
  const targets = getDrSendTargets();
  for (const jid of targets) {
    try {
      await sock.sendMessage(jid, { text });
      logger.info(`Message sent to Dr. at ${jid}`);
      return; // stop after first success
    } catch (err) {
      logger.warn(`Failed to send to ${jid}: ${err.message}`);
    }
  }
  logger.error('Could not deliver message to Dr. Castro on any JID');
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

async function handleDrCastroMessage(sock, msg) {
  const text = extractText(msg);
  if (!text) return;

  const replyJid = msg.key.remoteJid;

  // Handle pending conflict confirmation
  if (pendingAgendaItem) {
    if (/^s[ií]|^confirmar|^dale|^ok/i.test(text)) {
      const item = saveReminder(pendingAgendaItem);
      pendingAgendaItem = null;
      await sock.sendMessage(replyJid, { text: formatReminderConfirmation(item) });
      if (item.clientPhone) {
        const notified = await notifyClient(sock, item);
        if (notified) {
          const items = loadAgenda();
          const saved = items.find(i => i.id === item.id);
          if (saved) { saved.clientNotified = true; saveAgenda(items); }
        }
      }
    } else if (/^no|^cancel/i.test(text)) {
      pendingAgendaItem = null;
      await sock.sendMessage(replyJid, { text: 'Entendido, no se agendó.' });
    } else {
      await sock.sendMessage(replyJid, { text: 'Respondé "sí" para confirmar o "no" para cancelar.' });
    }
    return;
  }

  if (/^agend[ao]r?\s*:?\s/i.test(text)) {
    logger.info(`Agenda command received: "${text}"`);
    const { item, conflict, pending } = await addReminder(text);
    logger.info(`Reminder result: item=${!!item} conflict=${!!conflict}`);

    if (conflict) {
      pendingAgendaItem = pending;
      const d = new Date(conflict.isoDate);
      const dateStr = d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
      const timeStr = d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
      await sock.sendMessage(replyJid, {
        text: `Ya tenés algo agendado cerca de ese horario: "${conflict.description}" el ${dateStr} a las ${timeStr}. ¿Confirmás igual? (sí / no)`,
      });
    } else if (item) {
      await sock.sendMessage(replyJid, { text: formatReminderConfirmation(item) });
      if (item.clientPhone) {
        const notified = await notifyClient(sock, item);
        if (notified) {
          const items = loadAgenda();
          const saved = items.find(i => i.id === item.id);
          if (saved) { saved.clientNotified = true; saveAgenda(items); }
        }
      }
    } else {
      await sock.sendMessage(replyJid, { text: 'No pude interpretar la fecha. Usa este formato:\nAgendar manana a las 10:00 llamar a Juan\nAgendar 15/11 a las 09:30 audiencia' });
    }
  }
}

function extractContactNumber(jid) {
  // @lid JIDs don't contain the real phone number — use the raw ID as identifier
  if (jid.endsWith('@lid')) return jid.replace('@lid', '');
  return jid.replace('@s.whatsapp.net', '');
}

async function handleMessage(sock, msg, pushName = null) {
  const jid = msg.key.remoteJid;
  const text = extractText(msg);

  if (isDrCastro(jid)) {
    await handleDrCastroMessage(sock, msg);
    return;
  }
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

    // Notify Dr. Castro when a known client opens a new conversation
    if (knownClient && isNewConversation && !conv.drNotified) {
      const displayName = clientName || contactNumber;
      const alertText = `Aviso: ${displayName} (cliente existente, numero ${contactNumber}) inicio una nueva conversacion. Se le esta atendiendo.`;
      await sendToDr(sock, alertText);
      markDrNotified(jid);
    }

    if (conv.classification !== 'PENDIENTE' && conv.summarySet) return;

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

    await sendHumanLike(sock, jid, replyText, text);

    if (classification === 'CLIENTE_POTENCIAL' && !conv.summarySet) {
      saveClient(jid, { name: extractedName });
      await handleClientSummary(sock, jid, conv, pushName);
    } else if (classification === 'CURIOSO' && !conv.summarySet) {
      markSummarySent(jid);
      logger.info(`[${jid}] Classified as CURIOSO — no summary sent`);
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
    logConversation(jid, conv, null, 'CLIENTE_POTENCIAL', conv.summary);

    logger.info(`[${jid}] CLIENTE_POTENCIAL — summary sent to Dr. Castro`);
  } catch (err) {
    logger.error('Failed to send summary to Dr. Castro:', err);
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
