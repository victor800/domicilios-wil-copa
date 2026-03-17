require('dotenv').config();
const { wilBot, iniciarCron, saludarAlArrancar } = require('./src/bot/wilBot');

// ✅ AGREGA ESTO - servidor HTTP para Render
const express = require('express');
const app = express();
app.get('/', (req, res) => res.send('WilBot activo ✅'));
app.listen(process.env.PORT || 3000, () => {
  console.log(`🌐 Servidor HTTP corriendo en puerto ${process.env.PORT || 3000}`);
});

wilBot.launch().then(async () => {
  console.log('🤖 WilBot corriendo');
  iniciarCron();
  await saludarAlArrancar();
});

process.once('SIGINT', () => wilBot.stop('SIGINT'));
process.once('SIGTERM', () => wilBot.stop('SIGTERM'));