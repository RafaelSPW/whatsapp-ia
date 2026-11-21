# WhatsApp Bot — Asistente de Marketing de Campaña

Asistente de campaña para WhatsApp. Actúa como "Ana", una asistente humana del estudio de marketing, con dos funciones principales: envía diariamente información de campaña a todos los contactos registrados y responde dudas sobre la postulación del candidato.

---

## Funciones

- **Difusión diaria automática**: cada día a las 9:00 AM (Argentina) envía un mensaje de campaña a todos los contactos registrados. El mensaje puede ser fijo (configurado por el admin) o generado automáticamente por IA con la información del candidato.
- Responde preguntas sobre la postulación: propuesta, posición política, agenda de campaña, datos del candidato.
- Transcribe notas de voz automáticamente antes de procesarlas.
- Simula comportamiento humano: tiempo de lectura, tiempo de escritura, errores de tipeo ocasionales con autocorrección.
- Detecta contactos que quieren participar activamente (voluntarios, difusores) y envía un resumen al director de campaña.
- Avisa al admin cuando un contacto conocido inicia una nueva conversación.
- Genera un resumen diario a las 20:00 (Argentina) con todas las interacciones del día.
- Agenda de campaña: el admin puede agendar recordatorios y eventos mediante lenguaje natural. Opcionalmente notifica al contacto.
- Panel de administración accesible solo desde el número del admin.

---

## Panel de administración

El director de campaña accede al panel enviando `menu` u `opciones` al bot desde su WhatsApp.

| Opción | Función |
|--------|---------|
| 1 | Cambiar número admin |
| 2 | Gestionar lista de contactos (ver / agregar / limpiar) |
| 3 | Ver agenda de campaña |
| 4 | Configurar candidato y campaña |
| 5 | Enviar difusión manual ahora |
| 6 | Subir catálogo de servicios |
| 7 | Ver / Modificar catálogo |
| 8 | Contactar al desarrollador |

Para agendar, el admin puede escribir frases como:
```
Agendar mañana a las 10:00 llamar a Juan Pérez
Agendar 15/11 a las 09:30 acto en la plaza
```

---

## Variables de entorno

Copiá `.env.example` a `.env` y completá los valores:

| Variable | Descripción | Requerida |
|----------|-------------|-----------|
| `GEMINI_API_KEY` | API key de Google Gemini | Sí |
| `ADMIN_NUMBER` | Número WhatsApp del admin/director (sin + ni espacios) | Sí |
| `PAIRING_NUMBER` | Número del bot para autenticarse sin QR (opcional) | No |
| `PORT` | Puerto del servidor HTTP (default: 3000) | No |
| `FIRM_NAME` | Nombre del estudio de marketing | No |
| `CANDIDATE_NAME` | Nombre del candidato | No |
| `CAMPAIGN_INFO` | Información de campaña para contexto de la IA | No |
| `BROADCAST_HOUR_UTC` | Hora UTC para la difusión diaria (default: 12 = 9 AM Argentina) | No |

La información de campaña también se puede actualizar en tiempo de ejecución desde el panel admin (opción 6), sin reiniciar el bot.

---

## Clasificación de contactos

El bot clasifica automáticamente cada conversación:

| Clasificación | Significado |
|---------------|-------------|
| `INTERESADO` | Quiere participar activamente (voluntario, difusor, colaborador). Requiere nombre y teléfono. Se envía resumen al admin. |
| `CONSULTANDO` | Solo tiene preguntas sobre la campaña, sin compromiso de participación activa. |
| `PENDIENTE` | Conversación en curso, sin clasificación definitiva aún. |

---

## Difusión diaria

El bot envía automáticamente un mensaje a cada contacto en `data/broadcast_contacts.json`:

- **Hora**: 9:00 AM Argentina (configurable vía `BROADCAST_HOUR_UTC`)
- **Mensaje**: Se toma del campo `dailyMessage` en `data/campaign.json`. Si está vacío, se genera automáticamente con Gemini usando la información del candidato.
- **Log**: Cada difusión queda registrada en `data/broadcast_log.json` con los contadores de envíos y el mensaje usado.
- **Trigger manual**: desde el panel admin, opción 7.

---

## Configuración del candidato

Desde la opción 4 del panel admin se configura en formato `Nombre | Título/cargo | Biografía | Info de campaña | Mensaje del día`:

```
Juan Pérez | Ing. | Ingeniero civil, 20 años en gestión pública | Candidato a intendente por el partido X | Seguimos trabajando por nuestra ciudad.
```

