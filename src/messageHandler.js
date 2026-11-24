const logger = require('./logger');
const { sendHumanLike } = require('./humanSimulator');
const { getAIResponse, generateFinalSummary, transcribeAudio } = require('./gemini');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const { getClient, saveClient, isKnownClient } = require('./clientsDb');
const { recordConversation } = require('./dailyLog');
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
const { sendDailyBroadcast, loadCampaign, saveCampaign } = require('./dailyBroadcast');
const { getContacts, addContacts, clearContacts, parseContactsText, formatContactsForDisplay } = require('./broadcastContacts');

// Admin menu state
const ADMIN_STATE = {
  IDLE: 'IDLE',
  WAIT_NEW_ADMIN_NUMBER: 'WAIT_NEW_ADMIN_NUMBER',
  WAIT_CATALOG_UPLOAD: 'WAIT_CATALOG_UPLOAD',
  WAIT_CATALOG_MODIFY_INDEX: 'WAIT_CATALOG_MODIFY_INDEX',
  WAIT_CATALOG_MODIFY_DATA: 'WAIT_CATALOG_MODIFY_DATA',
  WAIT_CAMPAIGN_CONFIG: 'WAIT_CAMPAIGN_CONFIG',
  WAIT_CONTACTS_ACTION: 'WAIT_CONTACTS_ACTION',
  WAIT_CONTACTS_ADD: 'WAIT_CONTACTS_ADD',
  WAIT_BROADCAST_ACTION: 'WAIT_BROADCAST_ACTION',
  WAIT_BROADCAST_CUSTOM_MSG: 'WAIT_BROADCAST_CUSTOM_MSG',
};

let adminState = ADMIN_STATE.IDLE;
let catalogModifyIndex = null;

const ADMIN_MENU = `*Panel de administración*

1️⃣  Cambiar número admin
2️⃣  Gestionar lista de contactos
3️⃣  Configurar campaña (candidato y mensaje diario)
4️⃣  Enviar difusión ahora (manual)
5️⃣  Subir catálogo de servicios
6️⃣  Ver / Modificar catálogo
7️⃣  Contactar al desarrollador

Respondé con el número de la opción.`;

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

