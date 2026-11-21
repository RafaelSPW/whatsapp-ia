const cron = require('node-cron');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { getTodayLog } = require('./dailyLog');
const logger = require('./logger');
const { getDrSendTargets } = require('./drConfig');

async function sendToDr(sock, text) {
  for (const jid of getDrSendTargets()) {
    try { await sock.sendMessage(jid, { text }); return; } catch {}
  }
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function buildDailySummary() {
  const log = getTodayLog();
  const entries = Object.values(log);

  if (entries.length === 0) {
    return 'Resumen diario: no hubo conversaciones hoy.';
  }

  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

  const conversationsText = entries.map((entry, i) => {
    const name = entry.name || 'Sin nombre';
    const transcript = entry.transcript
      .map(t => `  ${t.from}: ${t.text}`)
      .join('\n');
    return `--- Conversacion ${i + 1} ---\nNombre: ${name}\nNumero: ${entry.number}\nClasificacion automatica: ${entry.classification}\nResumen automatico: ${entry.summary || 'No generado'}\nTranscripcion:\n${transcript}`;
  }).join('\n\n');

  const date = new Date().toLocaleDateString('es-AR', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const candidateName = process.env.CANDIDATE_NAME || 'el candidato';

  const prompt = `Sos asistente del director de campaña de ${candidateName}. Analizá todas las conversaciones de WhatsApp del dia y generá un resumen ejecutivo para que el director pueda revisarlas rapidamente.

IMPORTANTE: la IA puede haber descartado como "consultando" a alguien que en realidad quería participar activamente. Revisá con criterio propio y señalá si hay algun contacto descartado que merece atención.

CONVERSACIONES DE HOY (${date}):

${conversationsText}

Generá el resumen en este formato (texto plano, sin emojis, sin asteriscos):

RESUMEN DIARIO - ${date}
Total de conversaciones: ${entries.length}

CONTACTOS INTERESADOS EN PARTICIPAR:
[listado de los que clasificaron como INTERESADO con nombre/numero y cómo quieren participar]

CONTACTOS DESCARTADOS QUE PODRIAN MERECER ATENCION:
[listado de los clasificados como CONSULTANDO pero que a tu criterio mostraron interes real, con nombre/numero y por que]

SIN CLASIFICAR / INCOMPLETOS:
[conversaciones que quedaron en PENDIENTE]

OBSERVACIONES GENERALES:
[2-3 oraciones sobre el dia, patrones, algo notable]`;

  const result = await model.generateContent(prompt);
  return result.response.text();
}

function scheduleDailySummary(sock) {
  // Every day at 20:00, Argentina time (UTC-3 = 23:00 UTC)
  cron.schedule('0 23 * * *', async () => {
    logger.info('Sending daily summary to admin...');
    try {
      const summary = await buildDailySummary();
      await sendToDr(sock, summary);
      logger.info('Daily summary sent');
    } catch (err) {
      logger.error('Failed to send daily summary:', err);
    }
  }, { timezone: 'UTC' });

  logger.info('Daily summary scheduled for 20:00 Argentina time');
}

module.exports = { scheduleDailySummary, buildDailySummary };
