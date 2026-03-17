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

// ⏰ Horario activo: 9am - 11pm hora Colombia (UTC-5)
wilBot.use(async (ctx, next) => {
  const hora = new Date().toLocaleString('en-US', { 
    timeZone: 'America/Bogota', 
    hour: 'numeric', 
    hour12: false 
  });
  const h = parseInt(hora);
  if (h >= 9 && h < 23) {
    return next();
  } else {
    return ctx.reply('🌙 Estamos fuera de horario. Atendemos de 9am a 11pm.');
  }
});

// 🔄 Keep-alive: ping cada 14 minutos
setInterval(() => {
  const hora = new Date().toLocaleString('en-US', {
    timeZone: 'America/Bogota',
    hour: 'numeric',
    hour12: false
  });
  const h = parseInt(hora);
  if (h >= 9 && h < 23) {
    console.log(`✅ Bot activo - ${new Date().toLocaleString('es-CO', {timeZone: 'America/Bogota'})}`);
  }
}, 5 * 60 * 1000);