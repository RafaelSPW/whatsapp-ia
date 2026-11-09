const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger = require('./logger');
const { getDrJid, getDrSendTargets } = require('./drConfig');

async function sendToDr(sock, text) {
  for (const jid of getDrSendTargets()) {
    try {
      await sock.sendMessage(jid, { text });
      return;
    } catch (err) {
      // try next
    }
  }
}

const AGENDA_FILE = path.join(__dirname, '..', 'data', 'agenda.json');
const DEFAULT_ADVANCE_MINUTES = 30;
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

function loadAgenda() {
  try {
    if (!fs.existsSync(AGENDA_FILE)) return [];
    return JSON.parse(fs.readFileSync(AGENDA_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveAgenda(items) {
  fs.mkdirSync(path.dirname(AGENDA_FILE), { recursive: true });
  fs.writeFileSync(AGENDA_FILE, JSON.stringify(items, null, 2));
}

async function parseAgendaWithAI(text) {
  const now = new Date();
  const nowStr = now.toLocaleString('es-AR', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });

  const model = genAI.getGenerativeModel({ model: 'gemini-3.8-flash' });

  const prompt = `Hoy es ${nowStr} (hora local Argentina, UTC-3).

El siguiente mensaje fue enviado por un abogado para agendar un recordatorio o llamada:
"${text}"

Extraé la información y respondé SOLO con un JSON válido, sin markdown, sin explicaciones:
{
  "date": "YYYY-MM-DD",
  "time": "HH:MM",
  "description": "descripción limpia sin fecha ni teléfono",
  "clientPhone": "número sin espacios ni + (null si no hay)",
  "advanceMinutes": 30
}

Reglas:
- date y time en la zona horaria de Argentina (UTC-3)
- Si hay un número de día explícito ("día 4", "el 4", "4 de noviembre", etc.), ese número es la fecha — ignorá "hoy" o "mañana" si también aparecen.
- Si solo dice "hoy" sin número de día, usá la fecha de hoy. Si solo dice "mañana", la de mañana.
- Si el mes no está especificado, usá el mes actual o el siguiente si el día ya pasó.
- advanceMinutes: si el texto pide avisar X minutos/horas antes, calculalo en minutos. Si no dice nada, usá 30.
- clientPhone: solo si hay un número de teléfono explícito (7+ dígitos). Si no hay, null.
- description: la descripción limpia, sin fecha, sin hora y sin teléfono.
- Si no podés determinar la fecha u hora, devolvé null en ambos campos.`;

  try {
    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim().replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(raw);

    if (!parsed.date || !parsed.time) return null;

    const [y, mo, d] = parsed.date.split('-').map(Number);
    const [hh, mm] = parsed.time.split(':').map(Number);
    const targetDate = new Date(y, mo - 1, d, hh, mm, 0);

    if (isNaN(targetDate.getTime()) || targetDate <= now) return null;

    const advanceMinutes = parsed.advanceMinutes || DEFAULT_ADVANCE_MINUTES;
    const advanceDate = new Date(targetDate.getTime() - advanceMinutes * 60 * 1000);

    return {
      isoDate: targetDate.toISOString(),
      isoAdvance: advanceDate > now ? advanceDate.toISOString() : null,
      advanceMinutes,
      description: parsed.description || text,
      clientPhone: parsed.clientPhone || null,
    };
  } catch (err) {
    logger.error(`AI agenda parse failed: ${err.message}`);
    return null;
  }
}

// Returns the existing item that conflicts with isoDate (within 60 min), or null
function checkConflict(isoDate) {
  const target = new Date(isoDate).getTime();
  const items = loadAgenda();
  return items.find(i => Math.abs(new Date(i.isoDate).getTime() - target) < 60 * 60 * 1000) || null;
}

function saveReminder(parsed) {
  const items = loadAgenda();
  const item = {
    id: Date.now().toString(),
    isoDate: parsed.isoDate,
    isoAdvance: parsed.isoAdvance,
    advanceMinutes: parsed.advanceMinutes,
    description: parsed.description,
    clientPhone: parsed.clientPhone || null,
    sent: false,
    advanceSent: false,
    clientNotified: false,
    createdAt: new Date().toISOString(),
  };
  items.push(item);
  saveAgenda(items);
  logger.info(`Reminder saved: "${parsed.description}" at ${parsed.isoDate}${parsed.clientPhone ? ` | client: ${parsed.clientPhone}` : ''}`);
  return item;
}

// Returns { item, conflict } — conflict is the existing overlapping item or null
async function addReminder(text) {
  const parsed = await parseAgendaWithAI(text);
  if (!parsed) return { item: null, conflict: null };

  const conflict = checkConflict(parsed.isoDate);
  if (conflict) return { item: null, conflict, pending: parsed };

  const item = saveReminder(parsed);
  return { item, conflict: null };
}

function formatReminderConfirmation(item) {
  const d = new Date(item.isoDate);
  const dateStr = d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  const timeStr = d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
  const clientNote = item.clientPhone
    ? ` Le aviso al cliente (${item.clientPhone}) que lo llamas a esa hora.`
    : '';
  return `Anotado. Te aviso ${item.advanceMinutes} minutos antes y a la hora exacta. ${dateStr} a las ${timeStr}: ${item.description}${clientNote}`;
}

async function notifyClient(sock, item) {
  if (!item.clientPhone || item.clientNotified) return false;
  const d = new Date(item.isoDate);
  const dateStr = d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  const timeStr = d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
  const jid = `${item.clientPhone}@s.whatsapp.net`;
  try {
    await sock.sendMessage(jid, {
      text: `Hola, le confirmo que el Dr. Castro se va a comunicar con usted el ${dateStr} a las ${timeStr}. Por favor este disponible en este numero.`,
    });
    logger.info(`Client notified: ${item.clientPhone} for "${item.description}"`);
    return true;
  } catch (err) {
    logger.error(`Failed to notify client ${item.clientPhone}: ${err.message}`);
    return false;
  }
}

function scheduleAgendaChecker(sock) {
  cron.schedule('* * * * *', async () => {
    const now = new Date();
    const items = loadAgenda();
    let changed = false;

    for (const item of items) {
      if (!item.advanceSent && item.isoAdvance) {
        const advanceAt = new Date(item.isoAdvance);
        if (advanceAt <= now) {
          try {
            await sendToDr(sock, `Aviso: en ${item.advanceMinutes} minutos — ${item.description}`);
            item.advanceSent = true;
            changed = true;
          } catch (err) {
            logger.error('Failed to send advance reminder:', err);
          }
        }
      }

      if (!item.sent) {
        const fireAt = new Date(item.isoDate);
        if (fireAt <= now) {
          try {
            await sendToDr(sock, `Recordatorio: ${item.description}`);
            item.sent = true;
            changed = true;
          } catch (err) {
            logger.error('Failed to send reminder:', err);
          }
        }
      }
    }

    if (changed) saveAgenda(items);
  });

  logger.info('Agenda reminder scheduler started');
}

module.exports = { addReminder, saveReminder, formatReminderConfirmation, notifyClient, loadAgenda, saveAgenda, scheduleAgendaChecker };
