
const { Telegraf, Markup } = require('telegraf');
const moment = require('moment-timezone');
const cron   = require('node-cron');
const { extraerProductosIA, detectarIntencion } = require('../services/groq');
const {
  inicializar, fmt, pn,
  getCategorias, getProductosPorCategoria,
  buscarProductos,
  registrarPedido, getPedidos, contarPedidosPorEstado, pendientesSinAtender,
  asignarDomiciliario, marcarEntregado,
  verificarClave, guardarTelegramDriver, resumenDia
} = require('../services/sheets');
const { tarifasTexto }                           = require('../data/tarifas');
const { calcularDistancia, obtenerTarifaRapida } = require('../services/distancia');

const bot = new Telegraf(process.env.BOT_TOKEN);

// ─── Estado global en memoria ─────────────────────────────────────────────────
const S        = {};   // sesiones clientes
const drivers  = {};   // domiciliarios autenticados  { uid: { nombre, pedidoActual } }
const pool     = {};   // pedidos activos en memoria   { id: { ...pedido } }
const espClave = {};   // uid esperando ingresar clave
const espMsg   = {};   // admin esperando texto para mensaje masivo

const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const esAdmin   = id => ADMIN_IDS.length === 0 || ADMIN_IDS.includes(id.toString());
const esDriver  = id => !!drivers[id];

// Coordenadas sede WIL — ajusta a tu dirección real
const SEDE_LAT = parseFloat(process.env.SEDE_LAT || '6.3538');
const SEDE_LNG = parseFloat(process.env.SEDE_LNG || '-75.4932');

const COP = n => (!n && n !== 0) ? '$—' : '$' + Math.round(n).toLocaleString('es-CO');

