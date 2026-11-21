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

const AUTH_FOLDER = path.join(process.cwd(), 'auth_info');

// Restore session from AUTH_DATA env var (base64-encoded tar) if auth folder is missing.
// This allows Railway (ephemeral filesystem) to survive redeploys.
function restoreAuthFromEnv() {
  if (!process.env.AUTH_DATA) return;
  if (fs.existsSync(AUTH_FOLDER) && fs.readdirSync(AUTH_FOLDER).length > 0) return;
  try {
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    const files = JSON.parse(Buffer.from(process.env.AUTH_DATA, 'base64').toString('utf8'));
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(AUTH_FOLDER, name), JSON.stringify(content));
    }
    logger.info('Session restored from AUTH_DATA env var');
  } catch (err) {
    logger.warn('Could not restore auth from AUTH_DATA: ' + err.message);
  }
}

// Serialize current auth_info to a base64 JSON string and log it,
// so the user can copy it into the AUTH_DATA env var.
function exportAuthToEnv() {
  if (!fs.existsSync(AUTH_FOLDER)) return;
  try {
    const files = {};
    for (const f of fs.readdirSync(AUTH_FOLDER)) {
      const full = path.join(AUTH_FOLDER, f);
      if (fs.statSync(full).isFile()) {
        try { files[f] = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { files[f] = fs.readFileSync(full, 'utf8'); }
      }
    }
    const encoded = Buffer.from(JSON.stringify(files)).toString('base64');
    logger.info('AUTH_DATA (copy this to Railway env var):\n' + encoded);
    console.log('\n>>> AUTH_DATA para Railway (copiá este valor como variable de entorno AUTH_DATA):\n' + encoded + '\n');
  } catch (err) {
    logger.warn('Could not export auth: ' + err.message);
  }
}

restoreAuthFromEnv();

if (process.env.CLEAR_AUTH === 'true' && fs.existsSync(AUTH_FOLDER)) {
  fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
  logger.info('auth_info cleared (CLEAR_AUTH=true)');
}

const PAIRING_NUMBER = process.env.PAIRING_NUMBER;

// Module-level message store for getMessage retries.
// Keyed by message ID — persists across reconnects.
const msgStore = new Map();

let currentSock = null;
let reconnectTimer = null;

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

  const sockOptions = {
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    generateHighQualityLinkPreview: false,
    // Required so WhatsApp can request re-delivery when it can't decrypt a message.
    // Must return undefined (not an empty object) when not found.
    getMessage: async (key) => msgStore.get(key.id),
  };

  if (!PAIRING_NUMBER) {
    sockOptions.browser = ['Chrome (Linux)', '', ''];
  }

  // Close previous socket to avoid stream conflicts (code 440)
  if (currentSock) {
    try { currentSock.end(); } catch {}
    currentSock = null;
  }

  const sock = makeWASocket(sockOptions);
  currentSock = sock;
  global.whatsappSock = sock;

  sock.ev.on('creds.update', saveCreds);

  let pairingRequested = false;

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      if (PAIRING_NUMBER && !pairingRequested) {
        pairingRequested = true;
        try {
          const code = await sock.requestPairingCode(PAIRING_NUMBER);
          logger.info(`Pairing code: ${code}`);
          console.log(`\n>>> Ingresa este codigo en WhatsApp > Dispositivos vinculados > Vincular con numero: ${code}\n`);
        } catch (err) {
          logger.error(`Failed to get pairing code: ${err.message}`);
          qrcode.generate(qr, { small: true });
        }
      } else if (!PAIRING_NUMBER) {
        logger.info('Scan this QR code with WhatsApp:');
        qrcode.generate(qr, { small: true });
      }
    }

    if (connection === 'close') {
      if (sock !== currentSock) return;

      const code = lastDisconnect?.error?.output?.statusCode;
      logger.warn(`Connection closed (code ${code})`);

      if (code === DisconnectReason.loggedOut) {
        logger.warn('Session logged out. Clearing auth and reconnecting...');
        try { fs.rmSync(AUTH_FOLDER, { recursive: true, force: true }); } catch {}
      }

      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(async () => {
        reconnectTimer = null;
        try { await startWhatsApp(); } catch (err) {
          logger.error('Reconnect failed:', err.message);
        }
      }, 5000);
    }

    if (connection === 'open') {
      logger.info('WhatsApp connected successfully');
      global.whatsappSock = sock;
      exportAuthToEnv();
      try {
        const results = await sock.onWhatsApp(process.env.ADMIN_NUMBER);
        logger.info(`onWhatsApp result for Admin: ${JSON.stringify(results)}`);
        if (results?.length > 0) {
          setDrJid(results[0].jid);
          logger.info(`Admin JID resolved: ${results[0].jid}`);
          if (results[0].lid) {
            setDrJid(results[0].lid);
            logger.info(`Admin LID set as send target: ${results[0].lid}`);
          }
        } else {
          logger.warn('onWhatsApp returned no results for ADMIN_NUMBER');
        }
      } catch (e) {
        logger.warn(`Could not resolve Admin JID: ${e.message}`);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      // Store every message (in and out) so getMessage can serve retries
      if (msg.key?.id && msg.message) {
        msgStore.set(msg.key.id, msg.message);
      }

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

module.exports = { startWhatsApp };
