# WhatsApp Bot — Estudio Jurídico Dr. Paul Castro

Asistente de primer contacto para WhatsApp. Atiende mensajes entrantes actuando como una recepcionista humana llamada "Ana", clasifica a cada contacto y mantiene al Dr. Castro informado en tiempo real y con un resumen diario.

---

## Funciones

- Responde mensajes de texto y notas de voz (los audios se transcriben automáticamente antes de procesarlos)
- Simula comportamiento humano: tiempo de lectura, tiempo de escritura, errores de tipeo ocasionales con autocorrección
- Sin emojis en ningún mensaje
- Clasifica cada conversación: cliente potencial o curioso
- Al identificar un cliente potencial, envía un resumen al Dr. Castro con nombre, tipo de caso, urgencia y si quiere reunión
- Si el contacto es un cliente ya conocido, avisa al Dr. Castro en el momento en que escribe y luego envía el resumen al finalizar
- Todos los días a las 20:00 envía al Dr. Castro un resumen completo del día, incluyendo los casos que la IA descartó por si alguno merece revisión
- Agenda personal: el Dr. Castro puede agendar recordatorios escribiéndole al bot; el bot los dispara a la hora exacta

---

## Requisitos

- Node.js >= 18
- Clave de API de Google Gemini — obtenerla en aistudio.google.com
- Un número de WhatsApp dedicado para el bot (puede ser una línea prepaga o virtual)

---

## Instalación

```bash
npm install
```

Copiá el archivo de configuración y completalo:

```bash
cp .env.example .env
```

| Variable | Descripción |
|---|---|
| `GEMINI_API_KEY` | Clave de API de Google Gemini |
| `DR_CASTRO_NUMBER` | Número del Dr. Castro sin `+` ni espacios, ej: `5491112345678` |
| `FIRM_NAME` | Nombre del estudio (aparece en el contexto de la IA) |
| `FIRM_SPECIALTY` | Áreas de práctica, ej: `derecho civil, laboral y comercial` |
| `PORT` | Puerto HTTP — Railway lo asigna automáticamente, no hace falta tocarlo |

---

## Primer uso — vincular WhatsApp

La primera vez hay que vincular el número del bot escaneando un QR.

```bash
npm run dev
```

Aparece un código QR en la terminal. En el celular del número del bot: WhatsApp > Dispositivos vinculados > Vincular dispositivo > escanear el QR.

Los datos de sesión quedan en la carpeta `auth_info/`. No subas esa carpeta a ningún repositorio ni la compartas.

### Registrar el número del Dr. Castro (obligatorio la primera vez)

WhatsApp usa un sistema de IDs internos (`@lid`) que no expone el número de teléfono directamente. Para que el bot reconozca al Dr. Castro, él tiene que enviar una sola vez desde su celular al número del bot:

```
//doctor
```

El bot responde confirmando el registro. El ID queda guardado en `data/dr_jid.json` y sobrevive reinicios del servidor. Solo hay que hacerlo una vez por instalación.

---

## Deploy en Railway

### Paso 1 — generar la sesión localmente

Corré el bot localmente al menos una vez y vinculá el número. Esto genera la carpeta `auth_info/` con los archivos de sesión.

### Paso 2 — crear el proyecto en Railway

1. Subí el código a un repositorio GitHub (sin `auth_info/`, sin `.env`, el `.gitignore` ya los excluye)
2. En Railway: New Project > Deploy from GitHub repo
3. Cargá las variables de entorno en Settings > Variables

### Paso 3 — persistencia de datos

Creá un Volume en Railway montado en `/app/data`. Este volume guarda:

- `auth_info/` — sesión de WhatsApp (si el bot se reinicia, no pierde la conexión)
- `clients.json` — base de datos de clientes conocidos con sus nombres
- `agenda.json` — recordatorios pendientes del Dr. Castro
- `dr_jid.json` — ID interno de WhatsApp del Dr. Castro (generado al enviar `//doctor`)
- `daily_YYYY-MM-DD.json` — log diario de conversaciones

```bash
# Con Railway CLI
railway login
railway link
railway volume upload auth_info/ /app/data/auth_info
railway up
```

---

## Flujo de una conversación

