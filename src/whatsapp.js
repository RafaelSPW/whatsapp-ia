const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const logger = require('./logger');
const { handleMessage } = require('./messageHandler');
const { setDrJid, registerDrJid } = require('./drConfig');

// Números configurados: PAIRING_NUMBER (principal), PAIRING_NUMBER_2, PAIRING_NUMBER_3
const PAIRING_NUMBERS = [
  process.env.PAIRING_NUMBER,
  process.env.PAIRING_NUMBER_2,
  process.env.PAIRING_NUMBER_3,
].filter(Boolean);

const msgStore = new Map();

// ── Sesión individual ────────────────────────────────────────────────────────
function restoreAuth(folder, envKey) {
  const data = process.env[envKey];
  if (!data) return;
  if (fs.existsSync(folder) && fs.readdirSync(folder).length > 0) return;
  try {
    fs.mkdirSync(folder, { recursive: true });
    const files = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(folder, name), JSON.stringify(content));
    }
    logger.info(`Session restored from ${envKey}`);
  } catch (err) {
    logger.warn(`Could not restore auth from ${envKey}: ${err.message}`);
  }
}

function exportAuth(folder, envKey) {
  if (!fs.existsSync(folder)) return;
  try {
    const files = {};
    for (const f of fs.readdirSync(folder)) {
      const full = path.join(folder, f);
      if (fs.statSync(full).isFile()) {
        try { files[f] = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { files[f] = fs.readFileSync(full, 'utf8'); }
      }
    }
    const encoded = Buffer.from(JSON.stringify(files)).toString('base64');
    console.log(`\n>>> ${envKey} para Railway:\n${encoded}\n`);
  } catch (err) {
    logger.warn(`Could not export auth ${envKey}: ${err.message}`);
  }
}

async function startOneWhatsApp(pairingNumber, authFolder, authEnvKey, idx) {
  restoreAuth(authFolder, authEnvKey);

  if (process.env.CLEAR_AUTH === 'true' && fs.existsSync(authFolder)) {
    fs.rmSync(authFolder, { recursive: true, force: true });
  }

  const authExists = fs.existsSync(authFolder) && fs.readdirSync(authFolder).length > 0;
  logger.info(`[WA${idx}] auth: ${authFolder} | exists: ${authExists}`);

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);

  let currentSock = null;
  let reconnectTimer = null;
  let pairingRequested = false;

  async function connect() {
    if (currentSock) { try { currentSock.end(); } catch {} currentSock = null; }
    pairingRequested = false;

    const sockOptions = {
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      generateHighQualityLinkPreview: false,
      retryRequestDelayMs: 250,
      getMessage: async (key) => {
        const stored = msgStore.get(key.id);
        if (stored) return stored;
        // Return minimal stub so Baileys can resend with fresh keys
        return { conversation: '' };
      },
    };
    if (!pairingNumber) sockOptions.browser = ['Chrome (Linux)', '', ''];

    const sock = makeWASocket(sockOptions);

    currentSock = sock;

    sock.ev.on('creds.update', saveCreds);

    // Map @lid JIDs → phone JIDs so outgoing replies can reach contacts
    if (!global.lidToPhone) global.lidToPhone = new Map();
    sock.ev.on('contacts.upsert', (contacts) => {
      for (const c of contacts) {
        if (c.id && c.lid) global.lidToPhone.set(c.lid, c.id);
      }
    });

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        if (!pairingNumber) {
          qrcode.generate(qr, { small: true });
          logger.info(`[WA${idx}] Escaneá el QR de arriba con WhatsApp`);
        }
        if (pairingNumber && !pairingRequested) {
          pairingRequested = true;
          await new Promise(r => setTimeout(r, 3000));
          try {
            const code = await sock.requestPairingCode(pairingNumber);
            console.log(`\n>>> [WA${idx}] Código para ${pairingNumber}: ${code}\n`);
          } catch (err) {
            logger.error(`[WA${idx}] Pairing code error: ${err.message}`);
            pairingRequested = false;
          }
        }
      }

      if (connection === 'close') {
        if (sock !== currentSock) return;
        const code = lastDisconnect?.error?.output?.statusCode;
        logger.warn(`[WA${idx}] Connection closed (code ${code})`);
        if (code === DisconnectReason.loggedOut) {
          try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch {}
        }
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(async () => {
          reconnectTimer = null;
          try { await connect(); } catch (err) { logger.error(`[WA${idx}] Reconnect failed: ${err.message}`); }
        }, 5000);
      }

      if (connection === 'open') {
        logger.info(`[WA${idx}] WhatsApp connected — ${pairingNumber}`);
        if (idx === 1) global.whatsappSock = sock;
        // Keep global socks array up to date after reconnects
        if (global.whatsappSocks) global.whatsappSocks[idx - 1] = sock;
        exportAuth(authFolder, authEnvKey);
        if (idx === 1) {
          try {
            const results = await sock.onWhatsApp(process.env.ADMIN_NUMBER);
            if (results?.length > 0) {
              setDrJid(results[0].jid);
              if (results[0].lid) setDrJid(results[0].lid);
              logger.info(`Admin JID resolved: ${results[0].jid}`);
            }
          } catch (e) { logger.warn(`Could not resolve Admin JID: ${e.message}`); }
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      for (const msg of messages) {
        if (msg.key?.id && msg.message) msgStore.set(msg.key.id, msg.message);
        if (type !== 'notify') continue;
        if (msg.key.fromMe) continue;
        if (!msg.message) continue;
        const jid = msg.key.remoteJid;
        if (jid.endsWith('@g.us') || jid.endsWith('@newsletter')) continue;
        await handleMessage(sock, msg, msg.pushName || null);
      }
    });

    return sock;
  }

  return connect();
}

// ── Iniciar todos los números configurados ───────────────────────────────────
async function startWhatsApp() {
  const numbers = PAIRING_NUMBERS.length > 0 ? PAIRING_NUMBERS : [undefined];

  const socks = await Promise.all(numbers.map((num, i) => {
    const idx = i + 1;
    const folder = idx === 1
      ? path.join(process.cwd(), 'auth_info')
      : path.join(process.cwd(), `auth_info_${idx}`);
    const envKey = idx === 1 ? 'AUTH_DATA' : `AUTH_DATA_${idx}`;
    return startOneWhatsApp(num, folder, envKey, idx);
  }));

  global.whatsappSocks = socks;
  global.whatsappSock  = socks[0];

  logger.info(`${socks.length} número(s) de WhatsApp iniciados`);
  return socks;
}

module.exports = { startWhatsApp };
