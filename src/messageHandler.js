const logger = require('./logger');
const { sendHumanLike } = require('./humanSimulator');
const { getAIResponse, generateFinalSummary, transcribeAudio } = require('./gemini');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const { getClient, saveClient, isKnownClient } = require('./clientsDb');
const { recordConversation } = require('./dailyLog');
const { addReminder, saveReminder, formatReminderConfirmation, notifyClient, loadAgenda, saveAgenda } = require('./agenda');
const { isDrCastro, getDrJid, getDrSendTargets, setDrJid } = require('./drConfig');
const { loadCatalog, saveCatalog, formatCatalogForDisplay, parseCatalogText } = require('./catalog');
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

// Admin menu state
const ADMIN_STATE = {
  IDLE: 'IDLE',
  WAIT_NEW_ADMIN_NUMBER: 'WAIT_NEW_ADMIN_NUMBER',
  WAIT_CATALOG_UPLOAD: 'WAIT_CATALOG_UPLOAD',
  WAIT_CATALOG_MODIFY_INDEX: 'WAIT_CATALOG_MODIFY_INDEX',
  WAIT_CATALOG_MODIFY_DATA: 'WAIT_CATALOG_MODIFY_DATA',
};

let adminState = ADMIN_STATE.IDLE;
let catalogModifyIndex = null;

