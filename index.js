require('dotenv').config();
const { wilBot, iniciarCron, saludarAlArrancar } = require('./src/bot/wilBot');

wilBot.launch().then(async () => {
  console.log('🤖 WilBot corriendo');
  iniciarCron();
  await saludarAlArrancar();
});

process.once('SIGINT', () => wilBot.stop('SIGINT'));
process.once('SIGTERM', () => wilBot.stop('SIGTERM'));