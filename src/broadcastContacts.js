const fs = require('fs');
const path = require('path');

const FILE = path.join(process.cwd(), 'data', 'broadcast_contacts.json');

function load() {
  try {
    if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {}
  return [];
}

function save(contacts) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(contacts, null, 2), 'utf8');
}

function getContacts() {
  return load();
}

// Accepts array of { name, phone } objects
function addContacts(newContacts) {
  const existing = load();
  const existingPhones = new Set(existing.map(c => c.phone));
  let added = 0;
  for (const c of newContacts) {
    const phone = c.phone.replace(/\D/g, '');
    if (!phone || phone.length < 7) continue;
    if (!existingPhones.has(phone)) {
      existing.push({ name: c.name || null, phone });
      existingPhones.add(phone);
      added++;
    }
  }
  save(existing);
  return { total: existing.length, added };
}

function clearContacts() {
  save([]);
}

// Parse text lines in format "Nombre | Número" or just "Número"
function parseContactsText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const result = [];
  for (const line of lines) {
    if (line.startsWith('#')) continue; // allow comment lines
    const parts = line.split('|').map(p => p.trim());
    if (parts.length >= 2) {
      result.push({ name: parts[0], phone: parts[1].replace(/\D/g, '') });
    } else {
      const phone = parts[0].replace(/\D/g, '');
      if (phone.length >= 7) result.push({ name: null, phone });
    }
  }
  return result;
}

function formatContactsForDisplay(contacts) {
  if (!contacts.length) return 'Lista vacía.';
  return contacts.map((c, i) => `${i + 1}. ${c.name || 'Sin nombre'} — ${c.phone}`).join('\n');
}

module.exports = { getContacts, addContacts, clearContacts, parseContactsText, formatContactsForDisplay };
