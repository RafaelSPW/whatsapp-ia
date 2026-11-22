require('dotenv').config();

// Suppress noisy libsignal session renegotiation logs.
// Patch both console methods AND process.stdout/stderr.write because libsignal
// may capture the original console reference at import time.
const SESSION_NOISE = ['Bad MAC', 'Closing session', 'Failed to decrypt', 'Decrypted message with closed session', 'Closing open session'];
const _suppress = (...args) => SESSION_NOISE.some(s => String(args[0] ?? '').includes(s));
['log', 'error', 'warn'].forEach(m => {
  const orig = console[m].bind(console);
  console[m] = (...args) => { if (!_suppress(...args)) orig(...args); };
});
const _origStdoutWrite = process.stdout.write.bind(process.stdout);
const _origStderrWrite = process.stderr.write.bind(process.stderr);
process.stdout.write = (chunk, ...rest) => SESSION_NOISE.some(s => String(chunk).includes(s)) ? true : _origStdoutWrite(chunk, ...rest);
process.stderr.write = (chunk, ...rest) => SESSION_NOISE.some(s => String(chunk).includes(s)) ? true : _origStderrWrite(chunk, ...rest);
const express = require('express');
const { startWhatsApp, getLatestQR } = require('./whatsapp');
const QRCode = require('qrcode');
const { scheduleDailySummary, buildDailySummary } = require('./dailySummary');
const { scheduleDailyBroadcast, sendDailyBroadcast, loadCampaign, saveCampaign } = require('./dailyBroadcast');
const { getContacts, addContacts, clearContacts, parseContactsText } = require('./broadcastContacts');
const logger = require('./logger');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const API_SECRET = process.env.API_SECRET || null;

app.use(express.json());

// Simple API key guard — only applied to /api/* routes
function apiAuth(req, res, next) {
  if (!API_SECRET) return next(); // no secret configured = open (dev only)
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ----- Public -----
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/qr', async (req, res) => {
  const qr = getLatestQR();
  if (!qr) {
    return res.send('<h2>WhatsApp ya está conectado o todavía no generó QR. Esperá unos segundos y recargá.</h2>');
  }
  const imgData = await QRCode.toDataURL(qr, { scale: 8 });
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>WhatsApp QR</title>
  <meta http-equiv="refresh" content="20">
  <style>body{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#111;color:#fff;font-family:sans-serif;}img{border:8px solid #fff;border-radius:12px;}</style>
  </head><body><h2>Escaneá con WhatsApp</h2><img src="${imgData}"/><p>Se recarga automáticamente cada 20 segundos</p></body></html>`);
});

// ----- Test / Admin API -----
// All these routes are for local testing. Set API_SECRET in .env to protect them.

// GET /api/contacts — list broadcast contacts
app.get('/api/contacts', apiAuth, (req, res) => {
  res.json(getContacts());
});

// POST /api/contacts — add contacts
// Body: [{ name, phone }, ...] OR plain text with "Nombre | Número" lines (text/plain)
app.post('/api/contacts', apiAuth, (req, res) => {
  let parsed;
  if (typeof req.body === 'string' || req.headers['content-type']?.includes('text/plain')) {
    parsed = parseContactsText(req.body);
  } else if (Array.isArray(req.body)) {
    parsed = req.body;
  } else {
    return res.status(400).json({ error: 'Body must be a JSON array or plain text list' });
  }
  const result = addContacts(parsed);
  res.json(result);
});

// DELETE /api/contacts — clear all broadcast contacts
app.delete('/api/contacts', apiAuth, (req, res) => {
  clearContacts();
  res.json({ ok: true });
});

// GET /api/campaign — get current campaign config
app.get('/api/campaign', apiAuth, (req, res) => {
  res.json(loadCampaign());
});

// PUT /api/campaign — update campaign config
// Body: { candidateName, info, dailyMessage }
app.put('/api/campaign', apiAuth, (req, res) => {
  const current = loadCampaign();
  const updated = { ...current, ...req.body };
  saveCampaign(updated);
  res.json(updated);
});

// POST /api/broadcast/trigger — send broadcast now (requires WhatsApp connected)
app.post('/api/broadcast/trigger', apiAuth, async (req, res) => {
  if (!global.whatsappSock) {
    return res.status(503).json({ error: 'WhatsApp not connected yet' });
  }
  try {
    const result = await sendDailyBroadcast(global.whatsappSock);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/broadcast/log — last broadcast logs
app.get('/api/broadcast/log', apiAuth, (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const logFile = path.join(process.cwd(), 'data', 'broadcast_log.json');
  try {
    if (fs.existsSync(logFile)) return res.json(JSON.parse(fs.readFileSync(logFile, 'utf8')));
  } catch {}
  res.json({});
});

// GET /api/daily-summary — generate and return today's summary (without sending)
app.get('/api/daily-summary', apiAuth, async (req, res) => {
  try {
    const summary = await buildDailySummary();
    res.json({ summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function openBrowser(url) {
  const { exec } = require('child_process');
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

function startServer(port) {
  const server = app.listen(port, () => {
    logger.info(`HTTP server running on port ${port}`);
    if (!API_SECRET) logger.warn('API_SECRET not set — /api/* routes are unprotected');
    if (process.env.NODE_ENV !== 'production') openBrowser(`http://localhost:${port}/qr`);
  });
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      logger.warn(`Port ${port} in use, trying ${port + 1}...`);
      startServer(port + 1);
    } else {
      logger.error('HTTP server error:', err);
    }
  });
}

startServer(PORT);

// Proxy that always uses the current active socket, even after reconnects
const sockProxy = new Proxy({}, {
  get(_, prop) {
    return global.whatsappSock?.[prop];
  },
});

startWhatsApp()
  .then(() => {
    scheduleDailyBroadcast(sockProxy);
    scheduleDailySummary(sockProxy);
  })
  .catch(err => {
    logger.error('Failed to start WhatsApp:', err);
    process.exit(1);
  });
