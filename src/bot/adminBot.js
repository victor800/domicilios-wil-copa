const { Telegraf, Markup } = require('telegraf');
const {
  getPedidos, pendientesSinAtender, resumenDia,
  getDomiciliariosActivos, fmt
} = require('../services/sheets');
const moment = require('moment-timezone');
const cron   = require('node-cron');

const bot = new Telegraf(process.env.BOT_ADMIN_TOKEN);

const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS||'').split(',').map(s=>s.trim()).filter(Boolean);

const menuAdmin = Markup.keyboard([
  ['📊 Resumen del Día',    '📋 Pedidos Pendientes'],
  ['🚚 En Proceso',         '✅ Finalizados Hoy'],
  ['🛵 Domiciliarios',      '⏰ Recordatorio Manual'],
  ['📣 Mensaje Masivo',     '❓ Ayuda Admin']
]).resize();

// ── Verificar admin ───────────────────────────────────────────────────────────
function esAdmin(ctx) {
  const id = ctx.from?.id?.toString();
  if (ADMIN_IDS.length === 0) return true; // si no hay IDs configurados, permitir todo (modo dev)
  if (!ADMIN_IDS.includes(id)) {
    ctx.reply('🚫 No tienes acceso a este panel.');
    return false;
  }
  return true;
}

// ── /start ────────────────────────────────────────────────────────────────────
bot.start(ctx => {
  if (!esAdmin(ctx)) return;
  return ctx.reply(
    `👑 *Panel Administrador — WIL*\n\n¿Qué deseas hacer?`,
    { parse_mode:'Markdown', ...menuAdmin }
  );
});

// ── 📊 RESUMEN DEL DÍA ────────────────────────────────────────────────────────
bot.hears('📊 Resumen del Día', async ctx => {
  if (!esAdmin(ctx)) return;
  await ctx.reply('⏳ Obteniendo datos...');
  const r = await resumenDia();

  return ctx.reply(
    `📊 *RESUMEN DEL DÍA — ${r.hoy}*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `📦 Total pedidos: *${r.total}*\n\n` +
    `🟡 Pendientes:  *${r.pendientes}*\n` +
    `🔵 En proceso:  *${r.enProceso}*\n` +
    `🟢 Finalizados: *${r.finalizados}*\n\n` +
    `💰 Ventas del día: *$${fmt(r.ventas)}*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `_Actualizado: ${moment().tz('America/Bogota').format('hh:mm A')}_`,
    { parse_mode:'Markdown' }
  );
});

// ── 📋 PEDIDOS PENDIENTES ─────────────────────────────────────────────────────
bot.hears('📋 Pedidos Pendientes', async ctx => {
  if (!esAdmin(ctx)) return;
  const ps = await getPedidos('PENDIENTE').catch(()=>[]);
  if (!ps.length) return ctx.reply('✅ No hay pedidos pendientes ahora.');
  await ctx.reply(`📋 *${ps.length}* pendiente(s):`, { parse_mode:'Markdown' });
  for (const p of ps) {
    await ctx.reply(
      `🟡 *${p.id}*\n👤 ${p.cliente}  📱 ${p.telefono}\n🏪 ${p.negocio||'WIL'}\n📍 ${p.direccion}\n📦 ${p.productos||'—'}\n💰 $${fmt(p.total)}\n⏰ ${p.hora} — ${p.fecha}`,
      { parse_mode:'Markdown' }
    );
  }
});

// ── 🚚 EN PROCESO ─────────────────────────────────────────────────────────────
bot.hears('🚚 En Proceso', async ctx => {
  if (!esAdmin(ctx)) return;
  const ps = await getPedidos('EN_PROCESO').catch(()=>[]);
  if (!ps.length) return ctx.reply('📭 Ningún pedido en proceso.');
  await ctx.reply(`🚚 *${ps.length}* en proceso:`, { parse_mode:'Markdown' });
  for (const p of ps) {
    await ctx.reply(
      `🔵 *${p.id}*\n👤 ${p.cliente}  📱 ${p.telefono}\n📍 ${p.direccion}\n🛵 *${p.domiciliario||'?'}* — tomó a las ${p.horaTomo||'?'}`,
      { parse_mode:'Markdown' }
    );
  }
});

