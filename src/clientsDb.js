const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(process.cwd(), 'data', 'clients.json');

// Ensure data dir exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let db = {};

// Load existing data on startup
try {
  if (fs.existsSync(DB_PATH)) {
    db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  }
} catch {
  db = {};
}

function save() {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}

// Returns the stored client record or null
function getClient(jid) {
  return db[jid] || null;
}

function saveClient(jid, { name, phone } = {}) {
  const existing = db[jid] || {};
  const invalid = /no proporcion|sin nombre|desconocido|pendiente/i;
  db[jid] = {
    ...existing,
    jid,
    number: existing.number || jid.replace('@s.whatsapp.net', '').replace('@lid', ''),
    name: (name && !invalid.test(name)) ? name : existing.name || null,
    phone: phone || existing.phone || null,
    firstContact: existing.firstContact || new Date().toISOString(),
    lastContact: new Date().toISOString(),
  };
  save();
  return db[jid];
}

function isKnownClient(jid) {
  return !!db[jid];
}

module.exports = { getClient, saveClient, isKnownClient };
