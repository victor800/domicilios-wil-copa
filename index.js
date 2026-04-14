// index.js — Domicilios WIL
// ══════════════════════════════════════════════════════════════════════════════
require('dotenv').config();

const express = require('express');
const path    = require('path');
const moment  = require('moment-timezone');

const { wilBot, iniciarCron, saludarAlArrancar, getPool, getDrivers } = require('./src/bot/wilBot');
const { router: apiRouter, setPoolRef, setBotRef } = require('./api/routes');

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS DE HORARIO
// ══════════════════════════════════════════════════════════════════════════════
const HORA_APERTURA = 9;   // 9:00 AM
const HORA_CIERRE   = 23;  // 11:00 PM

function estaEnHorario() {
  const h = parseInt(
    new Date().toLocaleString('en-US', {
      timeZone: 'America/Bogota',
      hour:     'numeric',
      hour12:   false,
    })
  );
  return h >= HORA_APERTURA && h < HORA_CIERRE;
}

function mensajeHorarioCerrado() {
  const ahora = moment().tz('America/Bogota');
  const hora  = ahora.format('hh:mm A');
  const dia   = ahora.format('dddd D [de] MMMM');
  return (
    `🌙 <b>Domicilios WIL — Fuera de horario</b>\n\n` +
    `Hola 👋 Son las <b>${hora}</b> del <b>${dia}</b>.\n\n` +
    `Nuestro horario de atención es:\n` +
    `⏰ <b>9:00 AM – 11:00 PM</b> todos los días 📅\n\n` +
    `En cuanto abramos, con gusto te atendemos. 🛵\n` +
    `¡Hasta pronto!`
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// MIDDLEWARE HORARIO
// Debe registrarse ANTES de wilBot.launch() para bloquear TODO el flujo
// ══════════════════════════════════════════════════════════════════════════════
wilBot.use(async (ctx, next) => {
  // /start siempre pasa — así el cliente ve el mensaje de horario cerrado
  const esStart = ctx.message?.text === '/start';

  if (estaEnHorario() || esStart) {
    return next(); // ✅ En horario o /start → continuar flujo normal
  }

  // ❌ Fuera de horario → responder y NO continuar (no llama next())
  try {
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery('🌙 Fuera de horario. Atendemos 9am–11pm', { show_alert: true });
    } else if (ctx.message) {
      await ctx.reply(mensajeHorarioCerrado(), { parse_mode: 'HTML' });
    }
  } catch (_) {}
  // No se llama next() → ningún handler del bot se ejecuta
});

// ══════════════════════════════════════════════════════════════════════════════
// EXPRESS — SERVIDOR HTTP
// ══════════════════════════════════════════════════════════════════════════════
const app = express();

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS — el HTML puede llamar a la API desde cualquier origen
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin',  '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,x-session-id,x-admin-key');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Servir el HTML del chat — coloca DomiciliosWIL.html en /public
app.use(express.static(path.join(__dirname, 'public')));

// API REST
app.use('/api', apiRouter);

// Raiz → sirve el chat
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'DomiciliosWIL.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 HTTP en puerto ${PORT}`);
  console.log(`🔗 API en /api`);
  console.log(`🌍 Chat en /`);
});

// ══════════════════════════════════════════════════════════════════════════════
// ARRANCAR BOT TELEGRAM
// ══════════════════════════════════════════════════════════════════════════════
wilBot.launch().then(async () => {
  console.log('🤖 WilBot corriendo en Telegram');
  setPoolRef(getPool(), getDrivers());
  setBotRef(wilBot);
  console.log('🔗 API conectada al pool y drivers del bot');
  iniciarCron();
  await saludarAlArrancar();
});

process.once('SIGINT',  () => wilBot.stop('SIGINT'));
process.once('SIGTERM', () => wilBot.stop('SIGTERM'));

// Keep-alive — log cada 5 minutos solo en horario activo
setInterval(() => {
  if (estaEnHorario()) {
    console.log(`✅ Bot activo — ${moment().tz('America/Bogota').format('DD/MM/YYYY hh:mm A')}`);
  }
}, 5 * 60 * 1000);