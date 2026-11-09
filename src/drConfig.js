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

const fallbackJid = `${process.env.DR_CASTRO_NUMBER}@s.whatsapp.net`;

// JID we use to SEND to Dr. Castro — updated when he registers
let sendJid = fallbackJid;

// All JIDs that identify incoming messages from Dr. Castro
const knownJids = new Set([fallbackJid]);

const persisted = loadPersistedJid();
if (persisted) {
  knownJids.add(persisted.incomingJid);
  if (persisted.sendJid) sendJid = persisted.sendJid;
}

function getDrJid() {
  return sendJid;
}

// Returns JIDs to try when sending to Dr. Castro
// @lid first (active encrypted session), @s.whatsapp.net as fallback
function getDrSendTargets() {
  const targets = [];
  if (sendJid !== fallbackJid) targets.push(sendJid); // @lid if registered
  targets.push(fallbackJid); // @s.whatsapp.net fallback
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
  if (phone === process.env.DR_CASTRO_NUMBER) {
    knownJids.add(jid); // cache for future messages
    return true;
  }
  return false;
}

module.exports = { getDrJid, getDrSendTargets, setDrJid, registerDrJid, isDrCastro };
