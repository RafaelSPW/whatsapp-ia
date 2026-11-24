# Bot WhatsApp IA — Campaña Álvaro

Asistente IA de campaña para WhatsApp. Atiende mensajes entrantes en 3 números simultáneamente, envía campañas masivas vía Firestore y notifica al administrador. Desplegado en Railway.

---

## Funciones

- Responde mensajes entrantes en los **3 números WhatsApp** con IA (Gemini)
- Transcribe mensajes de voz automáticamente
- Simula comportamiento humano: typing, delays variables, errores de tipeo ocasionales
- Clasifica cada conversación (`INTERESADO`, `CONSULTANDO`, `PENDIENTE`)
- Cuando un contacto es `INTERESADO`, envía resumen al admin (ADMIN_NUMBER)
- Avisa al admin cuando un contacto conocido inicia una nueva conversación
- Genera un resumen diario a las 20:00 (Argentina)
- Difusión diaria automática a las 9:00 AM (Argentina)
- Escucha la colección `send_queue` de Firestore para campañas masivas (WhatsApp y Email)

---

## Arquitectura

```
software alvaro/
├── src/
│   ├── index.js              # Entry point: Express + arranque WA + Firestore
│   ├── whatsapp.js           # Conexión Baileys multi-número (WA1/WA2/WA3)
│   ├── messageHandler.js     # Lógica IA: recibe mensajes, responde con Gemini
│   ├── firestore.js          # Listener send_queue: campañas WA y Email
│   ├── gemini.js             # Integración Google Gemini
│   ├── humanSimulator.js     # Simula comportamiento humano
│   ├── drConfig.js           # Config número admin, mapeo @lid → JID
│   ├── conversationStore.js  # Historial de conversaciones en memoria
│   ├── clientsDb.js          # Base de datos de contactos conocidos
│   ├── catalog.js            # Catálogo de servicios
│   ├── dailyBroadcast.js     # Difusión automática diaria
│   ├── dailySummary.js       # Resumen diario al admin
│   ├── dailyLog.js           # Log de conversaciones del día
│   ├── broadcastContacts.js  # Lista de contactos para difusión
│   └── logger.js             # Logger con pino
├── railway.toml
└── package.json
```

---

## Números WhatsApp

| Variable | Número | Auth |
|---|---|---|
| `PAIRING_NUMBER` | 59891449672 (WA1) | `AUTH_DATA` |
| `PAIRING_NUMBER_2` | 59892672372 (WA2) | `AUTH_DATA_2` |
| `PAIRING_NUMBER_3` | 59892636720 (WA3) | `AUTH_DATA_3` |

Los 3 números atienden mensajes entrantes. Las campañas se distribuyen entre los 3 vía round-robin o por número específico (`waFrom` en el documento de Firestore).

---

## Variables de entorno (Railway)

```
# WhatsApp — números y sesiones
PAIRING_NUMBER=59891449672
PAIRING_NUMBER_2=59892672372
PAIRING_NUMBER_3=59892636720
AUTH_DATA=<base64 sesión WA1>
AUTH_DATA_2=<base64 sesión WA2>
AUTH_DATA_3=<base64 sesión WA3>

# Admin
ADMIN_NUMBER=59894032474

# IA
GEMINI_API_KEY=<clave Google Gemini>

# Firebase (Firestore)
FIREBASE_PROJECT_ID=alvaro-42b7e
FIREBASE_CLIENT_EMAIL=<service account email>
FIREBASE_PRIVATE_KEY=<private key>

# Email (Resend)
RESEND_API_KEY=<clave Resend>
RESEND_FROM=noreply@infocap.uk

# Opcional
API_SECRET=<clave para rutas /api/*>
PORT=3000
```

---

## Flujo de campañas (Firestore send_queue)

El panel web crea documentos en `send_queue`. El bot los procesa en tiempo real.

**WhatsApp:**
```json
{
  "type": "whatsapp",
  "status": "pending",
  "to": "+59891234567",
  "body": "Mensaje de campaña",
  "waFrom": "59892672372"
}
```
`waFrom` es opcional; si se omite, se usa round-robin entre los 3 números.

**Email:**
```json
{
  "type": "email",
  "status": "pending",
  "to": "destinatario@email.com",
  "subject": "Asunto",
  "body": "Cuerpo del mensaje"
}
```

---

## Clasificación de conversaciones

| Clasificación | Significado |
|---|---|
| `INTERESADO` | Quiere participar activamente. Se envía resumen al admin. |
| `CONSULTANDO` | Solo tiene preguntas, sin compromiso activo. |
| `PENDIENTE` | Conversación en curso. |

---

## API HTTP

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Estado del servidor |
| GET | `/api/contacts` | Ver contactos de difusión |
| POST | `/api/contacts` | Agregar contactos |
| DELETE | `/api/contacts` | Limpiar lista |
| GET | `/api/campaign` | Ver configuración de campaña |
| PUT | `/api/campaign` | Actualizar campaña |
| POST | `/api/broadcast/trigger` | Disparar difusión manual |
| GET | `/api/broadcast/log` | Historial de difusiones |
| GET | `/api/daily-summary` | Generar resumen del día |

---

## Deploy

```bash
cd "software alvaro"
railway up --detach
```

Las sesiones se exportan automáticamente al conectar. Copiar los valores `AUTH_DATA*` que aparecen en los logs a las variables de Railway para persistir entre deploys.

## Re-parear un número

1. Borrar `AUTH_DATA_X` en Railway
2. Hacer un nuevo deploy
3. En los logs aparece: `>>> [WAX] Código para NÚMERO: XXXXXX`
4. WhatsApp → Dispositivos vinculados → Vincular dispositivo → Ingresar código

---

Desarrollado por Rafael Núñez — rafaelnunezinzaurralde@gmail.com
