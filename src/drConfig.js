const fs = require('fs');
const path = require('path');

const JID_FILE = path.join(__dirname, '..', 'data', 'dr_jid.json');

function loadPersistedJid() {
  try {
    if (fs.existsSync(JID_FILE)) {
      const data = JSON.parse(fs.readFileSync(JID_FILE, 'utf8'));
      // Support old format { jid } and new format { incomingJid, sendJid }
      if (data.incomingJid) return data;
      if (data.jid) return { incomingJid: data.jid, sendJid: data.jid };
    }
  } catch {}
  return null;
}

function persistJid(data) {
  fs.mkdirSync(path.dirname(JID_FILE), { recursive: true });
  fs.writeFileSync(JID_FILE, JSON.stringify(data), 'utf8');
}

// Support ADMIN_NUMBER (new) and DR_CASTRO_NUMBER (legacy) env vars
const ADMIN_NUMBER = process.env.ADMIN_NUMBER || process.env.DR_CASTRO_NUMBER;
const fallbackJid = `${ADMIN_NUMBER}@s.whatsapp.net`;

// JID we use to SEND to the admin — updated when they register
let sendJid = fallbackJid;

// All JIDs that identify incoming messages from the admin
const knownJids = new Set([fallbackJid]);

const persisted = loadPersistedJid();
if (persisted) {
  knownJids.add(persisted.incomingJid);
  if (persisted.sendJid) sendJid = persisted.sendJid;
}

function getDrJid() {
  return sendJid;
}

// Returns JIDs to try when sending to the admin.
// LID first — in newer WhatsApp the Signal session is indexed by LID.
// Sending to @s.whatsapp.net when session is stored under @lid causes "esperando mensaje".
function getDrSendTargets() {
  const targets = [];
  // Add LID if registered (comes from onWhatsApp result[0].lid)
  for (const jid of knownJids) {
    if (jid.endsWith('@lid')) targets.push(jid);
  }
  // Always include @s.whatsapp.net as fallback
  if (!targets.includes(fallbackJid)) targets.push(fallbackJid);
  return targets;
}

// Register a JID for identification only, without changing the send target
function registerDrJid(jid) {
  knownJids.add(jid);
}

// incomingJid: how his messages arrive (@lid or @s.whatsapp.net)
// We reply to the same JID so the message lands in the existing chat thread
function setDrJid(incomingJid) {
  knownJids.add(incomingJid);
  sendJid = incomingJid;
  persistJid({ incomingJid, sendJid: incomingJid });
}

function isDrCastro(jid) {
  if (knownJids.has(jid)) return true;
  // Match by phone number regardless of JID suffix (@s.whatsapp.net vs @lid)
  const phone = jid.split('@')[0];
  if (phone === ADMIN_NUMBER) {
    knownJids.add(jid); // cache for future messages
    return true;
  }
  return false;
}

module.exports = { getDrJid, getDrSendTargets, setDrJid, registerDrJid, isDrCastro };