// ─────────────────────────────────────────────────────────────────────────────
// CONTADORES
// Siempre lee Sheets (fuente de verdad).
// Si Sheets falla, usa el pool en memoria como fallback.
// Nunca devuelve error silencioso — si no hay datos devuelve ceros con log.
// ─────────────────────────────────────────────────────────────────────────────
async function getContadores() {
  try {
    const s = await contarPedidosPorEstado();
    // Pool en memoria puede tener pedidos nuevos que aún no están en Sheets
    const memPend = Object.values(pool).filter(p => p.estado === 'PENDIENTE').length;
    const memProc = Object.values(pool).filter(p => p.estado === 'EN_PROCESO').length;
    return {
      pend: Math.max(s.pendientes, memPend),
      proc: Math.max(s.enProceso,  memProc),
      fin:  s.finalizados
    };
  } catch(e) {
    // Sheets falló — usar solo pool en memoria
    console.error('⚠️ getContadores cayó a fallback (pool):', e.message);
    const hoy = moment().tz('America/Bogota').format('DD/MM/YYYY');
    return {
      pend: Object.values(pool).filter(p => p.estado === 'PENDIENTE').length,
      proc: Object.values(pool).filter(p => p.estado === 'EN_PROCESO').length,
      fin:  Object.values(pool).filter(p => p.estado === 'FINALIZADO').length
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MENÚS
// ─────────────────────────────────────────────────────────────────────────────
async function menuDriver(uid) {
  const { pend, proc, fin } = await getContadores();
  const miPed = drivers[uid]?.pedidoActual ? '📦 Mi Pedido ✅' : '📦 Mi Pedido';
  return Markup.keyboard([
    [`📋 Pendientes (${pend})`,  `🚚 En Proceso (${proc})`],
    [`✅ Finalizados (${fin})`,   miPed],
    [`✅ Entregar`,               `👑 Admin`],
    [`🚪 Cerrar Sesión`]
  ]).resize();
}

function menuAdmin() {
  return Markup.keyboard([
    ['📊 Resumen',       '📋 Ver Pendientes'],
    ['🚚 En Proceso',    '✅ Finalizados Hoy'],
    ['🛵 Domiciliarios', '📣 Mensaje Masivo'],
    ['⏰ Recordatorio',  '🔙 Salir Admin']
  ]).resize();
}

// ─────────────────────────────────────────────────────────────────────────────
// CARD DE PEDIDO — vista cliente
// ─────────────────────────────────────────────────────────────────────────────
function cardPedidoCliente(s) {
  const sub = (s.carrito || []).reduce((a, i) => a + i.subtotal, 0);
  const dom = s.precioDomicilio || 0;
  const tot = sub + dom;
  const sep = '━━━━━━━━━━━━━━━━━━━━━━';
  let prods = '';
  if (s.carrito?.length) {
    prods = `\n<b>📦 Productos:</b>\n`;
    s.carrito.forEach((item, i) => {
      if (item.precioUnitario > 0) {
        prods += `  ${i+1}. ${item.descripcion}\n      ${item.cantidad} × ${COP(item.precioUnitario)} = <b>${COP(item.subtotal)}</b>\n`;
      } else {
        prods += `  ${i+1}. ${item.descripcion} × ${item.cantidad}\n`;
      }
    });
  }
  return (
    `🛵 <b>PEDIDO WIL</b>\n${sep}\n` +
    `🏪 ${s.negocioNombre || '—'}\n` +
    `👤 ${s.nombre || '—'}   📱 ${s.telefono || '—'}\n` +
    `📍 ${s.direccion || '—'}\n` +
    prods +
    `${sep}\n` +
    (sub > 0 ? `🧾 Productos:  <b>${COP(sub)}</b>\n` : '') +
    `🛵 Domicilio:  <b>${dom ? COP(dom) : 'Por confirmar'}</b>\n` +
    (tot > 0 ? `💵 <b>TOTAL: ${COP(tot)}</b>\n` : '') +
    sep
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FACTURA — confirmación al cliente
// ─────────────────────────────────────────────────────────────────────────────
function facturaHTML(s, id) {
  const sub   = s.carrito.reduce((a, i) => a + i.subtotal, 0);
  const dom   = s.precioDomicilio || 0;
  const tot   = sub + dom;
  const ahora = moment().tz('America/Bogota').format('DD/MM/YYYY hh:mm A');
  let filas = '';
  s.carrito.forEach(item => {
    filas += `╠══════════════════════════╣\n`;
    filas += `║ ${item.descripcion.substring(0, 26).padEnd(26)} ║\n`;
    if (item.precioUnitario > 0) {
      filas += `║ ${item.cantidad} × ${COP(item.precioUnitario).padEnd(12)} ${COP(item.subtotal).padStart(8)} ║\n`;
    } else {
      filas += `║ Cantidad: ${String(item.cantidad).padEnd(17)} ║\n`;
    }
  });
  return (
    `✅ <b>¡PEDIDO CONFIRMADO!</b>\n\n` +
    `<code>` +
    `╔══════════════════════════╗\n` +
    `║    🛵 DOMICILIOS WIL    ║\n` +
    `║   Copacabana, Ant.      ║\n` +
    `╠══════════════════════════╣\n` +
    `║ ID: ${id.substring(0, 21).padEnd(21)} ║\n` +
    `║ 📅 ${ahora.padEnd(22)} ║\n` +
    `╠══════════════════════════╣\n` +
    `║ 👤 ${(s.nombre || '').substring(0, 22).padEnd(22)} ║\n` +
    `║ 📍 ${(s.barrioDetectado || s.direccion || '').substring(0, 22).padEnd(22)} ║\n` +
    `╠══════════════════════════╣\n` +
    `║ 🏪 ${(s.negocioNombre || '').substring(0, 22).padEnd(22)} ║\n` +
    filas +
    `╠══════════════════════════╣\n` +
    (sub > 0 ? `║ Subtotal  ${COP(sub).padStart(16)} ║\n` : '') +
    `║ Domicilio ${COP(dom).padStart(16)} ║\n` +
    `╠══════════════════════════╣\n` +
    `║ TOTAL     ${COP(tot).padStart(16)} ║\n` +
    `║ Pago: ${(s.metodoPago || '').padEnd(20)} ║\n` +
    `╚══════════════════════════╝` +
    `</code>\n\n` +
    `<i>🛵 En breve un domiciliario tomará tu pedido.</i>`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CARD DE PEDIDO — vista domiciliario
// ─────────────────────────────────────────────────────────────────────────────
function cardPedidoDriver(p, estado) {
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
// LINKS DE NAVEGACIÓN — Google Maps y Waze con ruta completa
// Google Maps: dir/origen/destino → muestra ruta de A a B
// Waze: navigate=yes con from/to en formato correcto
// ─────────────────────────────────────────────────────────────────────────────
function botonesRuta(lugar, pedidoId) {
  const destQuery  = encodeURIComponent(`${lugar}, Copacabana, Antioquia, Colombia`);
  const origenStr  = `${SEDE_LAT},${SEDE_LNG}`;
  // Google Maps — ruta completa desde sede hasta destino
  const gmapsLink  = `https://www.google.com/maps/dir/${origenStr}/${destQuery}`;
  // Waze — formato correcto para ruta con punto de partida explícito
  // ll=destino, from=lat,lng, navigate=yes
  const wazeLink   = `https://waze.com/ul?ll=${destQuery}&from=${origenStr}&navigate=yes`;

  return Markup.inlineKeyboard([
    [Markup.button.url('🗺️ Google Maps (ruta)', gmapsLink)],
    [Markup.button.url('🚗 Waze (navegar)',       wazeLink)],
    [Markup.button.callback('🔙 Volver al pedido', `verpedido_${pedidoId}`)]
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// /start
// ─────────────────────────────────────────────────────────────────────────────
bot.start(async ctx => {
  const uid = ctx.from.id;
  delete S[uid];

  if (drivers[uid]) {
    const kb = await menuDriver(uid);
    await ctx.reply(
      `🛵 Bienvenido de nuevo, <b>${drivers[uid].nombre}</b>`,
      { parse_mode: 'HTML', ...kb }
    );
    const { pend } = await getContadores();
    if (pend > 0) {
      return ctx.reply(
        `🔴 Hay <b>${pend}</b> pedido(s) pendiente(s)`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[
          Markup.button.callback(`📋 Ver pendientes (${pend})`, 'ir_pendientes')
        ]])}
      );
    }
    return;
  }

  return ctx.reply(
    `🛵 <b>¡Bienvenido a Domicilios WIL!</b>\n` +
    `📍 Copacabana, Antioquia 🇨🇴\n\n¿Qué deseas hacer?`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([
      [Markup.button.callback('🛵 Hacer un Pedido', 'menu_pedido')],
      [Markup.button.callback('💲 Ver tarifas',      'ver_tarifas')],
      [Markup.button.callback('🔐 Ingresar',         'ingresar')]
    ])}
  );
});

bot.command('cancelar', ctx => {
  delete S[ctx.from.id];
  return ctx.reply('❌ Pedido cancelado. Escribe /start para comenzar.');
});

// ─────────────────────────────────────────────────────────────────────────────
// ACCIONES INICIO
// ─────────────────────────────────────────────────────────────────────────────
bot.action('ver_tarifas', async ctx => {
  await ctx.answerCbQuery();
  return ctx.reply(tarifasTexto(), {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback('🛵 Hacer pedido', 'menu_pedido')]])
  });
});

bot.action('menu_pedido', async ctx => {
  await ctx.answerCbQuery();
  delete S[ctx.from.id];
  return ctx.reply('¿De dónde quieres pedir?', Markup.inlineKeyboard([
    [Markup.button.callback('🏪 Domicilios WIL (general)', 'neg_wil')],
    [Markup.button.callback('💊 Farmacia Expertos',        'neg_expertos')],
    [Markup.button.callback('🏥 Farmacia La Central',      'neg_central')]
  ]));
});

const NEGOCIOS = {
  wil:      { nombre: '🏪 Domicilios WIL',     tienda: null },
  expertos: { nombre: '💊 Farmacia Expertos',   tienda: 'EXPERTOS' },
  central:  { nombre: '🏥 Farmacia La Central', tienda: 'CENTRAL' }
};

bot.action(/^neg_(.+)$/, async ctx => {
  const key = ctx.match[1];
  await ctx.answerCbQuery();
  S[ctx.from.id] = {
    negocio: key, negocioNombre: NEGOCIOS[key].nombre,
    tienda: NEGOCIOS[key].tienda, carrito: [], paso: 'nombre'
  };
  return ctx.reply(
    cardPedidoCliente(S[ctx.from.id]) + `\n\n✏️ ¿Cuál es tu <b>nombre completo</b>?`,
    { parse_mode: 'HTML' }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// FLUJO PRINCIPAL — manejo de texto
// ─────────────────────────────────────────────────────────────────────────────
bot.on('text', async ctx => {
  const uid = ctx.from.id;
  const txt = ctx.message.text.trim();
  const mid = ctx.message.message_id;
  if (txt.startsWith('/')) return;

  // ── Cerrar sesión ──────────────────────────────────────────────────────────
  if (txt === '🚪 Cerrar Sesión') {
    if (drivers[uid]) {
      if (drivers[uid].pedidoActual) {
        return ctx.reply('⚠️ Tienes un pedido activo. Entrégalo antes de cerrar sesión.');
      }
      delete drivers[uid];
    }
    delete espClave[uid];
    return ctx.reply(
      `👋 <b>Sesión cerrada.</b>\nHasta pronto!\n\nEscribe /start para volver a ingresar.`,
      { parse_mode: 'HTML', ...Markup.removeKeyboard() }
    );
  }

  // ── Verificación de clave ──────────────────────────────────────────────────
  if (espClave[uid]) {
    delete espClave[uid];
    try { await ctx.deleteMessage(mid); } catch(e) {}
    await ctx.reply('🔄 Verificando...');
    const r = await verificarClave(txt);
    if (!r.valida) {
      return ctx.reply(
        `❌ <b>Clave incorrecta.</b>\nPide una nueva al administrador.`,
        { parse_mode: 'HTML' }
      );
    }
    drivers[uid] = { nombre: r.nombre, pedidoActual: null };
    await guardarTelegramDriver(r.fila, uid);
    const kb = await menuDriver(uid);
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

  // ── Mensaje masivo admin ───────────────────────────────────────────────────
  if (espMsg[uid] && esAdmin(uid)) {
    delete espMsg[uid];
    const ids = Object.keys(drivers);
    if (!ids.length) return ctx.reply('😴 No hay domiciliarios conectados.', menuAdmin());
    let ok = 0;
    for (const did of ids) {
      try {
        await bot.telegram.sendMessage(did, `📣 <b>Mensaje Admin:</b>\n\n${txt}`, { parse_mode: 'HTML' });
        ok++;
      } catch(e) {}
    }
    return ctx.reply(
      `✅ Enviado a <b>${ok}</b> domiciliario(s).`,
      { parse_mode: 'HTML', ...menuAdmin() }
    );
  }

  // ── Sesión de cliente activa ───────────────────────────────────────────────
  const s = S[uid];

  if (!s && await detectarIntencion(txt)) {
    return ctx.reply('🛵 ¡Entendido! ¿De dónde quieres pedir?', Markup.inlineKeyboard([
      [Markup.button.callback('🏪 Domicilios WIL (general)', 'neg_wil')],
      [Markup.button.callback('💊 Farmacia Expertos',        'neg_expertos')],
      [Markup.button.callback('🏥 Farmacia La Central',      'neg_central')]
    ]));
  }

  if (!s) return;

  switch (s.paso) {

    case 'nombre':
      s.nombre = txt;
      s.paso   = 'telefono';
      return ctx.reply(
        cardPedidoCliente(s) + `\n\n📱 ¿Cuál es tu <b>teléfono</b>?`,
        { parse_mode: 'HTML' }
      );

    case 'telefono':
      s.telefono = txt;
      s.paso     = 'direccion';
      return ctx.reply(
        cardPedidoCliente(s) +
        `\n\n📍 ¿Cuál es tu <b>dirección o barrio</b>?\n` +
        `<i>Ej: "Barrio Asunción" o "Cra 50 #30, Asunción"</i>`,
        { parse_mode: 'HTML' }
      );

    case 'direccion': {
      s.direccion = txt;
      await ctx.reply('📍 Buscando tu barrio...', { parse_mode: 'HTML' });
      const { barrio, tarifa } = await obtenerTarifaRapida(txt);
      s.precioDomicilio = tarifa || null;
      s.barrioDetectado = barrio || null;
      const msgZona = tarifa
        ? `✅ <b>${barrio}</b> — Domicilio: <b>${COP(tarifa)}</b>`
        : `⚠️ Barrio no reconocido — el precio se confirma`;
      if (s.negocio === 'wil') {
        s.paso = 'presupuesto';
        return ctx.reply(
          cardPedidoCliente(s) +
          `\n\n${msgZona}\n\n💰 ¿Cuánto dinero tienes de <b>presupuesto</b> para los productos?\n` +
          `<i>(Ej: 30000 o "no sé")</i>`,
          { parse_mode: 'HTML' }
        );
      }
      s.paso = 'buscar';
      return ctx.reply(
        cardPedidoCliente(s) + `\n\n${msgZona}\n\n🔍 Escribe el nombre del medicamento:`,
        { parse_mode: 'HTML' }
      );
    }

    case 'presupuesto': {
      const n = parseInt(txt.replace(/[^0-9]/g, ''));
      s.presupuesto = isNaN(n) ? 'Sin límite' : COP(n);
      s.paso = 'pedido_libre';
      return ctx.reply(
        cardPedidoCliente(s) +
        `\n\n💰 Presupuesto: <b>${s.presupuesto}</b>\n\n` +
        `📦 ¿Qué necesitas?\n` +
        `<i>Escríbelo como quieras:\n"2 aceites, 1 arroz, 3 cervezas"</i>`,
        { parse_mode: 'HTML' }
      );
    }

    case 'pedido_libre': {
      await ctx.reply('🤖 Analizando tu pedido con IA...');
      const items = await extraerProductosIA(txt);
      if (!items.length) {
        return ctx.reply(
          `😕 No pude identificar productos.\nIntenta: <i>"2 aceites, 1 arroz, 3 cervezas"</i>`,
          { parse_mode: 'HTML' }
        );
      }
      s.carrito = items;
      s.paso    = 'confirmar_libre';
      let lista = '';
      s.carrito.forEach((item, i) => { lista += `  ${i+1}. ${item.descripcion} × ${item.cantidad}\n`; });
      return ctx.reply(
        `📋 <b>Entendí este pedido:</b>\n\n<code>${lista}</code>\n` +
        `💰 Presupuesto: <b>${s.presupuesto || 'Sin límite'}</b>\n` +
        `🛵 Domicilio: <b>${s.precioDomicilio ? COP(s.precioDomicilio) : 'Por confirmar'}</b>\n\n` +
        `¿Es correcto?`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Sí, confirmar',    'confirmar_pedido_libre')],
          [Markup.button.callback('✏️ Modificar pedido', 'modificar_libre')],
          [Markup.button.callback('❌ Cancelar',          'cancelar_pedido')]
        ])}
      );
    }

    case 'buscar': {
      if (txt.length < 2) return ctx.reply('🔍 Escribe al menos 2 letras.');
      const matchCant = txt.match(/^(\d+)\s+(.+)$/);
      if (matchCant) {
        s._cantPendiente = parseInt(matchCant[1]);
        return await buscarYMostrar(ctx, s, matchCant[2]);
      }
      return await buscarYMostrar(ctx, s, txt);
    }

    case 'cantidad': {
      const n = parseInt(txt);
      if (isNaN(n) || n <= 0) return ctx.reply('❌ Ingresa un número válido:');
      await agregarAlCarrito(ctx, s, n);
      break;
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// BÚSQUEDA FARMACIA
// ─────────────────────────────────────────────────────────────────────────────
async function buscarYMostrar(ctx, s, termino) {
  await ctx.reply(`⏳ Buscando <b>"${termino}"</b>...`, { parse_mode: 'HTML' });
  const res = await buscarProductos(termino, s.tienda);

  if (!res.length) {
    return ctx.reply(
      `😕 No encontré <b>"${termino}"</b>.\nIntenta con otro nombre:`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([
        ...(s.carrito.length ? [[Markup.button.callback('✅ Finalizar pedido', 'finalizar')]] : []),
        [Markup.button.callback('📞 No encuentro lo que busco', 'no_encuentro')]
      ])}
    );
  }

  s.busqueda = res;
  let msg = `💊 <b>${res.length}</b> resultado(s) para <b>"${termino}"</b>:\n\n`;
  res.forEach((p, i) => {
    msg += `${i+1}. <b>${p.descripcion}</b>\n`;
    msg += `   🏭 ${p.laboratorio || '—'}  📦 ${p.unidad || 'Unidad'}\n`;
    if (p.tienePrecioVarios) {
      msg += `   💰 1 und: <b>${COP(p.precioUnidad)}</b>  |  Varios: <b>${COP(p.precioUnitario)}</b>\n\n`;
    } else {
      msg += `   💰 <b>${COP(p.precioUnitario)}</b> c/u\n\n`;
    }
  });

  const botones = res.map((p, i) => [
    Markup.button.callback(`${i+1}. ${p.descripcion.substring(0, 30)} ${COP(p.precioUnitario)}`, `prod_${i}`)
  ]);
  botones.push([Markup.button.callback('🔍 Buscar otro', 'buscar_otro')]);
  if (s.carrito.length) botones.push([Markup.button.callback('✅ Finalizar pedido', 'finalizar')]);

  return ctx.reply(msg, { parse_mode: 'HTML', ...Markup.inlineKeyboard(botones) });
}

async function agregarAlCarrito(ctx, s, cantidad) {
  const p  = s.prodSel;
  const pu = cantidad === 1
    ? (p.precioUnidad    || p.precioUnitario || 0)
    : (p.precioUnitario  || p.precioUnidad   || 0);
  s.carrito.push({
    descripcion: p.descripcion, laboratorio: p.laboratorio,
    unidad: p.unidad, cantidad, precioUnitario: pu, subtotal: pu * cantidad
  });
  s.paso = 'buscar';
  delete s._cantPendiente;
  return ctx.reply(
    cardPedidoCliente(s) + `\n\n✅ <b>Agregado al carrito</b>\n\n🔍 ¿Qué más necesitas?`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([
      [Markup.button.callback('➕ Agregar otro producto', 'buscar_otro')],
      [Markup.button.callback('✅ Finalizar pedido',      'finalizar')],
      [Markup.button.callback('🗑️ Vaciar carrito',        'vaciar')]
    ])}
  );
}

bot.action(/^prod_(\d+)$/, async ctx => {
  const uid = ctx.from.id;
  const s   = S[uid];
  await ctx.answerCbQuery();
  if (!s?.busqueda?.[ctx.match[1]]) return ctx.reply('❌ Busca de nuevo.');
  s.prodSel = s.busqueda[parseInt(ctx.match[1])];
  if (s._cantPendiente) return await agregarAlCarrito(ctx, s, s._cantPendiente);
  s.paso = 'cantidad';
  const p = s.prodSel;
  return ctx.reply(
    `💊 <b>${p.descripcion}</b>\n🏭 ${p.laboratorio || '—'}\n📦 ${p.unidad || 'Unidad'}\n` +
    (p.tienePrecioVarios
      ? `💰 1 unidad: <b>${COP(p.precioUnidad)}</b>\n💰 Varios: <b>${COP(p.precioUnitario)}</b> c/u\n\n`
      : `💰 <b>${COP(p.precioUnitario)}</b> c/u\n\n`) +
    `¿Cuántas unidades?`,
    { parse_mode: 'HTML' }
  );
});

bot.action('buscar_otro', async ctx => {
  const s = S[ctx.from.id];
  await ctx.answerCbQuery();
  if (!s) return;
  s.paso = 'buscar';
  return ctx.reply('🔍 Escribe el nombre del medicamento:');
});

bot.action('no_encuentro', async ctx => {
  await ctx.answerCbQuery();
  return ctx.reply(
    `📞 <b>¿No encontraste lo que buscas?</b>\n\nEscríbenos al WhatsApp:\n👉 <b>${process.env.WHATSAPP_NUMERO || '3XXXXXXXXX'}</b>`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Volver', 'menu_pedido')]]) }
  );
});

bot.action('vaciar', async ctx => {
  const s = S[ctx.from.id];
  await ctx.answerCbQuery('🗑️ Vaciado');
  if (!s) return;
  s.carrito = [];
  s.paso    = 'buscar';
  return ctx.reply(cardPedidoCliente(s) + '\n\n🔍 Busca un producto:', { parse_mode: 'HTML' });
});

bot.action('finalizar', async ctx => {
  const s = S[ctx.from.id];
  await ctx.answerCbQuery();
  if (!s?.carrito?.length) return ctx.reply('❌ Tu carrito está vacío.');
  s.paso = 'pago';
  return ctx.reply(
    cardPedidoCliente(s) + `\n\n💳 ¿Cómo vas a pagar?`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([
      [Markup.button.callback('💵 Efectivo',        'pago_EFECTIVO')],
      [Markup.button.callback('📲 Nequi/Daviplata', 'pago_NEQUI')],
      [Markup.button.callback('🏦 Transferencia',   'pago_TRANSFERENCIA')]
    ])}
  );
});

bot.action('confirmar_pedido_libre', async ctx => {
  const s = S[ctx.from.id];
  await ctx.answerCbQuery();
  if (!s) return;
  s.paso = 'pago';
  return ctx.reply(
    cardPedidoCliente(s) + `\n\n💳 ¿Cómo vas a pagar?`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([
      [Markup.button.callback('💵 Efectivo',        'pago_EFECTIVO')],
      [Markup.button.callback('📲 Nequi/Daviplata', 'pago_NEQUI')],
      [Markup.button.callback('🏦 Transferencia',   'pago_TRANSFERENCIA')]
    ])}
  );
});

bot.action('modificar_libre', async ctx => {
  const s = S[ctx.from.id];
  await ctx.answerCbQuery();
  if (!s) return;
  s.carrito = [];
  s.paso    = 'pedido_libre';
  return ctx.reply('✏️ Escribe de nuevo tu pedido:');
});

bot.action('cancelar_pedido', async ctx => {
  delete S[ctx.from.id];
  await ctx.answerCbQuery('❌ Cancelado');
  return ctx.reply('❌ Pedido cancelado. /start para comenzar.');
});

bot.action(/^pago_(.+)$/, async ctx => {
  const s = S[ctx.from.id];
  await ctx.answerCbQuery();
  if (!s) return;
  s.metodoPago = ctx.match[1];
  if (s.metodoPago !== 'EFECTIVO') {
    s.paso = 'comprobante';
    return ctx.reply('📸 Envía la <b>foto del comprobante</b>:', { parse_mode: 'HTML' });
  }
  await procesarPedido(ctx, ctx.from.id);
});

bot.on('photo', async ctx => {
  const uid = ctx.from.id;
  const s   = S[uid];
  if (!s || s.paso !== 'comprobante') return;
  s.imagenFileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
  await procesarPedido(ctx, uid);
});

// ─────────────────────────────────────────────────────────────────────────────
// PROCESAR Y GUARDAR PEDIDO
// ─────────────────────────────────────────────────────────────────────────────
async function procesarPedido(ctx, uid) {
  const s   = S[uid];
  const sub = s.carrito.reduce((a, i) => a + i.subtotal, 0);
  const tot = sub + (s.precioDomicilio || 0);

  const id = await registrarPedido({
    nombre: s.nombre, telefono: s.telefono, metodoPago: s.metodoPago,
    imagenFileId: s.imagenFileId || '', carrito: s.carrito,
    negocioNombre: s.negocioNombre, tienda: s.tienda,
    direccion: s.barrioDetectado || s.direccion,
    precioDomicilio: s.precioDomicilio || 0, totalFinal: tot
  });

  await ctx.reply(
    facturaHTML(s, id) + `\n\n🆔 <b>${id}</b>\n<i>Guarda este ID para consultar tu pedido</i>`,
    { parse_mode: 'HTML' }
  );

  // Notificar canal
  try {
    await ctx.telegram.sendMessage(
      process.env.CANAL_PEDIDOS_ID,
      `🔔 <b>NUEVO PEDIDO — ${id}</b>\n🏪 ${s.negocioNombre}\n` +
      `👤 ${s.nombre}   📱 ${s.telefono}\n` +
      `📍 ${s.barrioDetectado || s.direccion}\n` +
      `📦 ${s.carrito.map(i => `${i.cantidad}× ${i.descripcion}`).join(', ')}\n` +
      (s.presupuesto ? `💰 Presupuesto: ${s.presupuesto}\n` : '') +
      `💵 Total: <b>${COP(tot)}</b>`,
      { parse_mode: 'HTML' }
    );
  } catch(e) { console.error('canal pedidos:', e.message); }

  // Guardar en pool con todos los datos
  pool[id] = {
    id,
    negocioNombre: s.negocioNombre,
    cliente:       s.nombre,
    telefono:      s.telefono,
    clienteId:     uid,
    direccion:     s.barrioDetectado || s.direccion,
    barrio:        s.barrioDetectado || s.direccion,
    presupuesto:   s.presupuesto || null,
    productos:     s.carrito.map(i => `${i.cantidad}× ${i.descripcion}`).join(', '),
    total:         tot,
    precioDomicilio: s.precioDomicilio || 0,
    estado:        'PENDIENTE'
  };

  // Notificar domiciliarios disponibles
  const { pend } = await getContadores();
  for (const [did, d] of Object.entries(drivers)) {
    if (!d.pedidoActual) {
      bot.telegram.sendMessage(
        did,
        `🔴 <b>${pend}</b> pedido(s) pendiente(s)\n\n` +
        `🆕 <b>NUEVO:</b> ${id}\n🏪 ${s.negocioNombre}\n` +
        `📍 ${s.barrioDetectado || s.direccion}\n💵 ${COP(tot)}\n\n` +
        `Presiona 📋 <b>Pendientes</b>`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
  }

  delete S[uid];
}

// ─────────────────────────────────────────────────────────────────────────────
// INGRESAR — domiciliario
// ─────────────────────────────────────────────────────────────────────────────
bot.action('ingresar', async ctx => {
  const uid = ctx.from.id;
  await ctx.answerCbQuery();
  if (drivers[uid]) {
    const kb = await menuDriver(uid);
    return ctx.reply(
      `🛵 Ya estás autenticado, <b>${drivers[uid].nombre}</b>`,
      { parse_mode: 'HTML', ...kb }
    );
  }
  espClave[uid] = true;
  return ctx.reply(
    `🔐 Escribe tu <b>clave de acceso</b>:\n<i>(El mensaje se borrará automáticamente)</i>`,
    { parse_mode: 'HTML', ...Markup.removeKeyboard() }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 📋 PENDIENTES
// Lee pool en memoria + Sheets para mostrar TODOS los pendientes reales
// ─────────────────────────────────────────────────────────────────────────────
bot.hears(/^📋 Pendientes/, async ctx => {
  if (!esDriver(ctx.from.id) && !esAdmin(ctx.from.id)) return ctx.reply('🔐 Ingresa con tu clave. /start');
  await mostrarPendientes(ctx);
});

async function mostrarPendientes(ctx) {
  // 1. Pendientes en memoria
  const enMem = Object.values(pool).filter(p => p.estado === 'PENDIENTE');
  // 2. Pendientes en Sheets que no estén ya en memoria
  const enSheets = await getPedidos('PENDIENTE').catch(() => []);
  const idsMemoria = new Set(enMem.map(p => p.id));
  const soloSheets = enSheets
    .filter(p => !idsMemoria.has(p.id))
    .map(p => ({
      id:            p.id,
      negocioNombre: p.negocio,
      cliente:       p.cliente,
      telefono:      p.telefono,
      direccion:     p.direccion,
      barrio:        p.barrio || p.direccion,
      productos:     p.productos,
      total:         p.total,
      precioDomicilio: 0,
      estado:        'PENDIENTE'
    }));

  const todos = [...enMem, ...soloSheets];

  if (!todos.length) return ctx.reply('😴 No hay pedidos pendientes ahora.');

  await ctx.reply(
    `🔴 <b>${todos.length}</b> pedido(s) pendiente(s):`,
    { parse_mode: 'HTML' }
  );

  for (const p of todos) {
    await ctx.reply(
      cardPedidoDriver(p, 'PENDIENTE'),
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
  if (!esDriver(ctx.from.id) && !esAdmin(ctx.from.id)) return ctx.reply('🔐 Ingresa con tu clave. /start');
  await mostrarEnProceso(ctx);
});

async function mostrarEnProceso(ctx) {
  const enMem    = Object.values(pool).filter(p => p.estado === 'EN_PROCESO');
  const enSheets = await getPedidos('EN_PROCESO').catch(() => []);
  const idsMemoria = new Set(enMem.map(p => p.id));
  const soloSheets = enSheets
    .filter(p => !idsMemoria.has(p.id))
    .map(p => ({
      id:            p.id,
      negocioNombre: p.negocio,
      cliente:       p.cliente,
      telefono:      p.telefono,
      direccion:     p.direccion,
      barrio:        p.barrio || p.direccion,
      productos:     p.productos,
      total:         p.total,
      precioDomicilio: 0,
      domiciliario:  p.domiciliario,
      horaTomo:      p.horaTomo,
      estado:        'EN_PROCESO'
    }));

  const todos = [...enMem, ...soloSheets];

  if (!todos.length) return ctx.reply('📭 Ningún pedido en proceso ahora.');

  await ctx.reply(`🚚 <b>${todos.length}</b> pedido(s) en proceso:`, { parse_mode: 'HTML' });

  for (const p of todos) {
    const uid           = ctx.from.id;
    const esMiPedido    = drivers[uid]?.pedidoActual === p.id;
    const puedeEntregar = esMiPedido || esAdmin(uid);
    await ctx.reply(
      cardPedidoDriver(p, 'EN_PROCESO') +
      `\n🛵 ${p.domiciliario || '?'} — ⏰ ${p.horaTomo || '?'}`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([
        [
          Markup.button.callback('🗺️ Ver Ruta', `dist_${p.id}`),
          ...(puedeEntregar ? [Markup.button.callback('✅ Finalizar', `entregar_${p.id}`)] : [])
        ],
        [Markup.button.callback('🔙 Volver al panel', 'volver_panel')]
      ])}
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ✅ FINALIZADOS
// ─────────────────────────────────────────────────────────────────────────────
bot.hears(/^✅ Finalizados/, async ctx => {
  if (!esDriver(ctx.from.id) && !esAdmin(ctx.from.id)) return ctx.reply('🔐 Ingresa con tu clave. /start');
  await mostrarFinalizados(ctx);
});

async function mostrarFinalizados(ctx) {
  const hoy = moment().tz('America/Bogota').format('DD/MM/YYYY');
  const ps  = (await getPedidos('FINALIZADO').catch(() => [])).filter(p => p.fecha === hoy);
  if (!ps.length) return ctx.reply(`📭 Sin entregas finalizadas hoy (${hoy})`);
  let msg = `✅ <b>${ps.length}</b> entrega(s) hoy ${hoy}:\n\n`;
  ps.forEach((p, i) => {
    msg += `${i+1}. 🆔 <b>${p.id}</b>\n`;
    msg += `   📍 ${p.direccion}\n`;
    msg += `   🛵 ${p.domiciliario || '?'} ⏰ ${p.horaEntrego || '?'}\n`;
    msg += `   💵 ${COP(p.total)}\n\n`;
  });
  return ctx.reply(msg, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Volver al panel', 'volver_panel')]])
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 📦 MI PEDIDO
// ─────────────────────────────────────────────────────────────────────────────
bot.hears(/^📦 Mi Pedido/, ctx => {
  if (!esDriver(ctx.from.id)) return ctx.reply('🔐 Ingresa con tu clave. /start');
  const d = drivers[ctx.from.id];
  if (!d.pedidoActual) return ctx.reply('📭 No tienes pedido activo ahora.');
  const p = pool[d.pedidoActual];
  if (!p) return ctx.reply('❌ No encontré datos del pedido en memoria.\nUsa 🚚 <b>En Proceso</b> para verlo.', { parse_mode: 'HTML' });
  return ctx.reply(
    `📦 <b>TU PEDIDO ACTIVO</b>\n━━━━━━━━━━━━━━\n` + cardPedidoDriver(p, 'EN_PROCESO'),
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([
      [Markup.button.callback('🗺️ Ver Ruta',           `dist_${p.id}`)],
      [Markup.button.callback('✅ Marcar entregado',    `entregar_${p.id}`)],
      [Markup.button.callback('🔙 Volver al panel',     'volver_panel')]
    ])}
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// ✅ ENTREGAR — botón teclado
// ─────────────────────────────────────────────────────────────────────────────
bot.hears('✅ Entregar', async ctx => {
  const d = drivers[ctx.from.id];
  if (!d) return ctx.reply('🔐 Ingresa con tu clave. /start');
  if (!d.pedidoActual) return ctx.reply('❌ No tienes pedido activo.');
  await _entregar(ctx, ctx.from.id, d.pedidoActual);
});

// ─────────────────────────────────────────────────────────────────────────────
// 🎯 TOMAR PEDIDO
// Si el pedido no está en pool (fue creado antes de iniciar el servidor),
// lo carga desde Sheets al pool antes de asignarlo
// ─────────────────────────────────────────────────────────────────────────────
bot.action(/^tomar_(.+)$/, async ctx => {
  const id  = ctx.match[1];
  const uid = ctx.from.id;
  await ctx.answerCbQuery();

  const d = drivers[uid] || (esAdmin(uid) ? { nombre: 'Admin', pedidoActual: null } : null);
  if (!d) return ctx.reply('❌ Autentícate primero. /start');
  if (d.pedidoActual) return ctx.reply('⚠️ Ya tienes un pedido activo. Entrégalo primero.');

  // Si ya está en pool, verificar que siga PENDIENTE
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

  // Marcar en memoria y en Sheets
  pool[id].estado = 'EN_PROCESO';
  if (drivers[uid]) drivers[uid].pedidoActual = id;

  const hora = await asignarDomiciliario(id, d.nombre);
  const p    = pool[id];

  await ctx.editMessageText(
    `✅ <b>¡Tomado a las ${hora || '—'}!</b>\n━━━━━━━━━━━━━━\n` +
    cardPedidoDriver({ ...p, domiciliario: d.nombre }, 'EN_PROCESO'),
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([
      [
        Markup.button.callback('🗺️ Ver Ruta',  `dist_${id}`),
        Markup.button.callback('✅ Finalizar', `entregar_${id}`)
      ],
      [Markup.button.callback('🔙 Volver al panel', 'volver_panel')]
    ])}
  );

  // Actualizar menú con contadores frescos
  try {
    const kb = await menuDriver(uid);
    await bot.telegram.sendMessage(
      uid,
      `🛵 Pedido <b>${id}</b> asignado. ¡Mucho éxito!`,
      { parse_mode: 'HTML', ...kb }
    );
  } catch(e) {}

  // Notificar al cliente
  if (p.clienteId) {
    bot.telegram.sendMessage(
      p.clienteId,
      `🛵 <b>¡Tu pedido fue tomado!</b>\n━━━━━━━━━━━━━━\n` +
      `🆔 ${id}\n👤 Domiciliario: <b>${d.nombre}</b>\n` +
      `⏰ Tiempo estimado: <b>40 minutos</b>\n\n¡Prepárate para recibirlo! 😊`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 🗺️ VER RUTA — Google Maps + Waze con ruta completa desde la sede
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
  const destStr    = `${lugar}, Copacabana, Antioquia, Colombia`;
  const destEnc    = encodeURIComponent(destStr);
  const origenStr  = `${SEDE_LAT},${SEDE_LNG}`;

  // Google Maps — ruta de origen a destino
  const gmapsLink = `https://www.google.com/maps/dir/${origenStr}/${destEnc}`;

  // Waze — formato correcto para abrir ruta con punto de partida
  // El parámetro "from" con latitud,longitud establece el origen
  // "navigate=yes" activa la navegación automáticamente
  const wazeLink  = `https://waze.com/ul?q=${destEnc}&from=${origenStr}&navigate=yes`;

  const botonesNav = Markup.inlineKeyboard([
    [Markup.button.url('🗺️ Google Maps (ruta completa)', gmapsLink)],
    [Markup.button.url('🚗 Waze (navegar desde sede)',    wazeLink)],
    [Markup.button.callback('🔙 Volver al pedido',        `verpedido_${id}`)]
  ]);

  if (r.error || r.parcial) {
    return ctx.reply(
      `🗺️ <b>RUTA AL CLIENTE</b>\n━━━━━━━━━━━━━━\n` +
      `📍 Destino: <b>${r.barrio || lugar}</b>\n` +
      (r.tarifa ? `💰 Tarifa: <b>${COP(r.tarifa)}</b>\n` : '') +
      `\n📲 Abre la navegación:`,
      { parse_mode: 'HTML', ...botonesNav }
    );
  }

  return ctx.reply(
    `🗺️ <b>RUTA AL CLIENTE</b>\n━━━━━━━━━━━━━━\n` +
    `🏁 Origen: Sede WIL\n` +
    `📍 Destino: <b>${r.barrio || lugar}</b>\n` +
    `━━━━━━━━━━━━━━\n` +
    `📏 Distancia: <b>${r.distancia}</b>\n` +
    `🛵 En moto:   <b>${r.moto}</b>\n` +
    `🚗 En carro:  ${r.carro}\n` +
    (r.tarifa ? `💰 Tarifa: <b>${COP(r.tarifa)}</b>\n` : '') +
    `━━━━━━━━━━━━━━\n📲 Abre la navegación:`,
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

  const esMiPedido    = drivers[uid]?.pedidoActual === id;
  const puedeEntregar = esMiPedido || esAdmin(uid);
  const estado        = (p.estado || 'EN_PROCESO').toUpperCase();

  return ctx.reply(
    `📦 <b>PEDIDO ${id}</b>\n━━━━━━━━━━━━━━\n` + cardPedidoDriver(p, estado),
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([
      [Markup.button.callback('🗺️ Ver Ruta', `dist_${id}`)],
      ...(puedeEntregar ? [[Markup.button.callback('✅ Marcar entregado', `entregar_${id}`)]] : []),
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
  if (drivers[uid] && drivers[uid].pedidoActual !== id && !esAdmin(uid)) {
    return ctx.reply('⚠️ No puedes finalizar ese pedido.');
  }
  await _entregar(ctx, uid, id);
});

async function _entregar(ctx, uid, id) {
  const hora = await marcarEntregado(id);
  if (pool[id]) pool[id].estado = 'FINALIZADO';
  if (drivers[uid]) drivers[uid].pedidoActual = null;

  const nombre    = drivers[uid]?.nombre || 'Admin';
  const clienteId = pool[id]?.clienteId;

  if (clienteId) {
    bot.telegram.sendMessage(
      clienteId,
      `✅ <b>¡Tu pedido fue entregado!</b>\n🆔 ${id}\n⏰ ${hora || '—'}\n\n` +
      `¡Gracias por usar Domicilios WIL! 🛵`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }

  const kb       = await menuDriver(uid);
  const { pend } = await getContadores();

  return ctx.reply(
    `🎉 <b>¡PEDIDO ENTREGADO!</b>\n🆔 ${id}\n⏰ ${hora || '—'}\n\n` +
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
  const kb = (esAdmin(uid) && !esDriver(uid)) ? menuAdmin() : await menuDriver(uid);
  return ctx.reply(
    `🛵 <b>Panel WIL</b>\n━━━━━━━━━━━━━━\n` +
    `🟡 Pendientes:      <b>${pend}</b>\n` +
    `🔵 En proceso:      <b>${proc}</b>\n` +
    `🟢 Finalizados hoy: <b>${fin}</b>`,
    { parse_mode: 'HTML', ...kb }
  );
});

bot.action('ir_pendientes',  async ctx => { await ctx.answerCbQuery(); await mostrarPendientes(ctx); });
bot.action('ir_finalizados', async ctx => { await ctx.answerCbQuery(); await mostrarFinalizados(ctx); });
bot.action('ir_en_proceso',  async ctx => { await ctx.answerCbQuery(); await mostrarEnProceso(ctx); });

// ─────────────────────────────────────────────────────────────────────────────
// PANEL ADMIN
// ─────────────────────────────────────────────────────────────────────────────
bot.hears('👑 Admin', async ctx => {
  if (!esAdmin(ctx.from.id)) return ctx.reply('🚫 Sin acceso de administrador.');
  const { pend, proc, fin } = await getContadores();
  return ctx.reply(
    `👑 <b>Panel Administrador WIL</b>\n━━━━━━━━━━━━━━\n` +
    `🟡 Pendientes:      <b>${pend}</b>\n` +
    `🔵 En proceso:      <b>${proc}</b>\n` +
    `🟢 Finalizados hoy: <b>${fin}</b>`,
    { parse_mode: 'HTML', ...menuAdmin() }
  );
});

bot.hears('📊 Resumen', async ctx => {
  if (!esAdmin(ctx.from.id)) return;
  const r = await resumenDia();
  return ctx.reply(
    `📊 <b>RESUMEN — ${r.hoy}</b>\n━━━━━━━━━━━━━━\n` +
    `📦 Total hoy:   <b>${r.total}</b>\n\n` +
    `🟡 Pendientes:  <b>${r.pendientes}</b>\n` +
    `🔵 En proceso:  <b>${r.enProceso}</b>\n` +
    `🟢 Finalizados: <b>${r.finalizados}</b>\n` +
    `❌ Cancelados:  <b>${r.cancelados}</b>\n\n` +
    `💰 Ventas del día: <b>${COP(r.ventas)}</b>`,
    { parse_mode: 'HTML' }
  );
});

bot.hears('📋 Ver Pendientes',  async ctx => { if (!esAdmin(ctx.from.id)) return; await mostrarPendientes(ctx); });
bot.hears('✅ Finalizados Hoy', async ctx => { if (!esAdmin(ctx.from.id)) return; await mostrarFinalizados(ctx); });

bot.hears('🛵 Domiciliarios', ctx => {
  if (!esAdmin(ctx.from.id)) return;
  const enLinea = Object.entries(drivers);
  if (!enLinea.length) return ctx.reply('😴 No hay domiciliarios conectados.');
  let msg = `🛵 <b>DOMICILIARIOS EN LÍNEA</b>\n━━━━━━━━━━━━━━\n\n`;
  for (const [, d] of enLinea) {
    msg += `• <b>${d.nombre}</b> — ${d.pedidoActual ? `🔵 Llevando ${d.pedidoActual}` : '🟢 Disponible'}\n`;
  }
  return ctx.reply(msg, { parse_mode: 'HTML' });
});

bot.hears('📣 Mensaje Masivo', ctx => {
  if (!esAdmin(ctx.from.id)) return;
  espMsg[ctx.from.id] = true;
  return ctx.reply('📣 Escribe el mensaje para todos los domiciliarios:');
});

bot.hears('⏰ Recordatorio', async ctx => {
  if (!esAdmin(ctx.from.id)) return;
  await enviarRecordatorio();
  return ctx.reply('✅ Recordatorio enviado.');
});

bot.hears('🔙 Salir Admin', async ctx => {
  const kb = await menuDriver(ctx.from.id);
  return ctx.reply('👋 Saliste del panel admin.', { ...kb });
});

// ─────────────────────────────────────────────────────────────────────────────
// RECORDATORIO AUTOMÁTICO
// ─────────────────────────────────────────────────────────────────────────────
async function enviarRecordatorio() {
  const ps = await pendientesSinAtender(10).catch(() => []);
  if (!ps.length) return;
  const hoy = moment().tz('America/Bogota').format('DD/MM/YYYY');
  let msg = `⚠️ <b>PEDIDOS SIN ATENDER</b>\n━━━━━━━━━━━━━━\n\n`;
  ps.forEach(p => {
    const t    = moment.tz(`${hoy} ${p.hora}`, 'DD/MM/YYYY hh:mm A', 'America/Bogota');
    const mins = moment().tz('America/Bogota').diff(t, 'minutes');
    msg += `🔴 <b>${p.id}</b>\n📍 ${p.direccion}\nHace <b>${mins} min</b>\n\n`;
  });
  try { await bot.telegram.sendMessage(process.env.CANAL_PEDIDOS_ID, msg, { parse_mode: 'HTML' }); } catch(e) {}
  for (const id of ADMIN_IDS) {
    bot.telegram.sendMessage(id, msg, { parse_mode: 'HTML' }).catch(() => {});
  }
  for (const [did, d] of Object.entries(drivers)) {
    if (!d.pedidoActual) {
      bot.telegram.sendMessage(
        did,
        `🔴 <b>${ps.length}</b> pedido(s) sin atender\nRevisa 📋 <b>Pendientes</b>`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
  }
}

function iniciarCron() {
  cron.schedule('*/10 * * * *', () => {
    enviarRecordatorio().catch(e => console.error('cron recordatorio:', e.message));
  }, { timezone: 'America/Bogota' });
  console.log('⏰ Recordatorios automáticos activados (cada 10 min)');
}

module.exports = { wilBot: bot, iniciarCron };