```
Mensaje de texto o audio entrante
          |
          v (audio: se transcribe primero)
    Ana responde con demora natural
          |
          v
  ¿Tiene un caso concreto?
       |         |
      Si         No
       |         |
  Resumen     Conversacion
  al Dr.      termina sin
  Castro      notificacion
       |
       v
  Se guarda el nombre
  en clients.json
```

Si el contacto ya estuvo antes: el Dr. Castro recibe un aviso inmediato con el nombre de la persona en cuanto escribe, y el resumen completo al finalizar.

---

## Resumen diario (20:00 Argentina)

Todos los días a las 20:00 el bot le envía al Dr. Castro un informe con todas las conversaciones del día. El informe contiene:

- Clientes que quieren reunión, con nombre, número y descripción del caso
- Casos descartados por la IA que podrían merecer atención — Gemini revisa su propio criterio y señala si algún "curioso" en realidad tenía un caso válido
- Conversaciones que quedaron sin clasificar (contactos que dejaron de responder a mitad)
- Observaciones generales del día

El horario está configurado como 23:00 UTC, que equivale a 20:00 Argentina (UTC-3). Railway corre en UTC por defecto. Si el servidor corre en otra zona horaria, ajustar el cron en `src/dailySummary.js`.

---

## Agenda personal

El Dr. Castro puede agendar recordatorios escribiéndole directamente al número del bot. El bot confirma cada recordatorio al instante y lo dispara a la hora exacta.

**Formatos aceptados** — el Dr. le escribe al número del bot:

```
Agenda hoy a las 17:30 reunión con cliente
Agendar mañana a las 10:00 llamar a Juan Pérez
agenda: 15/11 09:30 presentación en el juzgado
agenda: 20/11/2026 08:00 audiencia laboral
```

El bot confirma el recordatorio y envía dos avisos: uno 30 minutos antes y otro a la hora exacta.

Para cambiar el tiempo de anticipación, indicarlo entre corchetes al inicio de la descripción:

```
Agenda mañana a las 10:00 [15min] reunión con Juan
Agenda 15/11 a las 09:00 [1h] audiencia laboral
```

Los recordatorios se guardan en `data/agenda.json` y persisten entre reinicios del servidor. El scheduler los revisa cada minuto.

---

## Base de datos de clientes

Los clientes se guardan en `data/clients.json`. El nombre se registra en cuanto la IA lo extrae de la conversación. En contactos futuros, Ana ya sabe cómo llamar a esa persona y el aviso al Dr. Castro incluye el nombre en lugar del número.

```json
{
  "5491112345678@s.whatsapp.net": {
    "jid": "5491112345678@s.whatsapp.net",
    "number": "5491112345678",
    "name": "Juan Pérez",
    "firstContact": "2024-01-15T10:30:00.000Z",
    "lastContact": "2024-01-20T14:15:00.000Z"
  }
}
```

---

## Estructura del proyecto

```
src/
  index.js              Entrada: arranca WhatsApp y programa el resumen diario y la agenda
  whatsapp.js           Conexion Baileys, QR, reconexion automatica
  messageHandler.js     Orquesta el flujo de cada mensaje entrante y los comandos del Dr. Castro
  gemini.js             Llamadas a Gemini: respuestas de Ana, transcripcion de audios, resumen de conversacion
  humanSimulator.js     Delays y typos para simular escritura humana
  conversationStore.js  Historial en memoria por contacto durante la sesion activa
  clientsDb.js          Persistencia de clientes conocidos en disco (clients.json)
  dailyLog.js           Registra cada conversacion finalizada en el log del dia
  dailySummary.js       Arma y envia el resumen diario al Dr. Castro a las 20:00
  agenda.js             Agenda personal: guarda recordatorios y los dispara a la hora exacta
  logger.js             Logger con pino

data/                   Generado automaticamente, no subir al repo
  clients.json
  agenda.json
  daily_YYYY-MM-DD.json

auth_info/              Sesion de WhatsApp, no subir al repo
```

---

## Notas

- El bot ignora mensajes de grupos.
- El Dr. Castro puede escribirle al número del bot sin que el bot le responda.
- Si un audio no se puede transcribir, Ana le pide al contacto que escriba.
- Los clientes conocidos persisten entre reinicios del servidor gracias al archivo `clients.json`. Los historiales de conversación activa son en memoria y se pierden si el servidor se reinicia (comportamiento esperado).
