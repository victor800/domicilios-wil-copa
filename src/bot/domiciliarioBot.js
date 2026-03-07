const { Telegraf, Markup } = require('telegraf');
const moment = require('moment-timezone');
const {
  asignarDomiciliario, marcarEntregado, getPedidos,
  contarPedidosPorEstado, actualizarTotalPedido,
  verificarClave, guardarTelegramDriver
} = require('../services/sheets');
const { calcularDistancia } = require('../services/distancia');
const { leerTotalFactura }  = require('../services/leerFactura');

const bot = new Telegraf(process.env.BOT_DRIVER_TOKEN);

const pool        = {};   // pedidos en memoria
const drivers     = {};   // domiciliarios autenticados
const esperaClave = {};
// espFactura[uid] = { pedidoId, chatId, msgId }
const espFactura  = {};

const SEDE_LAT = parseFloat(process.env.SEDE_LAT || '6.3538');
const SEDE_LNG = parseFloat(process.env.SEDE_LNG || '-75.4932');

const COP = n => {
  if (!n && n !== 0) return '$0';
  return '$' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
};

// ── Badge de tipo de pedido ────────────────────────────────────────────────────
function tipoBadge(p) {
  if (!p) return '';
  if (p.tipo === 'paqueteria') return '📦 Paquetería';
  if (p.tienda === 'EXPERTOS')  return '💊 Farmacia Expertos';
  if (p.tienda === 'CENTRAL')   return '🏥 Farmacia La Central';
  return '🏪 WIL';
}

// ── Contadores ─────────────────────────────────────────────────────────────────
async function getContadores() {
  try {
    const s = await contarPedidosPorEstado();
    return {
      pend: Math.max(s.pendientes, Object.values(pool).filter(p => p.estado === 'PENDIENTE').length),
      proc: Math.max(s.enProceso,  Object.values(pool).filter(p => p.estado === 'EN_PROCESO').length),
      fin:  s.finalizados
    };
  } catch(e) {
    return {
      pend: Object.values(pool).filter(p => p.estado === 'PENDIENTE').length,
      proc: Object.values(pool).filter(p => p.estado === 'EN_PROCESO').length,
      fin: 0
    };
  }
}

// ── Menú teclado ───────────────────────────────────────────────────────────────
async function getMenuKb(uid) {
  const { pend, proc, fin } = await getContadores();
  return Markup.keyboard([
    ['📋 Pendientes (' + pend + ')', '🚚 En Proceso (' + proc + ')'],
    ['✅ Finalizados (' + fin + ')',  drivers[uid]?.pedidoActual ? '📦 Mi Pedido ✅' : '📦 Mi Pedido'],
    ['✅ Entregar', '❓ Ayuda'],
    ['🚪 Cerrar Sesión']
  ]).resize();
}

// ── Card del pedido ────────────────────────────────────────────────────────────
function cardPedido(p, estado) {
  const ico   = estado === 'PENDIENTE' ? '🟡' : estado === 'EN_PROCESO' ? '🔵' : '🟢';
  const dom   = (p.precioDomicilio && p.precioDomicilio > 0) ? COP(p.precioDomicilio) : null;
  const total = (p.total !== null && p.total !== undefined && p.total !== '')
    ? COP(p.total) : '⏳ Pendiente';
  return (
    ico + ' <b>' + p.id + '</b>  <i>' + tipoBadge(p) + '</i>\n' +
    '👤 ' + (p.cliente || '?') + '   📱 ' + (p.telefono || '?') + '\n' +
    '📍 <b>' + (p.barrio || p.direccion || '?') + '</b>\n' +
    '📦 ' + (p.productos || '—') + '\n' +
    (dom ? '🛵 Domicilio: <b>' + dom + '</b>\n' : '') +
    '💵 <b>TOTAL: ' + total + '</b>'
  );
}

