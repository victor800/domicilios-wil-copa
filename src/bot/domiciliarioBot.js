
const { Telegraf, Markup } = require('telegraf');
const moment = require('moment-timezone');
const {
  asignarDomiciliario, marcarEntregado, getPedidos,
  contarPedidosPorEstado, verificarClave, guardarTelegramDriver, fmt
} = require('../services/sheets');
const { calcularDistancia } = require('../services/distancia');

const bot = new Telegraf(process.env.BOT_DRIVER_TOKEN);

// ─── Estado global ─────────────────────────────────────────────────────────
const pool        = {};   // pedidos activos en memoria
const drivers     = {};   // domiciliarios autenticados
const esperaClave = {};   // uid esperando clave

// Coordenadas sede WIL — ajusta a tu dirección real
const SEDE_LAT = parseFloat(process.env.SEDE_LAT || '6.3538');
const SEDE_LNG = parseFloat(process.env.SEDE_LNG || '-75.4932');

const COP = n => (!n && n !== 0) ? '$—' : '$' + Math.round(n).toLocaleString('es-CO');

// ─────────────────────────────────────────────────────────────────────────────
// CONTADORES — siempre desde Sheets + pool como respaldo
// ─────────────────────────────────────────────────────────────────────────────
async function getContadores() {
  try {
    const s = await contarPedidosPorEstado();
    const memPend = Object.values(pool).filter(p => p.estado === 'PENDIENTE').length;
    const memProc = Object.values(pool).filter(p => p.estado === 'EN_PROCESO').length;
    return {
      pend: Math.max(s.pendientes, memPend),
      proc: Math.max(s.enProceso,  memProc),
      fin:  s.finalizados
    };
  } catch(e) {
    console.error('⚠️ getContadores cayó a fallback:', e.message);
    return {
      pend: Object.values(pool).filter(p => p.estado === 'PENDIENTE').length,
      proc: Object.values(pool).filter(p => p.estado === 'EN_PROCESO').length,
      fin:  0
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MENÚ DINÁMICO con contadores reales en los botones
// ─────────────────────────────────────────────────────────────────────────────
async function getMenuKb(uid) {
  const { pend, proc, fin } = await getContadores();
  const miPed = drivers[uid]?.pedidoActual ? '📦 Mi Pedido ✅' : '📦 Mi Pedido';
  return Markup.keyboard([
    [`📋 Pendientes (${pend})`,  `🚚 En Proceso (${proc})`],
    [`✅ Finalizados (${fin})`,   miPed],
    [`✅ Entregar`,               `❓ Ayuda`],
    [`🚪 Cerrar Sesión`]
  ]).resize();
}

// ─────────────────────────────────────────────────────────────────────────────
// CARD PEDIDO — vista domiciliario
// ─────────────────────────────────────────────────────────────────────────────
function cardPedido(p, estado) {
  const ico   = estado === 'PENDIENTE' ? '🟡' : estado === 'EN_PROCESO' ? '🔵' : '🟢';
  const total = (p.total !== undefined && p.total !== null && p.total !== '') ? COP(p.total) : '—';
  const dom   = (p.precioDomicilio && p.precioDomicilio > 0) ? COP(p.precioDomicilio) : null;
  return (
    `${ico} <b>${p.id}</b>\n` +
    `🏪 ${p.negocioNombre || p.negocio || '—'}\n` +
    `👤 ${p.cliente}   📱 ${p.telefono}\n` +
    `📍 <b>${p.barrio || p.direccion}</b>\n` +
    `📦 ${p.productos || '—'}\n` +
    (p.presupuesto ? `💰 Presupuesto: <b>${p.presupuesto}</b>\n` : '') +
    (dom ? `🛵 Domicilio: <b>${dom}</b>\n` : '') +
    `💵 <b>TOTAL: ${total}</b>`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GUARD — verifica que el usuario esté autenticado
// ─────────────────────────────────────────────────────────────────────────────
function ok(ctx) {
  const uid = ctx.from?.id || ctx.callbackQuery?.from?.id;
  if (!drivers[uid]) {
    esperaClave[uid] = true;
    ctx.reply(
      `🔐 Debes autenticarte primero.\nEscribe tu <b>clave de acceso</b>:`,
      { parse_mode: 'HTML', ...Markup.removeKeyboard() }
    );
    return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// /start
// ─────────────────────────────────────────────────────────────────────────────
bot.start(async ctx => {
  const uid = ctx.from.id;
  if (drivers[uid]) {
    const kb = await getMenuKb(uid);
    await ctx.reply(
      `🛵 Bienvenido de nuevo, <b>${drivers[uid].nombre}</b>!`,
      { parse_mode: 'HTML', ...kb }
    );
    const { pend } = await getContadores();
    if (pend > 0) {
      return ctx.reply(
        `🔴 Hay <b>${pend}</b> pedido(s) esperando`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[
          Markup.button.callback(`📋 Ver pendientes (${pend})`, 'ir_pendientes')
        ]])}
      );
    }
    return;
  }
  esperaClave[uid] = true;
  return ctx.reply(
    `🔐 <b>Panel Domiciliarios — WIL</b>\n` +
    `📍 Copacabana, Antioquia\n\nEscribe tu <b>clave de acceso</b>:`,
    { parse_mode: 'HTML', ...Markup.removeKeyboard() }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// TEXTO — maneja clave, cierre de sesión y teclado
// ─────────────────────────────────────────────────────────────────────────────
bot.on('text', async ctx => {
  const uid = ctx.from.id;
  const txt = ctx.message.text.trim();
  if (txt.startsWith('/')) return;

  // ── Cerrar sesión ──────────────────────────────────────────────────────────
  if (txt === '🚪 Cerrar Sesión') {
    if (drivers[uid]) {
      if (drivers[uid].pedidoActual) {
        return ctx.reply('⚠️ Tienes un pedido activo. Entrégalo antes de cerrar sesión.');
      }
      delete drivers[uid];
    }
    delete esperaClave[uid];
    return ctx.reply(
      `👋 <b>Sesión cerrada.</b> Hasta pronto!\n\nEscribe /start para volver a ingresar.`,
      { parse_mode: 'HTML', ...Markup.removeKeyboard() }
    );
  }

  // ── Verificar clave ────────────────────────────────────────────────────────
  if (esperaClave[uid]) {
    const r = await verificarClave(txt);
    if (!r.valida) {
      return ctx.reply(
        `❌ <b>Clave incorrecta.</b>\nSolicita una nueva al administrador.`,
        { parse_mode: 'HTML' }
      );
    }
    delete esperaClave[uid];
    drivers[uid] = { nombre: r.nombre, pedidoActual: null };
    await guardarTelegramDriver(r.fila, uid);
    const kb = await getMenuKb(uid);
    await ctx.reply(
      `🎉 <b>¡Acceso concedido!</b>\nHola <b>${r.nombre}</b> 👋`,
      { parse_mode: 'HTML', ...kb }
    );
    const { pend } = await getContadores();
    if (pend > 0) {
      return ctx.reply(
        `🔴 Hay <b>${pend}</b> pedido(s) esperando`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[
          Markup.button.callback(`📋 Ver pendientes (${pend})`, 'ir_pendientes')
        ]])}
      );
    }
    return;
  }

  // Si no está autenticado y no está esperando clave, pedirle que se autentique
  if (!drivers[uid]) {
    esperaClave[uid] = true;
    return ctx.reply(
      `🔐 Escribe tu <b>clave de acceso</b>:`,
      { parse_mode: 'HTML', ...Markup.removeKeyboard() }
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 📋 PENDIENTES
// Combina pool en memoria + Sheets para no perder pedidos al reiniciar
// ─────────────────────────────────────────────────────────────────────────────
bot.hears(/^📋 Pendientes/, async ctx => {
  if (!ok(ctx)) return;
  await mostrarPendientes(ctx);
});

async function mostrarPendientes(ctx) {
  const enMem      = Object.values(pool).filter(p => p.estado === 'PENDIENTE');
  const enSheets   = await getPedidos('PENDIENTE').catch(() => []);
  const idsMemoria = new Set(enMem.map(p => p.id));
  const soloSheets = enSheets
    .filter(p => !idsMemoria.has(p.id))
    .map(p => ({
      id:              p.id,
      negocioNombre:   p.negocio,
      cliente:         p.cliente,
      telefono:        p.telefono,
      direccion:       p.direccion,
      barrio:          p.barrio || p.direccion,
      productos:       p.productos,
      total:           p.total,
      precioDomicilio: 0,
      estado:          'PENDIENTE'
    }));

  const todos = [...enMem, ...soloSheets];
  if (!todos.length) return ctx.reply('😴 No hay pedidos pendientes ahora.');

  await ctx.reply(`🔴 <b>${todos.length}</b> pedido(s) disponible(s):`, { parse_mode: 'HTML' });

  for (const p of todos) {
    await ctx.reply(
      cardPedido(p, 'PENDIENTE'),
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([
        [
          Markup.button.callback('🎯 Tomar',     `tomar_${p.id}`),
          Markup.button.callback('🗺️ Ver Ruta',  `dist_${p.id}`)
        ],
        [Markup.button.callback('🔙 Volver al panel', 'volver_panel')]
      ])}
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 🚚 EN PROCESO
// ─────────────────────────────────────────────────────────────────────────────
bot.hears(/^🚚 En Proceso/, async ctx => {
  if (!ok(ctx)) return;
  const enMem      = Object.values(pool).filter(p => p.estado === 'EN_PROCESO');
  const enSheets   = await getPedidos('EN_PROCESO').catch(() => []);
  const idsMemoria = new Set(enMem.map(p => p.id));
  const soloSheets = enSheets
    .filter(p => !idsMemoria.has(p.id))
    .map(p => ({
      id:              p.id,
      negocioNombre:   p.negocio,
      cliente:         p.cliente,
      telefono:        p.telefono,
      direccion:       p.direccion,
      barrio:          p.barrio || p.direccion,
      productos:       p.productos,
      total:           p.total,
      precioDomicilio: 0,
      domiciliario:    p.domiciliario,
      horaTomo:        p.horaTomo,
      estado:          'EN_PROCESO'
    }));

  const todos = [...enMem, ...soloSheets];
  if (!todos.length) return ctx.reply('📭 No hay pedidos en proceso ahora.');

  await ctx.reply(`🚚 <b>${todos.length}</b> pedido(s) en proceso:`, { parse_mode: 'HTML' });

  for (const p of todos) {
    const esMiPedido = drivers[ctx.from.id]?.pedidoActual === p.id;
    await ctx.reply(
      cardPedido(p, 'EN_PROCESO') + `\n🛵 ${p.domiciliario || '?'} — ⏰ ${p.horaTomo || '?'}`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([
        [
          Markup.button.callback('🗺️ Ver Ruta', `dist_${p.id}`),
          ...(esMiPedido ? [Markup.button.callback('✅ Entregar', `entregar_${p.id}`)] : [])
        ],
        [Markup.button.callback('🔙 Volver al panel', 'volver_panel')]
      ])}
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ✅ FINALIZADOS
// ─────────────────────────────────────────────────────────────────────────────
bot.hears(/^✅ Finalizados/, async ctx => {
  if (!ok(ctx)) return;
  const hoy = moment().tz('America/Bogota').format('DD/MM/YYYY');
  const ps  = (await getPedidos('FINALIZADO').catch(() => [])).filter(p => p.fecha === hoy);
  if (!ps.length) return ctx.reply(`📭 Sin finalizados hoy (${hoy}).`);
  let msg = `✅ <b>${ps.length}</b> entrega(s) hoy ${hoy}:\n\n`;
  ps.forEach((p, i) => {
    msg += `${i+1}. 🆔 <b>${p.id}</b>\n`;
    msg += `   📍 ${p.direccion}\n`;
    msg += `   🛵 ${p.domiciliario || '?'} — ⏰ ${p.horaEntrego || '?'}\n`;
    msg += `   💵 ${COP(p.total)}\n\n`;
  });
  return ctx.reply(msg, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Volver al panel', 'volver_panel')]])
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 📦 MI PEDIDO
// ─────────────────────────────────────────────────────────────────────────────
bot.hears(/^📦 Mi Pedido/, ctx => {
  if (!ok(ctx)) return;
  const d = drivers[ctx.from.id];
  if (!d.pedidoActual) return ctx.reply('📭 No tienes pedido activo ahora.');
  const p = pool[d.pedidoActual];
  if (!p) return ctx.reply(
    '❌ No encontré datos del pedido en memoria.\nUsa 🚚 <b>En Proceso</b> para verlo.',
    { parse_mode: 'HTML' }
  );
  return ctx.reply(
    `📦 <b>TU PEDIDO ACTIVO</b>\n━━━━━━━━━━━━━━━━━━\n` + cardPedido(p, 'EN_PROCESO'),
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([
      [Markup.button.callback('🗺️ Ver Ruta',         `dist_${p.id}`)],
      [Markup.button.callback('✅ Marcar entregado',  `entregar_${p.id}`)],
      [Markup.button.callback('🔙 Volver al panel',   'volver_panel')]
    ])}
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 🎯 TOMAR PEDIDO
// ─────────────────────────────────────────────────────────────────────────────
bot.action(/^tomar_(.+)$/, async ctx => {
  const id  = ctx.match[1];
  const uid = ctx.from.id;
  const d   = drivers[uid];
  await ctx.answerCbQuery();

  if (!d) return ctx.reply('❌ Autentícate primero. /start');
  if (d.pedidoActual) return ctx.reply('⚠️ Ya tienes un pedido activo. Entrégalo primero.');
  if (pool[id] && pool[id].estado !== 'PENDIENTE') {
    return ctx.reply('⚠️ Ese pedido ya fue tomado por otro domiciliario.');
  }

  // Si no está en pool, cargarlo desde Sheets
  if (!pool[id]) {
    const fromSheets = await getPedidos('PENDIENTE').catch(() => []);
    const found = fromSheets.find(x => x.id === id);
    if (!found) return ctx.reply('⚠️ No encontré ese pedido. Puede que ya haya sido tomado.');
    pool[id] = {
      id:              found.id,
      negocioNombre:   found.negocio,
      cliente:         found.cliente,
      telefono:        found.telefono,
      clienteId:       null,
      direccion:       found.direccion,
      barrio:          found.barrio || found.direccion,
      productos:       found.productos,
      total:           found.total,
      precioDomicilio: 0,
      estado:          'PENDIENTE'
    };
  }

  pool[id].estado = 'EN_PROCESO';
  d.pedidoActual  = id;

  const hora = await asignarDomiciliario(id, d.nombre);
  const p    = pool[id];

  await ctx.editMessageText(
    `✅ <b>¡Pedido tomado a las ${hora || '—'}!</b>\n━━━━━━━━━━━━━━━━━━\n` +
    cardPedido({ ...p, domiciliario: d.nombre }, 'EN_PROCESO') +
    `\n\n<i>Cuando lo entregues presiona ✅ Entregar</i>`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([
      [
        Markup.button.callback('🗺️ Ver Ruta',  `dist_${id}`),
        Markup.button.callback('✅ Entregar',   `entregar_${id}`)
      ],
      [Markup.button.callback('🔙 Volver al panel', 'volver_panel')]
    ])}
  );

  // Enviar menú actualizado con contadores frescos
  try {
    const kb = await getMenuKb(uid);
    await bot.telegram.sendMessage(
      uid,
      `🛵 <b>${id}</b> asignado a ti. ¡Mucho éxito!`,
      { parse_mode: 'HTML', ...kb }
    );
  } catch(e) {}
});

// ─────────────────────────────────────────────────────────────────────────────
// 🗺️ VER RUTA — Google Maps y Waze con ruta completa desde sede
// ─────────────────────────────────────────────────────────────────────────────
bot.action(/^dist_(.+)$/, async ctx => {
  const id = ctx.match[1];
  await ctx.answerCbQuery('🗺️ Cargando ruta...');

  // Buscar dirección en pool o en Sheets
  let lugar = pool[id]?.barrio || pool[id]?.direccion;
  if (!lugar) {
    const todos = await getPedidos('ALL').catch(() => []);
    lugar = todos.find(p => p.id === id)?.direccion || '';
  }
  if (!lugar) return ctx.reply('❌ No encontré la dirección del pedido.');

  await ctx.reply(`⏳ Calculando ruta a <b>${lugar}</b>...`, { parse_mode: 'HTML' });

  const r = await calcularDistancia(lugar);

  // ── URLs de navegación ────────────────────────────────────────────────────
  const destStr   = `${lugar}, Copacabana, Antioquia, Colombia`;
  const destEnc   = encodeURIComponent(destStr);
  const origenStr = `${SEDE_LAT},${SEDE_LNG}`;

  // Google Maps — ruta de origen a destino
  const gmapsLink = `https://www.google.com/maps/dir/${origenStr}/${destEnc}`;

  // Waze — from=lat,lng establece el punto de partida explícito
  // navigate=yes activa la navegación automáticamente al abrir
  const wazeLink  = `https://waze.com/ul?q=${destEnc}&from=${origenStr}&navigate=yes`;

  const botonesNav = Markup.inlineKeyboard([
    [Markup.button.url('🗺️ Google Maps (ruta completa)', gmapsLink)],
    [Markup.button.url('🚗 Waze (navegar desde sede)',    wazeLink)],
    [Markup.button.callback('🔙 Volver al pedido',        `verpedido_${id}`)]
  ]);

  if (r.error || r.parcial) {
    return ctx.reply(
      `🗺️ <b>RUTA AL CLIENTE</b>\n━━━━━━━━━━━━━━━━━━\n` +
      `📍 Destino: <b>${r.barrio || lugar}</b>\n` +
      (r.tarifa ? `💰 Tarifa: <b>${COP(r.tarifa)}</b>\n` : '') +
      `\n📲 Abre la navegación:`,
      { parse_mode: 'HTML', ...botonesNav }
    );
  }

  return ctx.reply(
    `🗺️ <b>RUTA AL CLIENTE</b>\n━━━━━━━━━━━━━━━━━━\n` +
    `🏁 Origen: Sede WIL\n` +
    `📍 Destino: <b>${r.barrio || lugar}</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `📏 Distancia: <b>${r.distancia}</b>\n` +
    `🛵 En moto:   <b>${r.moto}</b>\n` +
    `🚗 En carro:  ${r.carro}\n` +
    (r.tarifa ? `💰 Tarifa: <b>${COP(r.tarifa)}</b>\n` : '') +
    `━━━━━━━━━━━━━━━━━━\n📲 Abre la navegación:`,
    { parse_mode: 'HTML', ...botonesNav }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// VOLVER AL PEDIDO desde vista de ruta
// ─────────────────────────────────────────────────────────────────────────────
bot.action(/^verpedido_(.+)$/, async ctx => {
  const id  = ctx.match[1];
  const uid = ctx.from.id;
  await ctx.answerCbQuery();

  let p = pool[id];
  if (!p) {
    const todos = await getPedidos('ALL').catch(() => []);
    const found = todos.find(x => x.id === id);
    if (found) p = { ...found, barrio: found.barrio || found.direccion };
  }
  if (!p) return ctx.reply('❌ No encontré el pedido.');

  const esMiPedido = drivers[uid]?.pedidoActual === id;
  const estado     = (p.estado || 'EN_PROCESO').toUpperCase();

  return ctx.reply(
    `📦 <b>PEDIDO ${id}</b>\n━━━━━━━━━━━━━━━━━━\n` + cardPedido(p, estado),
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([
      [Markup.button.callback('🗺️ Ver Ruta', `dist_${id}`)],
      ...(esMiPedido ? [[Markup.button.callback('✅ Marcar entregado', `entregar_${id}`)]] : []),
      [Markup.button.callback('🔙 Volver al panel', 'volver_panel')]
    ])}
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// ✅ ENTREGAR — botón inline
// ─────────────────────────────────────────────────────────────────────────────
bot.action(/^entregar_(.+)$/, async ctx => {
  const id  = ctx.match[1];
  const uid = ctx.from.id;
  await ctx.answerCbQuery();
  if (!drivers[uid] || drivers[uid].pedidoActual !== id) {
    return ctx.reply('⚠️ No puedes entregar ese pedido.');
  }
  await _entregar(ctx, uid, id);
});

// ─────────────────────────────────────────────────────────────────────────────
// ✅ ENTREGAR — botón teclado
// ─────────────────────────────────────────────────────────────────────────────
bot.hears('✅ Entregar', async ctx => {
  if (!ok(ctx)) return;
  const d = drivers[ctx.from.id];
  if (!d.pedidoActual) return ctx.reply('❌ No tienes pedido activo.');
  await _entregar(ctx, ctx.from.id, d.pedidoActual);
});

async function _entregar(ctx, uid, id) {
  const hora = await marcarEntregado(id);
  if (pool[id]) pool[id].estado = 'FINALIZADO';
  drivers[uid].pedidoActual = null;

  const kb       = await getMenuKb(uid);
  const { pend } = await getContadores();
  const nombre   = drivers[uid]?.nombre || '—';

  return ctx.reply(
    `🎉 <b>¡ENTREGADO!</b>\n🆔 ${id}\n⏰ ${hora || '—'}\n\n` +
    `¡Buen trabajo, ${nombre}! 💪\n` +
    (pend > 0
      ? `\n🔴 Aún hay <b>${pend}</b> pedido(s) pendiente(s)`
      : '\n✅ Sin más pedidos pendientes'),
    { parse_mode: 'HTML', ...kb }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// VOLVER AL PANEL
// ─────────────────────────────────────────────────────────────────────────────
bot.action('volver_panel', async ctx => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const { pend, proc, fin } = await getContadores();
  const kb = await getMenuKb(uid);
  return ctx.reply(
    `🛵 <b>Panel WIL</b>\n━━━━━━━━━━━━━━\n` +
    `🟡 Pendientes:      <b>${pend}</b>\n` +
    `🔵 En proceso:      <b>${proc}</b>\n` +
    `🟢 Finalizados hoy: <b>${fin}</b>`,
    { parse_mode: 'HTML', ...kb }
  );
});

bot.action('ir_pendientes', async ctx => {
  await ctx.answerCbQuery();
  await mostrarPendientes(ctx);
});

// ─────────────────────────────────────────────────────────────────────────────
// ❓ AYUDA
// ─────────────────────────────────────────────────────────────────────────────
bot.hears('❓ Ayuda', ctx => {
  if (!ok(ctx)) return;
  return ctx.reply(
    `ℹ️ <b>PANEL DOMICILIARIOS WIL</b>\n\n` +
    `📋 <b>Pendientes</b> — Pedidos disponibles para tomar\n` +
    `🚚 <b>En Proceso</b> — Pedidos en camino\n` +
    `✅ <b>Finalizados</b> — Entregas del día\n` +
    `📦 <b>Mi Pedido</b>  — Tu pedido activo\n` +
    `✅ <b>Entregar</b>   — Marcar como entregado\n` +
    `🚪 <b>Cerrar Sesión</b> — Salir del panel\n\n` +
    `En cada pedido:\n` +
    `• 🎯 <b>Tomar</b> — asignártelo\n` +
    `• 🗺️ <b>Ver Ruta</b> — abrir Google Maps o Waze desde la sede\n` +
    `• ✅ <b>Entregar</b> — marcar como entregado\n` +
    `• 🔙 <b>Volver al pedido</b> — regresar desde la vista de ruta`,
    { parse_mode: 'HTML' }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// API PÚBLICA — para que wilBot agregue pedidos al pool de este bot
// ─────────────────────────────────────────────────────────────────────────────
function agregarPedido(pedido) {
  pool[pedido.id] = { ...pedido, estado: 'PENDIENTE' };
  for (const [did, d] of Object.entries(drivers)) {
    if (!d.pedidoActual) {
      bot.telegram.sendMessage(
        did,
        `🔴 <b>Nuevo pedido disponible</b>\n\n` +
        `🆕 <b>${pedido.id}</b>\n🏪 ${pedido.negocioNombre}\n` +
        `📍 ${pedido.barrio || pedido.direccion}\n` +
        `💵 <b>TOTAL: ${COP(pedido.total)}</b>\n\n` +
        `Presiona 📋 <b>Pendientes</b>`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
  }
}

function getPool()    { return pool; }
function getDrivers() { return drivers; }

module.exports = { domiciliarioBot: bot, agregarPedido, getPool, getDrivers };