async function handleDrCastroMessage(sock, msg) {
  const text = extractText(msg);
  if (!text) return;

  const incomingJid = msg.key.remoteJid;
  const adminNumber = process.env.ADMIN_NUMBER || process.env.DR_CASTRO_NUMBER;
  // @lid JIDs are accepted by Baileys but messages never arrive — always use @s.whatsapp.net
  const replyJid = adminNumber ? `${adminNumber}@s.whatsapp.net` : incomingJid.replace('@lid', '@s.whatsapp.net');

  const reply = async (str) => {
    const txt = typeof str === 'string' ? str : str?.text;
    await new Promise(r => setTimeout(r, 2000));
    // Try all sockets: WA2/WA3 first (known working), WA1 as last resort
    const allSocks = (global.whatsappSocks || [sock]).filter(s => s);
    const ordered = [...allSocks.slice(1), allSocks[0]].filter(Boolean);
    for (const s of ordered) {
      try {
        await s.sendMessage(replyJid, { text: String(txt ?? '') });
        logger.info(`[Admin] reply sent to ${replyJid}`);
        return;
      } catch (err) {
        logger.warn(`[Admin] reply failed via socket: ${err.message}`);
      }
    }
  };

  // --- Admin state machine ---

  if (adminState === ADMIN_STATE.WAIT_NEW_ADMIN_NUMBER) {
    const num = text.replace(/\D/g, '');
    if (num.length < 8) {
      await reply('Número inválido. Enviá el número con código de país, sin + ni espacios (ej: 59891234567).');
      return;
    }
    const newJid = `${num}@s.whatsapp.net`;
    setDrJid(newJid);
    // Update env in memory (runtime only)
    process.env.DR_CASTRO_NUMBER = num;
    adminState = ADMIN_STATE.IDLE;
    await reply(`✅ Número admin actualizado a *${num}*. Los mensajes se enviarán a ese número a partir de ahora.`);
    return;
  }

  if (adminState === ADMIN_STATE.WAIT_CATALOG_UPLOAD) {
    const items = parseCatalogText(text);
    if (!items.length) {
      await reply('No pude leer el catálogo. Usá el formato:\nNombre | Precio | Descripción\nUna línea por producto.');
      return;
    }
    saveCatalog(items);
    adminState = ADMIN_STATE.IDLE;
    await reply(`✅ Catálogo guardado con *${items.length}* producto(s).\n\n${formatCatalogForDisplay(items)}`);
    return;
  }

  if (adminState === ADMIN_STATE.WAIT_CATALOG_MODIFY_INDEX) {
    const idx = parseInt(text.trim(), 10) - 1;
    const catalog = loadCatalog();
    if (isNaN(idx) || idx < 0 || idx >= catalog.length) {
      await reply(`Número inválido. El catálogo tiene ${catalog.length} ítem(s). Enviá un número del 1 al ${catalog.length}, o "cancelar".`);
      return;
    }
    if (/^cancelar$/i.test(text.trim())) {
      adminState = ADMIN_STATE.IDLE;
      await reply('Cancelado.');
      return;
    }
    catalogModifyIndex = idx;
    adminState = ADMIN_STATE.WAIT_CATALOG_MODIFY_DATA;
    const item = catalog[idx];
    await reply({
      text: `Editando: *${item.nombre}*${item.precio ? ` | $${item.precio}` : ''}${item.descripcion ? ` | ${item.descripcion}` : ''}\n\nEnviá los nuevos datos en formato:\nNombre | Precio | Descripción\n\nO "cancelar" para salir.`,
    });
    return;
  }

  if (adminState === ADMIN_STATE.WAIT_CATALOG_MODIFY_DATA) {
    if (/^cancelar$/i.test(text.trim())) {
      adminState = ADMIN_STATE.IDLE;
      catalogModifyIndex = null;
      await reply('Cancelado.');
      return;
    }
    const parsed = parseCatalogText(text);
    if (!parsed.length) {
      await reply('Formato inválido. Usá: Nombre | Precio | Descripción\nO "cancelar" para salir.');
      return;
    }
    const catalog = loadCatalog();
    catalog[catalogModifyIndex] = parsed[0];
    saveCatalog(catalog);
    adminState = ADMIN_STATE.IDLE;
    catalogModifyIndex = null;
    await reply(`✅ Producto actualizado.\n\n${formatCatalogForDisplay(catalog)}`);
    return;
  }

  if (adminState === ADMIN_STATE.WAIT_CONTACTS_ACTION) {
    if (/^cancelar$/i.test(text.trim())) {
      adminState = ADMIN_STATE.IDLE;
      await reply('Cancelado.');
      return;
    }
    if (/^a$/i.test(text.trim())) {
      const contacts = getContacts();
      adminState = ADMIN_STATE.IDLE;
      await reply(`*Lista de contactos (${contacts.length}):*\n\n${formatContactsForDisplay(contacts)}`);
      return;
    }
    if (/^b$/i.test(text.trim())) {
      adminState = ADMIN_STATE.WAIT_CONTACTS_ADD;
      await reply({
        text: 'Enviá la lista de contactos. Formato (una línea por contacto):\n\nNombre | Número\n\nEjemplo:\nJuan Pérez | 5491112345678\nMaría García | 5491187654321\n\nTambién podés poner solo el número sin nombre. Los contactos se agregan a la lista existente.\nO "cancelar" para salir.',
      });
      return;
    }
    if (/^c$/i.test(text.trim())) {
      clearContacts();
      adminState = ADMIN_STATE.IDLE;
      await reply('✅ Lista de contactos limpiada.');
      return;
    }
    await reply('Opción inválida. Enviá a, b, c o "cancelar".');
    return;
  }

  if (adminState === ADMIN_STATE.WAIT_CONTACTS_ADD) {
    if (/^cancelar$/i.test(text.trim())) {
      adminState = ADMIN_STATE.IDLE;
      await reply('Cancelado.');
      return;
    }
    const parsed = parseContactsText(text);
    if (!parsed.length) {
      await reply('No pude leer ningún contacto. Usá el formato:\nNombre | Número\n\nO "cancelar".');
      return;
    }
    const { total, added } = addContacts(parsed);
    adminState = ADMIN_STATE.IDLE;
    await reply(`✅ ${added} contacto(s) agregado(s). Total en la lista: ${total}.`);
    return;
  }

  if (adminState === ADMIN_STATE.WAIT_BROADCAST_ACTION) {
    if (/^cancelar$/i.test(text.trim())) {
      adminState = ADMIN_STATE.IDLE;
      await reply('Cancelado.');
      return;
    }
    if (/^a$/i.test(text.trim())) {
      adminState = ADMIN_STATE.IDLE;
      await reply('📤 Enviando...');
      try {
        const { sent, failed } = await sendDailyBroadcast(sock);
        await reply(`Difusión completada: ${sent} enviados, ${failed} fallidos.`);
      } catch (err) {
        await reply(`Error: ${err.message}`);
      }
      return;
    }
    if (/^b$/i.test(text.trim())) {
      adminState = ADMIN_STATE.WAIT_BROADCAST_CUSTOM_MSG;
      await reply('Escribí el mensaje que querés enviar a todos los contactos.\n\nO "cancelar" para salir.');
      return;
    }
    await reply('Opción inválida. Enviá a, b o "cancelar".');
    return;
  }

  if (adminState === ADMIN_STATE.WAIT_BROADCAST_CUSTOM_MSG) {
    if (/^cancelar$/i.test(text.trim())) {
      adminState = ADMIN_STATE.IDLE;
      await reply('Cancelado.');
      return;
    }
    adminState = ADMIN_STATE.IDLE;
    const customMessage = text.trim();
    const contacts = getContacts();
    if (!contacts.length) {
      await reply('La lista de contactos está vacía. Agregá contactos primero (opción 2).');
      return;
    }
    await reply(`📤 Enviando a ${contacts.length} contactos...`);
    let sent = 0;
    let failed = 0;
    for (const contact of contacts) {
      const jid = `${contact.phone}@s.whatsapp.net`;
      try {
        await sock.sendMessage(jid, { text: customMessage });
        sent++;
        await new Promise(r => setTimeout(r, 1500));
      } catch {
        failed++;
      }
    }
    await reply(`Campaña enviada: ${sent} enviados, ${failed} fallidos.`);
    return;
  }

  if (adminState === ADMIN_STATE.WAIT_CAMPAIGN_CONFIG) {
    if (/^cancelar$/i.test(text.trim())) {
      adminState = ADMIN_STATE.IDLE;
      await reply('Cancelado.');
      return;
    }
    const parts = text.split('|').map(p => p.trim());
    if (!parts[0]) {
      await reply('Formato inválido. Usá: Nombre candidato | Información | Mensaje del día\nO "cancelar".');
      return;
    }
    const campaign = loadCampaign();
    campaign.candidateName = parts[0];
    if (parts[1]) campaign.candidateTitle = parts[1];
    if (parts[2]) campaign.candidateBio = parts[2];
    if (parts[3]) campaign.info = parts[3];
    if (parts[4]) campaign.dailyMessage = parts[4];
    else campaign.dailyMessage = null; // auto-generate
    saveCampaign(campaign);
    adminState = ADMIN_STATE.IDLE;
    const titleStr = campaign.candidateTitle ? ` (${campaign.candidateTitle})` : '';
    await reply(`✅ Campaña actualizada.\nCandidato: ${campaign.candidateName}${titleStr}\nBiografía: ${campaign.candidateBio || 'No configurada'}\nMensaje del día: ${campaign.dailyMessage || 'Se genera automáticamente'}`);
    return;
  }

  // --- Menu trigger ---
  logger.info(`[Admin] received text: "${text}" state: ${adminState}`);
  if (/^(opciones?|men[uú])$/i.test(text.trim())) {
    await reply(ADMIN_MENU);
    return;
  }

  // --- Menu option selection ---
  const opt = text.trim();
  if (/^1$/.test(opt)) {
    adminState = ADMIN_STATE.WAIT_NEW_ADMIN_NUMBER;
    await reply('📱 Enviá el nuevo número admin con código de país, sin + ni espacios.\nEjemplo: 59891234567\n\nO "cancelar" para salir.');
    return;
  }
  if (/^2$/.test(opt)) {
    const contacts = getContacts();
    adminState = ADMIN_STATE.WAIT_CONTACTS_ACTION;
    await reply({
      text: `📋 *Gestionar contactos de difusión*\n\nContactos actuales: ${contacts.length}\n\nElegí una acción:\na — Ver lista\nb — Agregar contactos\nc — Limpiar lista\n\nO "cancelar" para salir.`,
    });
    return;
  }
  if (/^3$/.test(opt)) {
    const campaign = loadCampaign();
    adminState = ADMIN_STATE.WAIT_CAMPAIGN_CONFIG;
    await reply({
      text: `📣 *Configurar campaña*\n\nConfiguración actual:\nNombre: ${campaign.candidateName || 'No configurado'}\nTítulo/cargo: ${campaign.candidateTitle || 'No configurado'}\nBiografía: ${campaign.candidateBio ? campaign.candidateBio.slice(0, 80) + '...' : 'No configurada'}\nInfo campaña: ${campaign.info ? campaign.info.slice(0, 80) + '...' : 'No configurada'}\nMensaje del día: ${campaign.dailyMessage ? campaign.dailyMessage.slice(0, 80) + '...' : 'Se genera automáticamente'}\n\nEnviá los nuevos datos en este formato:\nNombre | Título/cargo | Biografía | Info de campaña | Mensaje del día\n\nEjemplo:\nJuan Pérez | Ing. | Ingeniero civil, 20 años en gestión pública | Candidato a intendente por el partido X | Seguimos creciendo juntos.\n\nEl título/cargo, biografía, info y mensaje del día son opcionales. Si omitís el mensaje se genera automáticamente.\n\nO "cancelar" para salir.`,
    });
    return;
  }
  if (/^4$/.test(opt)) {
    const campaign = loadCampaign();
    const contacts = getContacts();
    const preview = campaign.dailyMessage
      ? campaign.dailyMessage.slice(0, 100) + (campaign.dailyMessage.length > 100 ? '...' : '')
      : 'Se genera automáticamente con IA';
    adminState = ADMIN_STATE.WAIT_BROADCAST_ACTION;
    await reply({
      text: `📤 *Enviar campaña ahora*\n\nContactos en la lista: ${contacts.length}\nMensaje configurado: ${preview}\n\na — Enviar mensaje configurado\nb — Escribir mensaje personalizado\n\nO "cancelar" para salir.`,
    });
    return;
  }
  if (/^5$/.test(opt)) {
    adminState = ADMIN_STATE.WAIT_CATALOG_UPLOAD;
    await reply({
      text: '📋 Enviá el catálogo en este formato (una línea por ítem):\n\nNombre | Precio | Descripción\n\n⚠️ Esto reemplaza el catálogo actual. O enviá "cancelar" para salir.',
    });
    return;
  }
  if (/^6$/.test(opt)) {
    const catalog = loadCatalog();
    if (!catalog.length) {
      await reply(`*Catálogo actual:*\n\nVacío.`);
      return;
    }
    adminState = ADMIN_STATE.WAIT_CATALOG_MODIFY_INDEX;
    const list = catalog.map((item, i) => `${i + 1}. ${item.nombre}`).join('\n');
    await reply({
      text: `*Catálogo actual:*\n\n${formatCatalogForDisplay(catalog)}\n\n*¿Qué ítem querés modificar?*\n${list}\n\nEnviá el número o "cancelar".`,
    });
    return;
  }
  if (/^7$/.test(opt)) {
    await reply({
      text: '👨‍💻 *Contacto del desarrollador*\n\nRafael Núñez\nWhatsApp: +598 94 032 474\nEmail: rafaelnunezinzaurralde@gmail.com',
    });
    return;
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
    logger.info(`[Admin] message from admin JID: ${jid}`);
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

    await sendHumanLike(sock, jid, replyText, text);

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
