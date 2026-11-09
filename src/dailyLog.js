// Registers every conversation of the day for the 20:00 daily summary.
// Stored in data/daily_YYYY-MM-DD.json, one file per day.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function logPath(dateKey) {
  return path.join(DATA_DIR, `daily_${dateKey}.json`);
}

function loadLog(dateKey = todayKey()) {
  const p = logPath(dateKey);
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  return {};
}

function saveLog(log, dateKey = todayKey()) {
  fs.writeFileSync(logPath(dateKey), JSON.stringify(log, null, 2), 'utf8');
}

// Called after every conversation that gets a final classification
function recordConversation(jid, { name, number, classification, summary, history }) {
  const log = loadLog();

  log[jid] = {
    jid,
    name: name || null,
    number,
    classification,        // CLIENTE_POTENCIAL | CURIOSO | PENDIENTE
    summary: summary || null,
    messageCount: history.length,
    recordedAt: new Date().toISOString(),
    // Compact transcript — last 20 exchanges max, enough for Dr. Castro to review
    transcript: history.slice(-20).map(e => ({
      from: e.role === 'user' ? (name || number) : 'Ana',
      text: e.content.slice(0, 300), // cap per line
    })),
  };

  saveLog(log);
}

function getTodayLog() {
  return loadLog();
}

module.exports = { recordConversation, getTodayLog };
