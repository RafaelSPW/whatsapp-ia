const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { Resend } = require('resend');

function initFirestore() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('Faltan variables de entorno de Firebase (FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY)');
  }

  if (!getApps().length) {
    initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
  }

  console.log(`Firestore inicializado — proyecto: ${projectId}`);
  return getFirestore();
}

// ── Notificar error al admin por WhatsApp ────────────────────────────────────
async function notifyAdmin(socks, msg) {
  const adminNumber = process.env.ADMIN_NUMBER;
  if (!adminNumber) return;
  const jid = adminNumber.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
  for (const sock of socks) {
    try {
      await sock.sendMessage(jid, { text: `⚠️ Error en envío:\n${msg}` });
      return;
    } catch {}
  }
}

// ── WhatsApp listener con múltiples sockets ──────────────────────────────────
function startWhatsAppListener(socks, db) {
  let sockIdx = 0;

  db.collection('send_queue')
    .where('status', '==', 'pending')
    .where('type', '==', 'whatsapp')
    .onSnapshot(async (snapshot) => {
      for (const change of snapshot.docChanges()) {
        if (change.type !== 'added') continue;

        const doc = change.doc;
        const { to, body, mediaUrl, waFrom } = doc.data();

        // Use live socks (updated on reconnect) over the initial snapshot
        const liveSocks = global.whatsappSocks || socks;
        const activeSocks = liveSocks.filter(s => s);
        if (!activeSocks.length) {
          await doc.ref.update({ status: 'error', error: 'No hay conexiones WhatsApp activas' });
          continue;
        }
        const PAIRING_NUMBERS = [
          process.env.PAIRING_NUMBER,
          process.env.PAIRING_NUMBER_2,
          process.env.PAIRING_NUMBER_3,
        ];
        let sock;
        if (waFrom) {
          const idx = PAIRING_NUMBERS.findIndex(n => n === waFrom);
          sock = (idx >= 0 && liveSocks[idx]) ? liveSocks[idx] : activeSocks[sockIdx % activeSocks.length];
        } else {
          sock = activeSocks[sockIdx % activeSocks.length];
        }
        sockIdx++;

        try {
          const jid = to.replace(/[^0-9]/g, '') + '@s.whatsapp.net';

          if (mediaUrl) {
            await sock.sendMessage(jid, { image: { url: mediaUrl }, caption: body || '' });
          } else {
            await sock.sendMessage(jid, { text: body });
          }

          await doc.ref.update({ status: 'sent', sent_at: FieldValue.serverTimestamp() });
          console.log(`[WhatsApp] Mensaje enviado a ${to}`);
        } catch (err) {
          console.error(`[WhatsApp] Error enviando a ${to}:`, err.message);
          await doc.ref.update({ status: 'error', error: err.message });
          await notifyAdmin(socks, `WhatsApp → ${to}: ${err.message}`);
        }
      }
    }, (err) => {
      console.error('[WhatsApp] Error en listener:', err.message);
    });

  console.log(`WhatsApp listener activo con ${socks.length} número(s) — escuchando send_queue...`);
}

// ── Email listener ───────────────────────────────────────────────────────────
function startEmailListener(socks, db) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[Email] RESEND_API_KEY no configurada — listener de email desactivado.');
    return;
  }

  const resend = new Resend(apiKey);
  const FROM = process.env.RESEND_FROM || 'noreply@infocap.uk';

  db.collection('send_queue')
    .where('status', '==', 'pending')
    .where('type', '==', 'email')
    .onSnapshot(async (snapshot) => {
      for (const change of snapshot.docChanges()) {
        if (change.type !== 'added') continue;

        const doc = change.doc;
        const { to, subject, body, mediaUrl } = doc.data();

        try {
          const bodyHtml  = `<p>${body.replace(/\n/g, '<br>')}</p>`;
          const imgHtml   = mediaUrl ? `<img src="${mediaUrl}" style="max-width:100%"/>` : '';
          const unsubHtml = doc.data().unsubscribeHtml || '';
          const html      = bodyHtml + imgHtml + unsubHtml;
          const sender    = doc.data().from || FROM;

          const { error } = await resend.emails.send({
            from: sender, to,
            subject: subject || 'Mensaje',
            html,
          });

          if (error) throw new Error(error.message);

          await doc.ref.update({ status: 'sent', sent_at: FieldValue.serverTimestamp() });
          console.log(`[Email] Enviado a ${to}`);
        } catch (err) {
          console.error(`[Email] Error enviando a ${to}:`, err.message);
          await doc.ref.update({ status: 'error', error: err.message });
          await notifyAdmin(socks, `Email → ${to}: ${err.message}`);
        }
      }
    }, (err) => {
      console.error('[Email] Error en listener:', err.message);
    });

  console.log(`Email listener activo — desde ${FROM}`);
}

// ── Entry point ──────────────────────────────────────────────────────────────
function startFirestoreListener(socks) {
  // Acepta un sock solo o un array de socks
  const sockArray = Array.isArray(socks) ? socks : [socks];

  let db;
  try {
    db = initFirestore();
  } catch (err) {
    console.error('Error inicializando Firestore:', err.message);
    return;
  }

  startWhatsAppListener(sockArray, db);
  startEmailListener(sockArray, db);
}

module.exports = { startFirestoreListener };
