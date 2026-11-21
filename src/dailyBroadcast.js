const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger = require('./logger');
const { getContacts } = require('./broadcastContacts');

const DATA_DIR = path.join(process.cwd(), 'data');
const CAMPAIGN_FILE = path.join(DATA_DIR, 'campaign.json');
const BROADCAST_LOG_FILE = path.join(DATA_DIR, 'broadcast_log.json');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

function loadCampaign() {
  try {
    if (fs.existsSync(CAMPAIGN_FILE)) {
      return JSON.parse(fs.readFileSync(CAMPAIGN_FILE, 'utf8'));
    }
  } catch {}
  return {
    candidateName: process.env.CANDIDATE_NAME || 'el candidato',
    info: process.env.CAMPAIGN_INFO || '',
    dailyMessage: null,
  };
}

function saveCampaign(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CAMPAIGN_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function loadBroadcastLog() {
  try {
    if (fs.existsSync(BROADCAST_LOG_FILE)) {
      return JSON.parse(fs.readFileSync(BROADCAST_LOG_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

function saveBroadcastLog(log) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(BROADCAST_LOG_FILE, JSON.stringify(log, null, 2), 'utf8');
}

async function generateDailyMessage(campaign) {
  if (campaign.dailyMessage) return campaign.dailyMessage;

  const model = genAI.getGenerativeModel({ model: 'gemini-3.8-flash' });
  const today = new Date().toLocaleDateString('es-AR', {
    weekday: 'long', day: 'numeric', month: 'long',
  });

  const prompt = `Generá un mensaje breve de WhatsApp para enviar a contactos que apoyan la campaña de ${campaign.candidateName}.

Información de campaña: ${campaign.info || 'campaña política local'}
Fecha: ${today}

El mensaje debe:
- Ser corto (máximo 3 oraciones)
- Sin emojis
- En español, tono cercano pero profesional
- Mencionar al candidato y motivar a seguir la campaña
- Terminar invitando a hacer preguntas si tienen dudas sobre la postulación

Solo devolvé el mensaje, sin explicaciones ni comillas.`;

  const result = await model.generateContent(prompt);
  return result.response.text().trim();
}

async function sendDailyBroadcast(sock) {
  const contacts = getContacts();

  if (!contacts.length) {
    logger.info('Daily broadcast: no contacts in broadcast list');
    return { sent: 0, failed: 0, message: null };
  }

  const campaign = loadCampaign();
  const message = await generateDailyMessage(campaign);

  logger.info(`Daily broadcast: sending to ${contacts.length} contacts`);

  let sent = 0;
  let failed = 0;

  for (const contact of contacts) {
    const jid = `${contact.phone}@s.whatsapp.net`;
    try {
      await sock.sendMessage(jid, { text: message });
      sent++;
      logger.info(`Broadcast sent to ${contact.phone}`);
      // Delay between sends to avoid rate limiting
      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      logger.error(`Broadcast failed for ${contact.phone}: ${err.message}`);
      failed++;
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const log = loadBroadcastLog();
  log[today] = { sent, failed, message, sentAt: new Date().toISOString() };
  saveBroadcastLog(log);

  logger.info(`Daily broadcast complete: ${sent} sent, ${failed} failed`);
  return { sent, failed, message };
}

function scheduleDailyBroadcast(sock) {
  // Default: 9:00 AM Argentina time (UTC-3 = 12:00 UTC)
  const hourUTC = parseInt(process.env.BROADCAST_HOUR_UTC || '12', 10);

  cron.schedule(`0 ${hourUTC} * * *`, async () => {
    logger.info('Starting scheduled daily broadcast...');
    try {
      const { sent, failed } = await sendDailyBroadcast(sock);
      logger.info(`Scheduled broadcast done: ${sent} sent, ${failed} failed`);
    } catch (err) {
      logger.error('Scheduled broadcast failed:', err);
    }
  }, { timezone: 'UTC' });

  logger.info(`Daily broadcast scheduled for ${hourUTC}:00 UTC (9:00 AM Argentina time by default)`);
}

module.exports = { scheduleDailyBroadcast, sendDailyBroadcast, loadCampaign, saveCampaign };
