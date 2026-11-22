/**
 * Firestore listener — lee mensajes pendientes de la cola y los envía por WhatsApp.
 *
 * Colección: send_queue
 * Documento: { type: "whatsapp", to: "+59899...", body: "texto", mediaUrl: "", status: "pending" }
 *
 * Variables de entorno requeridas en Railway:
 *   FIREBASE_PROJECT_ID      → alvaro-42b7e
 *   FIREBASE_CLIENT_EMAIL    → desde la Service Account JSON
 *   FIREBASE_PRIVATE_KEY     → desde la Service Account JSON (con \n reales)
 */

const admin = require('firebase-admin');
const logger = require('./logger');

let db = null;

function initFirestore() {
  const projectId   = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey  = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    logger.warn('Firebase no configurado — FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL o FIREBASE_PRIVATE_KEY faltantes. El listener de Firestore no arrancará.');
    return false;
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
    });
  }

  db = admin.firestore();
  logger.info('Firestore inicializado — proyecto: ' + projectId);
  return true;
}

/**
 * Escucha la colección send_queue en tiempo real.
 * Cuando llega un doc con status="pending" y type="whatsapp", lo envía y marca como sent/error.
 */
function startFirestoreListener(sock) {
  if (!initFirestore()) return;

  logger.info('Firestore listener activo — escuchando send_queue...');

  db.collection('send_queue')
    .where('status', '==', 'pending')
    .where('type', '==', 'whatsapp')
    .onSnapshot(async (snapshot) => {
      for (const change of snapshot.docChanges()) {
        if (change.type !== 'added') continue;

        const doc  = change.doc;
        const data = doc.data();
        const { to, body, mediaUrl } = data;

        if (!to || !body) {
          await doc.ref.update({ status: 'error', error: 'Faltan campos to o body', processed_at: admin.firestore.FieldValue.serverTimestamp() });
          continue;
        }

        if (!sock?.sendMessage) {
          await doc.ref.update({ status: 'error', error: 'WhatsApp no conectado', processed_at: admin.firestore.FieldValue.serverTimestamp() });
          continue;
        }

        const phone = to.replace(/[^0-9]/g, '');
        const jid   = phone + '@s.whatsapp.net';

        try {
          if (mediaUrl) {
            await sock.sendMessage(jid, { image: { url: mediaUrl }, caption: body });
          } else {
            await sock.sendMessage(jid, { text: body });
          }
          await doc.ref.update({ status: 'sent', processed_at: admin.firestore.FieldValue.serverTimestamp() });
          logger.info(`WhatsApp enviado a ${to} (doc: ${doc.id})`);
        } catch (err) {
          logger.error(`Error enviando a ${to}: ${err.message}`);
          await doc.ref.update({ status: 'error', error: err.message, processed_at: admin.firestore.FieldValue.serverTimestamp() });
        }
      }
    }, (err) => {
      logger.error('Firestore listener error: ' + err.message);
    });
}

module.exports = { startFirestoreListener };