// ── URL Google Maps directo con coordenadas ────────────────────────────────────
async function buildGmapsUrl(lugar, pedido) {
  const origen = SEDE_LAT + ',' + SEDE_LNG;
  if (pedido?.coordenadas?.lat && pedido?.coordenadas?.lng) {
    return 'https://www.google.com/maps/dir/' + origen + '/' +
      pedido.coordenadas.lat + ',' + pedido.coordenadas.lng;
  }
  try {
    const r = await calcularDistancia(lugar);
    if (r.lat && r.lng) {
      return 'https://www.google.com/maps/dir/' + origen + '/' + r.lat + ',' + r.lng;
    }
  } catch(_) {}
  const destEnc = encodeURIComponent((lugar || '') + ', Copacabana, Antioquia, Colombia');
  return 'https://www.google.com/maps/dir/' + origen + '/' + destEnc;
}

// ── Botones inline para pedido EN_PROCESO ─────────────────────────────────────
// Ver Ruta es url button → abre Maps DIRECTO sin paso intermedio
async function botonesEnProceso(id, pedido) {
  const gmaps = await buildGmapsUrl(pedido?.barrio || pedido?.direccion || '', pedido);
  return Markup.inlineKeyboard([
    [Markup.button.url('🗺️ Ver Ruta', gmaps),
     Markup.button.callback('📷 Factura', 'factura_' + id)],
    [Markup.button.callback('✅ Entregar', 'entregar_' + id)]
  ]);
}

// ── Botones inline para pedido PENDIENTE ──────────────────────────────────────
async function botonesPendiente(id, pedido) {
  const gmaps = await buildGmapsUrl(pedido?.barrio || pedido?.direccion || '', pedido);
  return Markup.inlineKeyboard([
    [Markup.button.callback('🎯 Tomar', 'tomar_' + id),
     Markup.button.url('🗺️ Ver Ruta', gmaps)]
  ]);
}

// ── Guard autenticación ────────────────────────────────────────────────────────
function ok(ctx) {
  const uid = ctx.from?.id;
  if (!drivers[uid]) {
    esperaClave[uid] = true;
    ctx.reply('🔐 Escribe tu <b>clave de acceso</b>:', { parse_mode: 'HTML', ...Markup.removeKeyboard() });
    return false;
  }
  return true;
}

// ── Notificaciones al cliente ──────────────────────────────────────────────────
async function notificarClienteEnCamino(p, totalProductos, domicilio, totalFinal, fileId) {
  if (!p.clienteId) return;
  try {
    const msg =
      '🛵 <b>¡Tu pedido está en camino!</b>\n' +
      '━━━━━━━━━━━━━━━━━━\n' +
      '📦 <b>' + (p.productos || '—') + '</b>\n' +
      '━━━━━━━━━━━━━━━━━━\n' +
      '🛒 Productos:  <b>' + COP(totalProductos) + '</b>\n' +
      '🛵 Domicilio:  <b>' + COP(domicilio) + '</b>\n' +
      '━━━━━━━━━━━━━━━━━━\n' +
      '💵 <b>TOTAL A PAGAR: ' + COP(totalFinal) + '</b>\n' +
      '━━━━━━━━━━━━━━━━━━\n' +
      '🏍️ Domiciliario: <b>' + (p.domiciliario || '—') + '</b>';
    if (fileId) {
      await bot.telegram.sendPhoto(p.clienteId, fileId, { caption: msg, parse_mode: 'HTML' });
    } else {
      await bot.telegram.sendMessage(p.clienteId, msg, { parse_mode: 'HTML' });
    }
  } catch(e) { console.error('notificarClienteEnCamino:', e.message); }
}