- **Nombre**: nombre completo del candidato
- **Título/cargo**: tratamiento o cargo (Ing., Dr., Lic., etc.) — se antepone al nombre en la conversación
- **Biografía**: descripción breve del candidato para que la IA responda preguntas personales
- **Info de campaña**: propuestas, posiciones políticas, contexto electoral
- **Mensaje del día**: texto fijo para la difusión diaria (si se omite, se genera automáticamente con IA)

También se puede configurar via API:
```bash
curl -X PUT http://localhost:3000/api/campaign \
  -H "Content-Type: application/json" \
  -d '{"candidateName":"Juan Pérez","candidateTitle":"Ing.","candidateBio":"Ingeniero civil...","info":"Candidato a intendente..."}'
```

---

## Gestión de contactos de difusión

Los contactos para la difusión diaria son una lista separada que el admin provee. No son los contactos del teléfono.

Desde el panel admin (opción 2) se puede:
- **Ver** la lista actual
- **Agregar** contactos con el formato `Nombre | Número` (uno por línea)
- **Limpiar** toda la lista

Ejemplo de lista para agregar:
```
Juan Pérez | 5491112345678
María García | 5491187654321
Carlos López | 59891234567
```

También via API:
```bash
# Ver contactos
curl http://localhost:3000/api/contacts

# Agregar contactos (JSON)
curl -X POST http://localhost:3000/api/contacts \
  -H "Content-Type: application/json" \
  -d '[{"name":"Juan Pérez","phone":"5491112345678"}]'

# Limpiar lista
curl -X DELETE http://localhost:3000/api/contacts
```

---

## Archivos de datos

| Archivo | Descripción |
|---------|-------------|
| `data/broadcast_contacts.json` | Lista de contactos para difusión diaria (gestionada por el admin) |
| `data/clients.json` | Contactos que han respondido al bot (auto-gestionado) |
| `data/campaign.json` | Configuración de campaña (candidato, título, bio, info, mensaje diario) |
| `data/broadcast_log.json` | Historial de difusiones enviadas |
| `data/agenda.json` | Recordatorios agendados |
| `data/dr_jid.json` | JID del admin para envío de mensajes |
| `data/daily_YYYY-MM-DD.json` | Log de conversaciones del día |
| `auth_info/` | Sesión de WhatsApp (no subir al repo) |

---

## API HTTP para testing local

El servidor expone endpoints para probar funcionalidades sin usar el panel de WhatsApp. Configurá `API_SECRET` en `.env` para protegerlos (si no está configurado, quedan abiertos — solo para desarrollo local).

```bash
# Pasar la clave: header X-Api-Key o query param ?key=
curl -H "X-Api-Key: mi_clave" http://localhost:3000/api/contacts
```

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/health` | Estado del servidor |
| GET | `/api/contacts` | Ver lista de contactos |
| POST | `/api/contacts` | Agregar contactos (array JSON o texto plano) |
| DELETE | `/api/contacts` | Limpiar lista de contactos |
| GET | `/api/campaign` | Ver configuración de campaña |
| PUT | `/api/campaign` | Actualizar campaña |
| POST | `/api/broadcast/trigger` | Disparar difusión ahora (requiere WhatsApp conectado) |
| GET | `/api/broadcast/log` | Historial de difusiones |
| GET | `/api/daily-summary` | Generar resumen del día sin enviarlo |

---

## Instalación y primer uso

```bash
npm install
cp .env.example .env
# Editá .env con tus valores
npm run dev
```

Escaneá el QR con la cuenta de WhatsApp del bot (o usá pairing code si configuraste `PAIRING_NUMBER`).

El admin envía `menu` al bot desde su WhatsApp para registrar su número y acceder al panel.

---

## Despliegue en Railway

1. Push al repo (`.gitignore` excluye `auth_info/` y `.env`)
2. Conectá Railway al repo
3. Configurá las variables de entorno
4. Creá un volumen montado en `/app/data`
5. Subí `auth_info/` al volumen via Railway CLI
6. Deploy

---

## Desarrollo

```bash
npm run dev    # auto-recarga con nodemon
npm start      # producción
```

---

## Dependencias principales

| Paquete | Uso |
|---------|-----|
| `@whiskeysockets/baileys` | Integración con WhatsApp Web |
| `@google/generative-ai` | IA: respuestas, transcripción de audio, resúmenes |
| `node-cron` | Difusión diaria, resumen diario, agenda |
| `express` | Servidor HTTP con health check |
| `pino` | Logging estructurado |

---

Desarrollado por Rafael Núñez — rafaelnunezinzaurralde@gmail.com