const ADMIN_MENU = `*Panel de administración*

1️⃣  Cambiar número admin
2️⃣  Subir catálogo (reemplaza el actual)
3️⃣  Ver agenda
4️⃣  Ver catálogo
5️⃣  Modificar catálogo
6️⃣  Conectar base de datos de productos
7️⃣  Contactar al desarrollador

Respondé con el número de la opción.`;

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

  // --- Admin state machine ---

  if (adminState === ADMIN_STATE.WAIT_NEW_ADMIN_NUMBER) {
    const num = text.replace(/\D/g, '');
    if (num.length < 8) {
      await sock.sendMessage(replyJid, { text: 'Número inválido. Enviá el número con código de país, sin + ni espacios (ej: 59891234567).' });
      return;
    }
    const newJid = `${num}@s.whatsapp.net`;
    setDrJid(newJid);
    // Update env in memory (runtime only)
    process.env.DR_CASTRO_NUMBER = num;
    adminState = ADMIN_STATE.IDLE;
    await sock.sendMessage(replyJid, { text: `✅ Número admin actualizado a *${num}*. Los mensajes se enviarán a ese número a partir de ahora.` });
    return;
  }

  if (adminState === ADMIN_STATE.WAIT_CATALOG_UPLOAD) {
    const items = parseCatalogText(text);
    if (!items.length) {
      await sock.sendMessage(replyJid, { text: 'No pude leer el catálogo. Usá el formato:\nNombre | Precio | Descripción\nUna línea por producto.' });
      return;
    }
    saveCatalog(items);
    adminState = ADMIN_STATE.IDLE;
    await sock.sendMessage(replyJid, { text: `✅ Catálogo guardado con *${items.length}* producto(s).\n\n${formatCatalogForDisplay(items)}` });
    return;
  }

  if (adminState === ADMIN_STATE.WAIT_CATALOG_MODIFY_INDEX) {
    const idx = parseInt(text.trim(), 10) - 1;
    const catalog = loadCatalog();
    if (isNaN(idx) || idx < 0 || idx >= catalog.length) {
      await sock.sendMessage(replyJid, { text: `Número inválido. El catálogo tiene ${catalog.length} ítem(s). Enviá un número del 1 al ${catalog.length}, o "cancelar".` });
      return;
    }
    if (/^cancelar$/i.test(text.trim())) {
      adminState = ADMIN_STATE.IDLE;
      await sock.sendMessage(replyJid, { text: 'Cancelado.' });
      return;
    }
    catalogModifyIndex = idx;
    adminState = ADMIN_STATE.WAIT_CATALOG_MODIFY_DATA;
    const item = catalog[idx];
    await sock.sendMessage(replyJid, {
      text: `Editando: *${item.nombre}*${item.precio ? ` | $${item.precio}` : ''}${item.descripcion ? ` | ${item.descripcion}` : ''}\n\nEnviá los nuevos datos en formato:\nNombre | Precio | Descripción\n\nO "cancelar" para salir.`,
    });
    return;
  }

  if (adminState === ADMIN_STATE.WAIT_CATALOG_MODIFY_DATA) {
    if (/^cancelar$/i.test(text.trim())) {
      adminState = ADMIN_STATE.IDLE;
      catalogModifyIndex = null;
      await sock.sendMessage(replyJid, { text: 'Cancelado.' });
      return;
    }
    const parsed = parseCatalogText(text);
    if (!parsed.length) {
      await sock.sendMessage(replyJid, { text: 'Formato inválido. Usá: Nombre | Precio | Descripción\nO "cancelar" para salir.' });
      return;
    }
    const catalog = loadCatalog();
    catalog[catalogModifyIndex] = parsed[0];
    saveCatalog(catalog);
    adminState = ADMIN_STATE.IDLE;
    catalogModifyIndex = null;
    await sock.sendMessage(replyJid, { text: `✅ Producto actualizado.\n\n${formatCatalogForDisplay(catalog)}` });
    return;
  }

  // --- Menu trigger ---
  if (/^opciones?$/i.test(text.trim()) || text.trim() === 'menu' || text.trim() === 'menú') {
    await sock.sendMessage(replyJid, { text: ADMIN_MENU });
    return;
  }

  // --- Menu option selection ---
  const opt = text.trim();
  if (/^1$/.test(opt)) {
    adminState = ADMIN_STATE.WAIT_NEW_ADMIN_NUMBER;
    await sock.sendMessage(replyJid, { text: '📱 Enviá el nuevo número admin con código de país, sin + ni espacios.\nEjemplo: 59891234567\n\nO "cancelar" para salir.' });
    return;
  }
  if (/^2$/.test(opt)) {
    adminState = ADMIN_STATE.WAIT_CATALOG_UPLOAD;
    await sock.sendMessage(replyJid, {
      text: '📋 Enviá el catálogo en este formato (una línea por producto):\n\nNombre | Precio | Descripción\n\nEjemplo:\nConsulta inicial | 1500 | Primera consulta sin cargo\nAsesoría laboral | 3000 | Estudio del caso\n\n⚠️ Esto reemplaza el catálogo actual. O enviá "cancelar" para salir.',
    });
    return;
  }
  if (/^3$/.test(opt)) {
    const items = loadAgenda();
    if (!items.length) {
      await sock.sendMessage(replyJid, { text: '📅 La agenda está vacía.' });
      return;
    }
    const now = new Date();
    const upcoming = items
      .filter(i => new Date(i.isoDate) >= now)
      .sort((a, b) => new Date(a.isoDate) - new Date(b.isoDate));
    if (!upcoming.length) {
      await sock.sendMessage(replyJid, { text: '📅 No hay turnos futuros agendados.' });
      return;
    }
    const lines = upcoming.map(i => {
      const d = new Date(i.isoDate);
      const fecha = d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
      const hora = d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
      return `📌 ${fecha} a las ${hora}\n   ${i.description}${i.clientPhone ? `\n   Cliente: ${i.clientPhone}` : ''}`;
    });
    await sock.sendMessage(replyJid, { text: `*Agenda — próximos turnos:*\n\n${lines.join('\n\n')}` });
    return;
  }
  if (/^4$/.test(opt)) {
    const catalog = loadCatalog();
    await sock.sendMessage(replyJid, { text: `*Catálogo actual:*\n\n${formatCatalogForDisplay(catalog)}` });
    return;
  }
  if (/^5$/.test(opt)) {
    const catalog = loadCatalog();
    if (!catalog.length) {
      await sock.sendMessage(replyJid, { text: 'El catálogo está vacío. Primero subí uno con la opción 2.' });
      return;
    }
    adminState = ADMIN_STATE.WAIT_CATALOG_MODIFY_INDEX;
    const list = catalog.map((item, i) => `${i + 1}. ${item.nombre}`).join('\n');
    await sock.sendMessage(replyJid, { text: `*¿Qué producto querés modificar?*\n\n${list}\n\nEnviá el número del producto.` });
    return;
  }
  if (/^6$/.test(opt)) {
    await sock.sendMessage(replyJid, {
      text: '🗄️ *Conexión a base de datos de productos*\n\nEsta funcionalidad está en desarrollo. Para conectar una base de datos externa, contactá al desarrollador (opción 7).',
    });
    return;
  }
  if (/^7$/.test(opt)) {
    await sock.sendMessage(replyJid, {
      text: '👨‍💻 *Contacto del desarrollador*\n\nRafael Núñez\nWhatsApp: +598 94 032 474\nEmail: rafaelnunezinzaurralde@gmail.com',
    });
    return;
  }

  // --- Pending agenda conflict confirmation ---
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
    const { item, conflict, pending, past } = await addReminder(text);
    logger.info(`Reminder result: item=${!!item} conflict=${!!conflict} past=${!!past}`);

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
    } else if (past) {
      await sock.sendMessage(replyJid, { text: 'Esa fecha y hora ya pasaron. Indicá una hora futura.' });
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