// ── ✅ FINALIZADOS HOY ────────────────────────────────────────────────────────
bot.hears('✅ Finalizados Hoy', async ctx => {
  if (!esAdmin(ctx)) return;
  const hoy = moment().tz('America/Bogota').format('DD/MM/YYYY');
  const ps  = (await getPedidos('FINALIZADO').catch(()=>[])).filter(p=>p.fecha===hoy);
  if (!ps.length) return ctx.reply(`📭 Sin finalizados hoy ${hoy}`);

  let msg = `✅ *${ps.length}* entrega(s) hoy ${hoy}:\n\n`;
  let totalDia = 0;
  ps.forEach((p,i) => {
    totalDia += parseFloat(p.total||0);
    msg += `${i+1}. 🆔 ${p.id}\n   🛵 ${p.domiciliario||'?'}\n   📍 ${p.direccion}\n   ⏰ ${p.horaEntrego||'?'}\n   💰 $${fmt(p.total)}\n\n`;
  });
  msg += `━━━━━━━━━━━━━━━━━━━━\n💰 Total cobrado: *$${fmt(totalDia)}*`;
  return ctx.reply(msg, { parse_mode:'Markdown' });
});

// ── 🛵 DOMICILIARIOS ACTIVOS ──────────────────────────────────────────────────
bot.hears('🛵 Domiciliarios', async ctx => {
  if (!esAdmin(ctx)) return;
  const { getDrivers } = require('./domiciliarioBot');
  const enLinea  = getDrivers();
  const enSheets = await getDomiciliariosActivos().catch(()=>[]);

  if (!Object.keys(enLinea).length && !enSheets.length) {
    return ctx.reply('😴 No hay domiciliarios conectados ahora.');
  }

  let msg = `🛵 *DOMICILIARIOS*\n━━━━━━━━━━━━━━━━━━\n\n`;
  msg += `📡 *En línea (autenticados):*\n`;

  const idsEnLinea = Object.keys(enLinea);
  if (idsEnLinea.length) {
    for (const [id, d] of Object.entries(enLinea)) {
      const estado = d.pedidoActual ? `🔵 Llevando ${d.pedidoActual}` : '🟢 Disponible';
      msg += `• *${d.nombre}* — ${estado}\n`;
    }
  } else {
    msg += `_Ninguno conectado ahora_\n`;
  }

  msg += `\n📋 *Registrados en sistema:*\n`;
  if (enSheets.length) {
    enSheets.forEach(d => { msg += `• ${d.nombre} (ID: ${d.telegramId||'—'})\n`; });
  } else {
    msg += `_Sin domiciliarios registrados_\n`;
  }

  return ctx.reply(msg, { parse_mode:'Markdown' });
});

// ── ⏰ RECORDATORIO MANUAL ────────────────────────────────────────────────────
bot.hears('⏰ Recordatorio Manual', async ctx => {
  if (!esAdmin(ctx)) return;
  await enviarRecordatorio(ctx);
});

async function enviarRecordatorio(ctx) {
  const pendientes = await pendientesSinAtender(5).catch(()=>[]);

  if (!pendientes.length) {
    if (ctx) return ctx.reply('✅ No hay pedidos pendientes sin atender por más de 5 minutos.');
    return;
  }

  const { getDrivers } = require('./domiciliarioBot');
  const drivers = getDrivers();

  let alertMsg = `⚠️ *¡PEDIDOS SIN ATENDER!*\n━━━━━━━━━━━━━━━━━━\n\n`;
  pendientes.forEach(p => {
    const hoy   = moment().tz('America/Bogota').format('DD/MM/YYYY');
    const t     = moment.tz(`${hoy} ${p.hora}`, 'DD/MM/YYYY hh:mm A', 'America/Bogota');
    const mins  = moment().tz('America/Bogota').diff(t, 'minutes');
    alertMsg += `🔴 *${p.id}*\n📍 ${p.direccion}\n📦 ${p.productos||'—'}\n⏰ Hace *${mins} minutos*\n\n`;
  });

  alertMsg += `_${pendientes.length} pedido(s) esperando domiciliario_`;

  // Enviar a admins
  if (ctx) await ctx.reply(alertMsg, { parse_mode:'Markdown' });

  // Enviar alerta a todos los drivers disponibles
  for (const [did, d] of Object.entries(drivers)) {
    if (!d.pedidoActual) {
      await bot.telegram.sendMessage(did,
        `🔴 *¡PEDIDOS SIN ATENDER!*\nHay ${pendientes.length} pedido(s) esperando.\nRevisa 📋 *Pendientes* ahora!`,
        { parse_mode:'Markdown' }
      ).catch(()=>{});
    }
  }

  // Notificar canal de pedidos
  try {
    await bot.telegram.sendMessage(
      process.env.CANAL_PEDIDOS_ID,
      alertMsg,
      { parse_mode:'Markdown' }
    );
  } catch(e) {}
}

