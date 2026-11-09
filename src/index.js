require('dotenv').config();
const express = require('express');
const { startWhatsApp } = require('./whatsapp');
const { scheduleDailySummary } = require('./dailySummary');
const { scheduleAgendaChecker } = require('./agenda');
const logger = require('./logger');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  logger.info(`HTTP server running on port ${PORT}`);
});

startWhatsApp()
  .then(sock => {
    scheduleDailySummary(sock);
    scheduleAgendaChecker(sock);
  })
  .catch(err => {
    logger.error('Failed to start WhatsApp:', err);
    process.exit(1);
  });