async function notificarClienteEntregado(p, hora) {
  if (!p.clienteId) return;
  try {
    await bot.telegram.sendMessage(p.clienteId,
      '✅ <b>¡Pedido entregado!</b>\n' +
      '━━━━━━━━━━━━━━━━━━\n' +
      '🆔 ' + p.id + '\n' +
      '⏰ ' + (hora || '—') + '\n' +
      '💵 Total pagado: <b>' + COP(p.total) + '</b>\n\n' +
      '¡Gracias por tu compra! 🙌',
      { parse_mode: 'HTML' });
  } catch(e) {}
}

// ══════════════════════════════════════════════════════════════════════════════
// /start
// ══════════════════════════════════════════════════════════════════════════════
bot.start(async ctx => {
  const uid = ctx.from.id;
  if (drivers[uid]) {
    const kb = await getMenuKb(uid);
    return ctx.reply('🛵 Bienvenido de nuevo, <b>' + drivers[uid].nombre + '</b>!',
      { parse_mode: 'HTML', ...kb });
  }
  esperaClave[uid] = true;
  return ctx.reply(
    '🔐 <b>Panel Domiciliarios — WIL</b>\n📍 Copacabana, Antioquia\n\nEscribe tu <b>clave de acceso</b>:',
    { parse_mode: 'HTML', ...Markup.removeKeyboard() });
});