// ── 📣 MENSAJE MASIVO A DOMICILIARIOS ─────────────────────────────────────────
const esperaMensajeMasivo = {};

bot.hears('📣 Mensaje Masivo', ctx => {
  if (!esAdmin(ctx)) return;
  esperaMensajeMasivo[ctx.from.id] = true;
  return ctx.reply(
    `📣 Escribe el mensaje que quieres enviar a *todos los domiciliarios*:`,
    { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancelar','cancelar_masivo')]]) }
  );
});

bot.action('cancelar_masivo', async ctx => {
  delete esperaMensajeMasivo[ctx.from.id];
  await ctx.answerCbQuery('Cancelado');
  return ctx.reply('❌ Cancelado.', { ...menuAdmin });
});

bot.on('text', async ctx => {
  if (!esAdmin(ctx)) return;
  if (!esperaMensajeMasivo[ctx.from.id]) return;

  delete esperaMensajeMasivo[ctx.from.id];
  const { getDrivers } = require('./domiciliarioBot');
  const drivers = getDrivers();
  const ids     = Object.keys(drivers);

  if (!ids.length) return ctx.reply('😴 No hay domiciliarios conectados para enviar mensaje.');

  let ok = 0;
  for (const did of ids) {
    try {
      await bot.telegram.sendMessage(did,
        `📣 *Mensaje del Administrador:*\n\n${ctx.message.text}`,
        { parse_mode:'Markdown' }
      );
      ok++;
    } catch(e) {}
  }

  return ctx.reply(`✅ Mensaje enviado a *${ok}* domiciliario(s).`, { parse_mode:'Markdown', ...menuAdmin });
});

// ── ❓ AYUDA ADMIN ────────────────────────────────────────────────────────────
bot.hears('❓ Ayuda Admin', ctx => {
  if (!esAdmin(ctx)) return;
  return ctx.reply(
    `👑 *PANEL ADMINISTRADOR WIL*\n\n` +
    `📊 *Resumen* — estadísticas del día\n` +
    `📋 *Pendientes* — pedidos sin atender\n` +
    `🚚 *En Proceso* — en camino\n` +
    `✅ *Finalizados* — entregas del día + total\n` +
    `🛵 *Domiciliarios* — quién está activo\n` +
    `⏰ *Recordatorio* — alertar pedidos tardíos\n` +
    `📣 *Masivo* — mensaje a todos los drivers\n\n` +
    `*Recordatorios automáticos:*\n` +
    `• Cada 10 min revisa pedidos sin atender\n` +
    `• Alerta si llevan más de 10 min sin driver`,
    { parse_mode:'Markdown' }
  );
});

// ── RECORDATORIO AUTOMÁTICO CADA 10 MINUTOS ───────────────────────────────────
function iniciarRecordatoriosAutomaticos() {
  cron.schedule('*/10 * * * *', async () => {
    console.log('🔔 Verificando pedidos sin atender...');
    try {
      await enviarRecordatorio(null);
    } catch(e) {
      console.error('cron error:', e.message);
    }
  }, { timezone: 'America/Bogota' });

  console.log('⏰ Recordatorios automáticos activados (cada 10 min)');
}

module.exports = { adminBot: bot, iniciarRecordatoriosAutomaticos };