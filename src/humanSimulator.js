// Simulates human typing behavior to avoid bot detection

const TYPOS = {
  'que': ['qeu', 'que'],
  'para': ['pra', 'para'],
  'con': ['con', 'ocn'],
  'una': ['una', 'un'],
  'por': ['pro', 'por'],
  'esto': ['esot', 'esto'],
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Returns delay in ms based on message length (simulates reading + thinking + typing)
function calculateDelay(incomingText, replyText) {
  const readingTime = Math.min(incomingText.length * 30, 4000);
  const thinkingTime = 1000 + Math.random() * 3000;
  const typingSpeed = 60 + Math.random() * 40; // chars per second
  const typingTime = (replyText.length / typingSpeed) * 1000;

  const total = readingTime + thinkingTime + typingTime;
  // Cap between 3s and 20s
  return Math.min(Math.max(total, 3000), 20000);
}

// Occasionally introduces a realistic typo then corrects it
function maybeAddTypo(text) {
  if (Math.random() > 0.15) return { text, hasTypo: false }; // 15% chance

  const words = text.split(' ');
  for (let i = 0; i < words.length; i++) {
    const lower = words[i].toLowerCase();
    if (TYPOS[lower]) {
      const variants = TYPOS[lower];
      const typo = variants[Math.floor(Math.random() * variants.length)];
      if (typo !== lower) {
        const typoText = words.map((w, idx) => idx === i ? typo : w).join(' ');
        return { text: typoText, correction: text, hasTypo: true };
      }
    }
  }
  return { text, hasTypo: false };
}

async function sendHumanLike(sock, jid, replyText, incomingText = '') {
  const delay = calculateDelay(incomingText, replyText);

  // Show "typing..." for a realistic duration
  await sock.sendPresenceUpdate('composing', jid);
  await sleep(delay * 0.7);

  const { text, correction, hasTypo } = maybeAddTypo(replyText);

  if (hasTypo) {
    // Send typo first
    await sock.sendMessage(jid, { text });
    await sleep(800 + Math.random() * 600);

    // Then send correction
    await sock.sendPresenceUpdate('composing', jid);
    await sleep(1200);
    await sock.sendMessage(jid, { text: correction });
  } else {
    await sleep(delay * 0.3);
    await sock.sendPresenceUpdate('paused', jid);
    await sleep(300);
    await sock.sendMessage(jid, { text: replyText });
  }

  await sock.sendPresenceUpdate('available', jid);
}

module.exports = { sendHumanLike, sleep };