// ══════════════════════════════════════════════════════════════════════════════
// TEXTO
// ══════════════════════════════════════════════════════════════════════════════
bot.on('text', async ctx => {
  const uid = ctx.from.id;
  const txt = ctx.message.text.trim();
  if (txt.startsWith('/')) return;

  // Cerrar sesión: siempre funciona sin restricciones
  if (txt === '🚪 Cerrar Sesión') {
    delete drivers[uid];
    delete esperaClave[uid];
    return ctx.reply('👋 <b>Sesión cerrada.</b> Escribe /start para volver.',
      { parse_mode: 'HTML', ...Markup.removeKeyboard() });
  }

  if (esperaClave[uid]) {
    try { await ctx.deleteMessage(); } catch(_) {}
    const r = await verificarClave(txt);
    if (!r.valida)
      return ctx.reply('❌ <b>Clave incorrecta.</b>', { parse_mode: 'HTML' });
    delete esperaClave[uid];
    drivers[uid] = { nombre: r.nombre, pedidoActual: null };
    await guardarTelegramDriver(r.fila, uid);
    const kb = await getMenuKb(uid);
    return ctx.reply('🎉 <b>¡Bienvenido, ' + r.nombre + '!</b> 👋',
      { parse_mode: 'HTML', ...kb });
  }

  if (!drivers[uid]) {
    esperaClave[uid] = true;
    return ctx.reply('🔐 Escribe tu <b>clave de acceso</b>:',
      { parse_mode: 'HTML', ...Markup.removeKeyboard() });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// FOTO — procesa factura EDITANDO el mensaje donde se pidió
// No se crea ningún mensaje nuevo
// ══════════════════════════════════════════════════════════════════════════════
bot.on('photo', async ctx => {
  const uid = ctx.from.id;
  if (!drivers[uid] || !espFactura[uid]) return;

  const { pedidoId, chatId, msgId } = espFactura[uid];
  delete espFactura[uid];

  // Borra la foto enviada para mantener el chat limpio
  try { await ctx.deleteMessage(); } catch(_) {}

  const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;

  // Edita el mensaje a "leyendo..."
  try {
    await bot.telegram.editMessageText(chatId, msgId, null,
      '🔄 <b>Leyendo factura...</b>',
      { parse_mode: 'HTML' });
  } catch(_) {}

  const resultado  = await leerTotalFactura(fileId, process.env.BOT_DRIVER_TOKEN);
  const p          = pool[pedidoId];
  const domicilio  = p?.precioDomicilio || 0;

  if (!resultado.ok || !resultado.total) {
    // Error: edita el mismo mensaje, restablece la espera para reintento
    try {
      await bot.telegram.editMessageText(chatId, msgId, null,
        '❌ <b>No pude leer el total.</b>\n' +
        (resultado.error || 'Foto no clara. Envía de nuevo:'),
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Volver al pedido', 'verpedido_' + pedidoId)]
        ])});
    } catch(_) {}
    espFactura[uid] = { pedidoId, chatId, msgId };
    return;
  }

  const totalProductos = resultado.total;
  const totalFinal     = totalProductos + domicilio;

  if (p) {
    p.totalProductos = totalProductos;
    p.total          = totalFinal;
    p.domiciliario   = drivers[uid].nombre;
    p.facturaFileId  = fileId;
  }

  await actualizarTotalPedido(pedidoId, totalFinal);
  await notificarClienteEnCamino(
    p || { id: pedidoId, clienteId: null, domiciliario: drivers[uid].nombre },
    totalProductos, domicilio, totalFinal, fileId
  );

  const gmaps = await buildGmapsUrl(p?.barrio || p?.direccion || '', p);

  // Edita el mensaje con el resultado — limpio, sin mensajes nuevos
  try {
    await bot.telegram.editMessageText(chatId, msgId, null,
      '✅ <b>Factura procesada</b>\n' +
      '━━━━━━━━━━━━━━\n' +
      cardPedido(p || { id: pedidoId, productos: '—' }, 'EN_PROCESO') + '\n' +
      '━━━━━━━━━━━━━━\n' +
      '🛒 Productos:  <b>' + COP(totalProductos) + '</b>\n' +
      '🛵 Domicilio:  <b>' + COP(domicilio) + '</b>\n' +
      '💵 <b>TOTAL: ' + COP(totalFinal) + '</b>\n' +
      '📲 <i>Cliente notificado.</i>',
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([
        [Markup.button.url('🗺️ Ver Ruta', gmaps),
         Markup.button.callback('✅ Entregar', 'entregar_' + pedidoId)]
      ])});
  } catch(e) {
    console.error('edit factura result:', e.message);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 📋 PENDIENTES
// ══════════════════════════════════════════════════════════════════════════════
bot.hears(/^📋 Pendientes/, async ctx => {
  if (!ok(ctx)) return;
  await mostrarPendientes(ctx);
});

async function mostrarPendientes(ctx) {
  const enMem    = Object.values(pool).filter(p => p.estado === 'PENDIENTE');
  const enSheets = await getPedidos('PENDIENTE').catch(() => []);
  const ids      = new Set(enMem.map(p => p.id));
  const merged   = [
    ...enMem,
    ...enSheets.filter(p => !ids.has(p.id)).map(p => ({
      id: p.id, tienda: p.tienda || null, tipo: p.tipo || null,
      cliente: p.cliente, telefono: p.telefono,
      direccion: p.direccion, barrio: p.barrio || p.direccion,
      productos: p.productos, total: null,
      precioDomicilio: p.precioDomicilio || 0, estado: 'PENDIENTE', clienteId: null
    }))
  ];
  if (!merged.length) return ctx.reply('😴 No hay pedidos pendientes.');
  for (const p of merged) {
    const bts = await botonesPendiente(p.id, p);
    await ctx.reply(cardPedido(p, 'PENDIENTE'), { parse_mode: 'HTML', ...bts });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 🚚 EN PROCESO — solo 2 botones: Ver Ruta (url directo) + Entregar
// ══════════════════════════════════════════════════════════════════════════════
bot.hears(/^🚚 En Proceso/, async ctx => {
  if (!ok(ctx)) return;
  const enMem    = Object.values(pool).filter(p => p.estado === 'EN_PROCESO');
  const enSheets = await getPedidos('EN_PROCESO').catch(() => []);
  const ids      = new Set(enMem.map(p => p.id));
  const merged   = [
    ...enMem,
    ...enSheets.filter(p => !ids.has(p.id)).map(p => ({
      id: p.id, tienda: p.tienda || null, tipo: p.tipo || null,
      cliente: p.cliente, telefono: p.telefono,
      direccion: p.direccion, barrio: p.barrio || p.direccion,
      productos: p.productos, total: p.total,
      precioDomicilio: p.precioDomicilio || 0,
      domiciliario: p.domiciliario, horaTomo: p.horaTomo,
      estado: 'EN_PROCESO', clienteId: null
    }))
  ];
  if (!merged.length) return ctx.reply('📭 No hay pedidos en proceso.');
  for (const p of merged) {
    const gmaps = await buildGmapsUrl(p.barrio || p.direccion || '', p);
    await ctx.reply(
      cardPedido(p, 'EN_PROCESO') + '\n🛵 ' + (p.domiciliario || '?') + ' — ⏰ ' + (p.horaTomo || '?'),
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([
        [Markup.button.url('🗺️ Ver Ruta', gmaps),
         Markup.button.callback('✅ Entregar', 'entregar_' + p.id)]
      ])});
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ✅ FINALIZADOS
// ══════════════════════════════════════════════════════════════════════════════
bot.hears(/^✅ Finalizados/, async ctx => {
  if (!ok(ctx)) return;
  const hoy = moment().tz('America/Bogota').format('DD/MM/YYYY');
  const ps  = (await getPedidos('FINALIZADO').catch(() => [])).filter(p => p.fecha === hoy);
  if (!ps.length) return ctx.reply('📭 Sin finalizados hoy (' + hoy + ').');
  let msg = '✅ <b>' + ps.length + '</b> entrega(s) hoy ' + hoy + ':\n\n';
  ps.forEach((p, i) => {
    msg += (i+1) + '. 🆔 <b>' + p.id + '</b>  <i>' + tipoBadge(p) + '</i>\n';
    msg += '   📍 ' + (p.barrio || p.direccion) + '\n';
    msg += '   🛵 ' + (p.domiciliario || '?') + ' — ⏰ ' + (p.horaEntrego || '?') + '\n';
    msg += '   💵 ' + COP(p.total) + '\n\n';
  });
  return ctx.reply(msg, { parse_mode: 'HTML' });
});

// ══════════════════════════════════════════════════════════════════════════════
// 📦 MI PEDIDO
// ══════════════════════════════════════════════════════════════════════════════
bot.hears(/^📦 Mi Pedido/, async ctx => {
  if (!ok(ctx)) return;
  const uid = ctx.from.id;
  const d   = drivers[uid];
  if (!d.pedidoActual) return ctx.reply('📭 No tienes pedido activo.');
  const p = pool[d.pedidoActual];
  if (!p) return ctx.reply('❌ Usa 🚚 En Proceso para verlo.');
  const bts = await botonesEnProceso(p.id, p);
  return ctx.reply(
    '📦 <b>TU PEDIDO ACTIVO</b>\n━━━━━━━━━━━━━━━━━━\n' + cardPedido(p, 'EN_PROCESO'),
    { parse_mode: 'HTML', ...bts });
});

// ══════════════════════════════════════════════════════════════════════════════
// 🎯 TOMAR — edita el card del pendiente, no crea mensaje nuevo
// ══════════════════════════════════════════════════════════════════════════════
bot.action(/^tomar_(.+)$/, async ctx => {
  const id  = ctx.match[1];
  const uid = ctx.from.id;
  await ctx.answerCbQuery();

  const d = drivers[uid];
  if (!d) return;
  if (d.pedidoActual) {
    await ctx.answerCbQuery('⚠️ Ya tienes un pedido activo. Entrégalo primero.', true);
    return;
  }
  if (pool[id] && pool[id].estado !== 'PENDIENTE') {
    await ctx.answerCbQuery('⚠️ Ya fue tomado por otro.', true);
    return;
  }

  if (!pool[id]) {
    const lista = await getPedidos('PENDIENTE').catch(() => []);
    const found = lista.find(x => x.id === id);
    if (!found) {
      await ctx.answerCbQuery('⚠️ Pedido no encontrado.', true);
      return;
    }
    pool[id] = {
      id: found.id, tienda: found.tienda || null, tipo: found.tipo || null,
      cliente: found.cliente, telefono: found.telefono,
      clienteId: found.clienteId || null,
      direccion: found.direccion, barrio: found.barrio || found.direccion,
      productos: found.productos, total: null,
      precioDomicilio: found.precioDomicilio || 0, estado: 'PENDIENTE'
    };
  }

  pool[id].estado       = 'EN_PROCESO';
  pool[id].domiciliario = d.nombre;
  d.pedidoActual        = id;

  const hora = await asignarDomiciliario(id, d.nombre);
  const p    = pool[id];
  const bts  = await botonesEnProceso(id, p);

  // Edita el card — sin crear mensaje nuevo
  try {
    await ctx.editMessageText(
      '🔵 <b>Tomado · ' + (hora || moment().tz('America/Bogota').format('hh:mm A')) + '</b>\n' +
      '━━━━━━━━━━━━━━━━━━\n' +
      cardPedido(p, 'EN_PROCESO'),
      { parse_mode: 'HTML', ...bts });
  } catch(e) {
    console.error('edit tomar:', e.message);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 📷 FACTURA — edita el mensaje actual para recibir foto (no crea uno nuevo)
// ══════════════════════════════════════════════════════════════════════════════
bot.action(/^factura_(.+)$/, async ctx => {
  const id     = ctx.match[1];
  const uid    = ctx.from.id;
  const chatId = ctx.callbackQuery.message.chat.id;
  const msgId  = ctx.callbackQuery.message.message_id;
  await ctx.answerCbQuery();
  if (!drivers[uid]) return;

  const p   = pool[id];
  const dom = p?.precioDomicilio > 0 ? COP(p.precioDomicilio) : '$0';

  // Registra que estamos esperando la foto para ESTE mensaje
  espFactura[uid] = { pedidoId: id, chatId, msgId };

  // Edita el mismo mensaje — no crea ninguno nuevo
  try {
    await ctx.editMessageText(
      '📷 <b>Envía la foto de la factura</b>\n' +
      '━━━━━━━━━━━━━━\n' +
      '📦 <b>' + id + '</b>   ' + tipoBadge(p) + '\n' +
      '📍 ' + (p?.barrio || p?.direccion || '—') + '\n' +
      '🛵 Domicilio: <b>' + dom + '</b>',
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Volver', 'verpedido_' + id)]
      ])});
  } catch(e) {
    console.error('edit factura prompt:', e.message);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 🔙 VER PEDIDO — edita el mensaje actual (botón volver)
// ══════════════════════════════════════════════════════════════════════════════
bot.action(/^verpedido_(.+)$/, async ctx => {
  const id  = ctx.match[1];
  const uid = ctx.from.id;
  await ctx.answerCbQuery();

  // Si había espera de factura, cancelarla
  if (espFactura[uid]?.pedidoId === id) {
    delete espFactura[uid];
  }

  let p = pool[id];
  if (!p) {
    const lista = await getPedidos('ALL').catch(() => []);
    const f = lista.find(x => x.id === id);
    if (f) p = { ...f, barrio: f.barrio || f.direccion };
  }
  if (!p) return;

  const esMio = drivers[uid]?.pedidoActual === id;
  const bts   = esMio
    ? await botonesEnProceso(id, p)
    : await botonesPendiente(id, p);

  try {
    await ctx.editMessageText(
      cardPedido(p, p.estado || 'EN_PROCESO'),
      { parse_mode: 'HTML', ...bts });
  } catch(e) {
    console.error('edit verpedido:', e.message);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ✅ ENTREGAR — inline
// ══════════════════════════════════════════════════════════════════════════════
bot.action(/^entregar_(.+)$/, async ctx => {
  const id  = ctx.match[1];
  const uid = ctx.from.id;
  await ctx.answerCbQuery();
  if (!drivers[uid] || drivers[uid].pedidoActual !== id) {
    await ctx.answerCbQuery('⚠️ No puedes entregar este pedido.', true);
    return;
  }
  await _entregar(ctx, uid, id);
});

// ✅ ENTREGAR — teclado
bot.hears('✅ Entregar', async ctx => {
  if (!ok(ctx)) return;
  const d = drivers[ctx.from.id];
  if (!d.pedidoActual) return ctx.reply('❌ No tienes pedido activo.');
  await _entregar(ctx, ctx.from.id, d.pedidoActual);
});

async function _entregar(ctx, uid, id) {
  const hora = await marcarEntregado(id);
  const p    = pool[id];
  if (p) p.estado = 'FINALIZADO';
  drivers[uid].pedidoActual = null;
  if (p) await notificarClienteEntregado(p, hora);

  const resumen =
    '🟢 <b>ENTREGADO · ' + (hora || '—') + '</b>\n' +
    '━━━━━━━━━━━━━━━━━━\n' +
    (p ? cardPedido(p, 'FINALIZADO') + '\n━━━━━━━━━━━━━━━━━━\n' : '🆔 ' + id + '\n') +
    '🛵 Domiciliario: <b>' + (drivers[uid]?.nombre || '—') + '</b>';

  // Edita el mensaje del pedido con el resumen final — sin mensaje nuevo
  try {
    await ctx.editMessageText(resumen,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
  } catch(_) {}

  const kb       = await getMenuKb(uid);
  const { pend } = await getContadores();
  return ctx.reply(
    '¡Buen trabajo! 💪' +
    (pend > 0 ? '   🔴 <b>' + pend + '</b> pendiente(s)' : '   ✅ Sin más pendientes'),
    { parse_mode: 'HTML', ...kb });
}

// ══════════════════════════════════════════════════════════════════════════════
// ❓ AYUDA
// ══════════════════════════════════════════════════════════════════════════════
bot.hears('❓ Ayuda', ctx => {
  if (!ok(ctx)) return;
  return ctx.reply(
    'ℹ️ <b>PANEL DOMICILIARIOS WIL</b>\n\n' +
    '• 🎯 <b>Tomar</b> → se asigna el pedido, aparecen botones de acción\n' +
    '• 🗺️ <b>Ver Ruta</b> → abre Google Maps directo con coordenadas\n' +
    '• 📷 <b>Factura</b> → el mismo chat pide la foto; la IA lee el total\n' +
    '• ✅ <b>Entregar</b> → marca entregado y notifica al cliente\n' +
    '• 🔙 <b>Volver</b> → regresa al card sin mensajes extra',
    { parse_mode: 'HTML' });
});

// ══════════════════════════════════════════════════════════════════════════════
// API pública — wilBot llama esto al crear un pedido
// ══════════════════════════════════════════════════════════════════════════════
function agregarPedido(pedido) {
  pool[pedido.id] = { ...pedido, estado: 'PENDIENTE', total: null };
  const p = pool[pedido.id];
  for (const [did, d] of Object.entries(drivers)) {
    if (!d.pedidoActual) {
      buildGmapsUrl(pedido.barrio || pedido.direccion || '', pedido).then(gmaps => {
        bot.telegram.sendMessage(did,
          '🔴 <b>Nuevo pedido</b>\n━━━━━━━━━━━━━━\n' + cardPedido(p, 'PENDIENTE'),
          { parse_mode: 'HTML', ...Markup.inlineKeyboard([
            [Markup.button.callback('🎯 Tomar', 'tomar_' + pedido.id),
             Markup.button.url('🗺️ Ver Ruta', gmaps)]
          ])}).catch(() => {});
      });
    }
  }
}

function getPool()    { return pool; }
function getDrivers() { return drivers; }

module.exports = { domiciliarioBot: bot, agregarPedido, getPool, getDrivers };