const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeInMemoryStore,
  jidNormalizedUser,
} = require('@whiskeysockets/baileys');
const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode-terminal');
const logger = require('./logger');
const { handleMessage } = require('./messageHandler');
const { setDrJid, registerDrJid } = require('./drConfig');

const AUTH_FOLDER = path.join(process.cwd(), 'auth_info');

if (process.env.CLEAR_AUTH === 'true' && fs.existsSync(AUTH_FOLDER)) {
  fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
  logger.info('auth_info cleared (CLEAR_AUTH=true)');
}

// Set PAIRING_NUMBER in .env to use pairing code instead of QR
const PAIRING_NUMBER = process.env.PAIRING_NUMBER;

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

  const sockOptions = {
    auth: state,
    printQRInTerminal: false,
    logger: require('pino')({ level: 'silent' }),
    generateHighQualityLinkPreview: false,
  };
  // Pairing code requires no browser override — WhatsApp rejects linking when browser is spoofed
  if (!PAIRING_NUMBER) {
    sockOptions.browser = ['Chrome (Linux)', '', ''];
  }
  const sock = makeWASocket(sockOptions);

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
          logger.info('Falling back to QR code:');
          qrcode.generate(qr, { small: true });
        }
      } else if (!PAIRING_NUMBER) {
        logger.info('Scan this QR code with WhatsApp:');
        qrcode.generate(qr, { small: true });
      }
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      logger.warn(`Connection closed (code ${code}). Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(() => startWhatsApp(), 5000);
      }
    }

    if (connection === 'open') {
      logger.info('WhatsApp connected successfully');
      // Resolve Dr. Castro's real JID (may be @lid in newer WhatsApp versions)
      try {
        const results = await sock.onWhatsApp(process.env.DR_CASTRO_NUMBER);
        logger.info(`onWhatsApp result for Dr. Castro: ${JSON.stringify(results)}`);
        if (results && results.length > 0) {
          setDrJid(results[0].jid);
          logger.info(`Dr. Castro JID resolved: ${results[0].jid}`);
          // Also register the @lid so incoming messages are recognized
          if (results[0].lid) {
            registerDrJid(results[0].lid);
            logger.info(`Dr. Castro LID registered: ${results[0].lid}`);
          }
        } else {
          logger.warn('onWhatsApp returned no results for DR_CASTRO_NUMBER');
        }
      } catch (e) {
        logger.warn(`Could not resolve Dr. Castro JID: ${e.message}`);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      const jid = msg.key.remoteJid;
      if (jid.endsWith('@g.us')) continue;
      if (jid.endsWith('@newsletter')) continue;

      await handleMessage(sock, msg, msg.pushName || null);
    }
  });

  return sock;
}

module.exports = { startWhatsApp };
