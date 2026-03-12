// ══════════════════════════════════════════════════════════════════════════════
// features.js — Domicilios WIL
// Módulo de funcionalidades avanzadas:
//   1. Pedidos programados (agendar para fecha/hora futura)
//   2. Historial del cliente
//   3. Negocios aliados dinámicos (catálogo desde sheet)
//   4. Foto del domiciliario al asignar pedido
//   5. Encuesta post-entrega mejorada (estrellas + categoría)
//   6. ETA en tiempo real (actualización automática con GPS del domi)
//   7. Turno del domi (mañana / tarde / noche)
// ══════════════════════════════════════════════════════════════════════════════

const { Markup } = require('telegraf');
const moment = require('moment-timezone');
const cron = require('node-cron');

// ──────────────────────────────────────────────────────────────────────────────
// HELPERS LOCALES
// ──────────────────────────────────────────────────────────────────────────────
const COP = n => {
  if (n === null || n === undefined || n === '') return '$0';
  if (typeof n === 'string') n = parseFloat(n.replace(/\./g, '').replace(/[^0-9\-]/g, '')) || 0;
  const num = Math.round(Number(n));
  if (isNaN(num)) return '$0';
  return (num < 0 ? '-$' : '$') + Math.abs(num).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
};

const TZ = 'America/Bogota';
const ahoraBog = () => moment().tz(TZ);

// ══════════════════════════════════════════════════════════════════════════════
// 1. PEDIDOS PROGRAMADOS
// ══════════════════════════════════════════════════════════════════════════════

// Almacén en memoria — en producción esto iría a un sheet o DB
const pedidosProgramados = {}; // id → { pedido, dispararEn (timestamp), enviado }

/**
 * Agenda un pedido para dispararse en una fecha/hora futura.
 * @param {string} id      - ID del pedido
 * @param {object} pedido  - objeto pedido completo (mismo formato del pool)
 * @param {string} fechaHora - "DD/MM/YYYY hh:mm A" o "mañana hh:mm A"
 * @returns {{ ok: boolean, dispararEn: string|null, error: string|null }}
 */
function agendarPedido(id, pedido, fechaHora) {
  try {
    let ts;
    const txtLow = fechaHora.toLowerCase().trim();

    // Interpretar "mañana HH:mm" / "hoy HH:mm"
    const horaMatch = txtLow.match(/(\d{1,2})[:\.](\d{2})\s*(a\.?m\.?|p\.?m\.?)?/i);
    if (!horaMatch) return { ok: false, error: 'No reconocí la hora. Usa formato: 2:30pm o 14:30' };

    let horas = parseInt(horaMatch[1]);
    const minutos = parseInt(horaMatch[2]);
    const meridiem = (horaMatch[3] || '').replace(/\./g, '').toLowerCase();
    if (meridiem === 'pm' && horas < 12) horas += 12;
    if (meridiem === 'am' && horas === 12) horas = 0;

    const base = txtLow.includes('mañana')
      ? ahoraBog().add(1, 'day').startOf('day')
      : txtLow.includes('pasado')
        ? ahoraBog().add(2, 'day').startOf('day')
        : ahoraBog().startOf('day');

    ts = base.hours(horas).minutes(minutos).seconds(0);

    // Si la hora ya pasó hoy → mover a mañana
    if (ts.isBefore(ahoraBog())) {
      if (!txtLow.includes('mañana') && !txtLow.includes('pasado')) {
        ts = ts.add(1, 'day');
      } else {
        return { ok: false, error: 'Esa hora ya pasó. Elige una hora futura.' };
      }
    }

    pedidosProgramados[id] = {
      pedido: { ...pedido, estado: 'PROGRAMADO' },
      dispararEn: ts.valueOf(),
      dispararEnStr: ts.format('DD/MM/YYYY hh:mm A'),
      enviado: false
    };

    console.log(`⏰ Pedido programado ${id} → ${ts.format('DD/MM/YYYY hh:mm A')}`);
    return { ok: true, dispararEn: ts.format('DD/MM/YYYY hh:mm A'), error: null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Cron cada minuto: revisa pedidos programados vencidos y los activa.
 * Llama a activarPedidoProgramado (callback que provee wilBot.js)
 */
function iniciarCronProgramados(activarCallback) {
  cron.schedule('* * * * *', async () => {
    const ahora = Date.now();
    for (const [id, entry] of Object.entries(pedidosProgramados)) {
      if (!entry.enviado && entry.dispararEn <= ahora) {
        entry.enviado = true;
        console.log(`⏰ Disparando pedido programado ${id}`);
        try {
          await activarCallback(id, entry.pedido);
        } catch (e) {
          console.error(`Error activando pedido programado ${id}:`, e.message);
          entry.enviado = false; // retry
        }
      }
    }
  }, { timezone: TZ });
  console.log('⏰ Cron pedidos programados activo (cada minuto)');
}

/**
 * Lista pedidos programados pendientes de un cliente.
 */
function getPedidosProgramadosCliente(clienteId) {
  return Object.entries(pedidosProgramados)
    .filter(([, e]) => e.pedido.clienteId === clienteId && !e.enviado)
    .map(([id, e]) => ({ id, dispararEnStr: e.dispararEnStr, pedido: e.pedido }));
}

/**
 * Cancela un pedido programado.
 */
function cancelarPedidoProgramado(id) {
  if (pedidosProgramados[id]) {
    delete pedidosProgramados[id];
    return true;
  }
  return false;
}

// ══════════════════════════════════════════════════════════════════════════════
// 2. HISTORIAL DEL CLIENTE
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Construye y devuelve el mensaje de historial formateado para un cliente.
 * @param {number} clienteId  - Telegram ID del cliente
 * @param {object} pool       - pool global de pedidos de wilBot
 * @param {Function} getPedidos - función sheets para buscar por clienteId
 */
async function buildHistorialCliente(clienteId, pool, getPedidos) {
  // Buscar en pool primero (pedidos del día)
  const enPool = Object.values(pool)
    .filter(p => p.clienteId === clienteId && p.estado !== 'CANCELADO')
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, 10);

  // Buscar en sheet (historial completo)
  let enSheet = [];
  try {
    enSheet = await getPedidos('FINALIZADO');
    enSheet = enSheet
      .filter(p => String(p.clienteId) === String(clienteId))
      .slice(0, 10);
  } catch (_) {}

  // Mergear sin duplicados
  const ids = new Set(enPool.map(p => p.id));
  const todos = [
    ...enPool,
    ...enSheet.filter(p => !ids.has(p.id))
  ].slice(0, 8);

  if (!todos.length) {
    return `📋 <b>Tu historial</b>\n\n<i>Aún no tienes pedidos registrados.\nHaz tu primer pedido con el menú 🛵</i>`;
  }

  const estadoBadge = e => {
    if (e === 'FINALIZADO' || e === 'ENTREGADO') return '✅';
    if (e === 'EN_PROCESO') return '🔵';
    if (e === 'PENDIENTE')  return '🟡';
    if (e === 'PROGRAMADO') return '⏰';
    return '⚪';
  };

  let msg = `📋 <b>Tus últimos pedidos</b>\n━━━━━━━━━━━━━━━━━━\n\n`;
  todos.forEach((p, i) => {
    const total = p.total ? COP(Number(String(p.total).replace(/\./g,'').replace(/[^0-9]/g,''))) : '—';
    const prods = p.productos
      ? p.productos.split(',').slice(0, 2).map(x => x.trim()).join(', ') + (p.productos.split(',').length > 2 ? '...' : '')
      : '—';
    msg +=
      `${i+1}. ${estadoBadge(p.estado)} <b>${p.id}</b>\n` +
      `   📅 ${p.fecha || p.hora || '—'}  💵 ${total}\n` +
      `   📦 ${prods}\n` +
      `   📍 ${(p.direccionCliente || p.direccion || '—').slice(0, 35)}\n\n`;
  });

  msg += `<i>¿Quieres repetir algún pedido? Toca el botón 👇</i>`;
  return msg;
}

/**
 * Botones de historial — opción de repetir pedidos recientes.
 */
function botonesHistorial(todos) {
  const finalizados = todos.filter(p => p.estado === 'FINALIZADO' || p.estado === 'ENTREGADO').slice(0, 3);
  const btns = finalizados.map(p => {
    const label = `🔄 Repetir ${p.id}`;
    return [Markup.button.callback(label, `repetir_${p.id}`)];
  });
  btns.push([Markup.button.callback('🛵 Nuevo pedido', 'menu_pedido')]);
  return Markup.inlineKeyboard(btns);
}

// ══════════════════════════════════════════════════════════════════════════════
// 3. NEGOCIOS ALIADOS DINÁMICOS
// ══════════════════════════════════════════════════════════════════════════════

// Caché de aliados cargados desde el sheet
let _aliadosCache = null;
let _aliadosCacheTs = 0;
const ALIADOS_TTL = 5 * 60 * 1000; // 5 min

/**
 * Carga aliados desde la hoja "Aliados" del sheet.
 * Columnas esperadas: A=id, B=nombre, C=emoji, D=descripcion, E=activo(SI/NO), F=tienda_key
 * Si la hoja no existe devuelve array vacío (no rompe el bot).
 */
async function getAliados(getSheetFn) {
  const ahora = Date.now();
  if (_aliadosCache && ahora - _aliadosCacheTs < ALIADOS_TTL) return _aliadosCache;

  try {
    const rows = await getSheetFn('Aliados!A2:F50');
    _aliadosCache = (rows || [])
      .filter(r => r[0] && r[4]?.toString().toUpperCase() === 'SI')
      .map(r => ({
        id:          r[0].toString().trim(),
        nombre:      (r[2] || '') + ' ' + (r[1] || ''),
        emoji:       r[2]?.trim() || '🏪',
        descripcion: r[3]?.trim() || '',
        tienda:      r[5]?.trim() || r[0].toString().trim().toUpperCase(),
        activo:      true
      }));
    _aliadosCacheTs = ahora;
    console.log(`🏪 ${_aliadosCache.length} aliados cargados desde sheet`);
  } catch (e) {
    console.warn('getAliados (sheet no disponible):', e.message);
    _aliadosCache = _aliadosCache || [];
  }
  return _aliadosCache;
}

/**
 * Invalida el caché de aliados (llamar cuando el admin modifica el sheet).
 */
function invalidarCacheAliados() {
  _aliadosCache = null;
  _aliadosCacheTs = 0;
}

/**
 * Construye el inline keyboard del menú de pedido incluyendo aliados dinámicos.
 * Siempre incluye WIL, Paquetería. Agrega aliados del sheet.
 */
async function buildMenuPedido(getSheetFn) {
  const aliados = await getAliados(getSheetFn);

  const btns = [
    [Markup.button.callback('🏪 Domicilios WIL (general)', 'neg_wil')],
    [Markup.button.callback('💊 FarmaExpertos Copacabana', 'neg_expertos')],
    [Markup.button.callback('🏥 Farmacia Central Copacabana', 'neg_central')],
  ];

  // Agregar aliados dinámicos del sheet
  aliados.forEach(a => {
    btns.push([Markup.button.callback(a.nombre, `neg_${a.id}`)]);
  });

  btns.push([Markup.button.callback('📦 Paquetería', 'paqueteria')]);
  if (aliados.length > 0) {
    btns.push([Markup.button.callback('🔄 Ver todos los aliados', 'ver_aliados')]);
  }

  return Markup.inlineKeyboard(btns);
}

/**
 * Devuelve el objeto negocio (nombre + tienda) dado un id de aliado dinámico.
 * Primero busca en NEGOCIOS base, luego en aliados del sheet.
 */
async function resolverNegocio(key, getSheetFn) {
  const BASE = {
    wil:      { nombre: '🏪 Domicilios WIL', tienda: null },
    expertos: { nombre: '💊 Farmacia Expertos', tienda: 'EXPERTOS' },
    central:  { nombre: '🏥 Farmacia La Central', tienda: 'CENTRAL' },
  };
  if (BASE[key]) return BASE[key];

  const aliados = await getAliados(getSheetFn);
  const a = aliados.find(x => x.id === key);
  if (a) return { nombre: a.nombre, tienda: a.tienda };

  return { nombre: '🏪 ' + key, tienda: key.toUpperCase() };
}

// ══════════════════════════════════════════════════════════════════════════════
// 4. FOTO DEL DOMICILIARIO
// ══════════════════════════════════════════════════════════════════════════════

// Mapa driverNombre → fileId de la foto de perfil
const fotosDomiciliarios = {};

/**
 * Guarda la foto de perfil de un domiciliario (enviada por él mismo o por admin).
 */
function guardarFotoDomi(nombre, fileId) {
  fotosDomiciliarios[nombre.toLowerCase().trim()] = fileId;
  console.log(`📷 Foto guardada para domiciliario: ${nombre}`);
}

/**
 * Obtiene el fileId de la foto de un domiciliario.
 */
function getFotoDomi(nombre) {
  return fotosDomiciliarios[(nombre || '').toLowerCase().trim()] || null;
}

/**
 * Construye el mensaje de "pedido asignado" para el cliente, con o sin foto.
 * Si hay foto devuelve { tipo: 'foto', fileId, caption } para usar sendPhoto.
 * Si no hay foto devuelve { tipo: 'texto', texto } para usar sendMessage.
 */
function buildMsgPedidoTomadoCliente(p, domiciliario, telDomi, horaTomo) {
  const dirCliente = p.direccionCliente || p.direccion || '—';
  let productosDetalle = p.productos || '—';
  if (p.carrito?.length > 0) {
    productosDetalle = p.carrito.map(i => `• ${i.cantidad}× ${i.descripcion}`).join('\n');
  }

  const texto =
    `🛵 <b>¡Tu pedido fue tomado!</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `👤 <b>${domiciliario}</b>\n` +
    (telDomi ? `📱 <b>${telDomi}</b>\n` : '') +
    `⏰ ${horaTomo}\n\n` +
    `🏪 ${p.negocioNombre || '—'}\n` +
    `📍 ${dirCliente}\n\n` +
    `📦 <b>Productos:</b>\n${productosDetalle}\n\n` +
    `<i>En breve recibirás la factura con el total.</i>`;

  const fotoId = getFotoDomi(domiciliario);
  if (fotoId) {
    return { tipo: 'foto', fileId: fotoId, caption: texto };
  }
  return { tipo: 'texto', texto };
}

/**
 * Envía el mensaje de pedido tomado al cliente (con o sin foto del domi).
 */
async function notificarClientePedidoTomado(bot, clienteId, p, domiciliario, telDomi, horaTomo) {
  if (!clienteId) return;
  const msg = buildMsgPedidoTomadoCliente(p, domiciliario, telDomi, horaTomo);
  try {
    if (msg.tipo === 'foto') {
      await bot.telegram.sendPhoto(clienteId, msg.fileId, { caption: msg.caption, parse_mode: 'HTML' });
    } else {
      await bot.telegram.sendMessage(clienteId, msg.texto, { parse_mode: 'HTML' });
    }
  } catch (e) {
    console.error('notificarClientePedidoTomado:', e.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 5. ENCUESTA POST-ENTREGA MEJORADA
// ══════════════════════════════════════════════════════════════════════════════

// espEncuesta[clienteId] = { pedidoId, estrellas }
const espEncuesta = {};

/**
 * Envía la encuesta de calificación al cliente.
 * Paso 1: botones de estrellas
 */
async function enviarEncuestaPostEntrega(bot, clienteId, pedidoId) {
  try {
    await bot.telegram.sendMessage(clienteId,
      `🛵 <b>¡Tu pedido fue entregado!</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `<i>Gracias por confiar en Domicilios WIL ❤️</i>\n\n` +
      `⭐ <b>¿Cómo calificarías el servicio?</b>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[
          Markup.button.callback('1⭐', `encuesta_${pedidoId}_1`),
          Markup.button.callback('2⭐', `encuesta_${pedidoId}_2`),
          Markup.button.callback('3⭐', `encuesta_${pedidoId}_3`),
          Markup.button.callback('4⭐', `encuesta_${pedidoId}_4`),
          Markup.button.callback('5⭐', `encuesta_${pedidoId}_5`),
        ]])
      }
    );
  } catch (e) { console.error('enviarEncuestaPostEntrega:', e.message); }
}

/**
 * Registra las acciones de la encuesta en el bot.
 * Paso 2: pregunta de categoría
 * Paso 3: mensaje de agradecimiento
 */
function registrarEncuesta(bot, guardarCalificacionFn, ADMIN_IDS, CANAL_PEDIDOS_ID, pool) {
  // Paso 1 → Paso 2: recibe estrellas, pregunta categoría
  bot.action(/^encuesta_(.+)_(\d)$/, async ctx => {
    const pedidoId = ctx.match[1];
    const estrellas = parseInt(ctx.match[2]);
    const uid = ctx.from.id;
    await ctx.answerCbQuery('⭐ ¡Gracias!');

    try {
      await ctx.editMessageText(
        `${'⭐'.repeat(estrellas)} <b>${estrellas}/5</b>\n\n` +
        `💬 <b>¿Qué podemos mejorar?</b>\n<i>Elige la categoría más importante:</i>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('⚡ Velocidad de entrega', `mejora_${pedidoId}_velocidad`)],
            [Markup.button.callback('😊 Trato del domiciliario', `mejora_${pedidoId}_trato`)],
            [Markup.button.callback('📦 Estado del pedido', `mejora_${pedidoId}_empaque`)],
            [Markup.button.callback('💵 Precio justo', `mejora_${pedidoId}_precio`)],
            [Markup.button.callback('✅ Todo estuvo perfecto', `mejora_${pedidoId}_perfecto`)],
          ])
        }
      );
    } catch (_) {}

    espEncuesta[uid] = { pedidoId, estrellas };
  });

  // Paso 2 → Paso 3: recibe categoría, agradece
  bot.action(/^mejora_(.+)_(velocidad|trato|empaque|precio|perfecto)$/, async ctx => {
    const pedidoId = ctx.match[1];
    const categoria = ctx.match[2];
    const uid = ctx.from.id;
    await ctx.answerCbQuery('✅ ¡Registrado!');

    const datos = espEncuesta[uid] || {};
    const estrellas = datos.estrellas || 5;
    delete espEncuesta[uid];

    const etiquetas = {
      velocidad: '⚡ Velocidad',
      trato:     '😊 Trato',
      empaque:   '📦 Estado del pedido',
      precio:    '💵 Precio',
      perfecto:  '✅ Todo perfecto'
    };

    const respuestas = {
      velocidad: 'Trabajamos para ser cada vez más rápidos 🚀',
      trato:     'Le transmitiremos tu opinión al domiciliario 🛵',
      empaque:   'Cuidaremos más el estado de tu pedido 📦',
      precio:    'Buscamos siempre ofrecerte el mejor valor 💵',
      perfecto:  '¡Eso nos alegra! Tu satisfacción es nuestra motivación 🎉'
    };

    try {
      await ctx.editMessageText(
        `${'⭐'.repeat(estrellas)} <b>${estrellas}/5</b>  ·  ${etiquetas[categoria]}\n\n` +
        `<b>¡Gracias por tu opinión!</b>\n${respuestas[categoria]}\n\n` +
        `<i>Tu feedback nos ayuda a mejorar el servicio. 🛵❤️</i>`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
      );
    } catch (_) {}

    // Guardar en sheet
    await guardarCalificacionFn(pedidoId, estrellas, categoria).catch(e => console.error('guardarCalificacion:', e.message));

    // Notificar admin y canal con detalles
    const p = pool[pedidoId];
    const msgCal =
      `${'⭐'.repeat(estrellas)} <b>Calificación — ${pedidoId}</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      (p?.domiciliario ? `🛵 ${p.domiciliario}\n` : '') +
      (p?.cliente      ? `👤 ${p.cliente}\n`      : '') +
      `⭐ <b>${estrellas}/5</b>  ·  ${etiquetas[categoria]}`;

    if (CANAL_PEDIDOS_ID) {
      bot.telegram.sendMessage(CANAL_PEDIDOS_ID, msgCal, { parse_mode: 'HTML' }).catch(() => {});
    }
    for (const adminId of ADMIN_IDS) {
      bot.telegram.sendMessage(adminId, msgCal, { parse_mode: 'HTML' }).catch(() => {});
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// 6. ETA EN TIEMPO REAL
// ══════════════════════════════════════════════════════════════════════════════

// Mapa pedidoId → { clienteId, msgId, chatId, etaTs, ultimoUpdate }
const etaActivos = {};

const VELOCIDAD_KMH = 30; // velocidad promedio domi en ciudad
const METROS_POR_MIN = (VELOCIDAD_KMH * 1000) / 60;

/**
 * Distancia Haversine en metros entre dos puntos.
 */
function haversineMetros(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

/**
 * Formatea minutos como "X min" o "Ahora".
 */
function fmtMins(mins) {
  if (mins <= 1) return 'Ahora 🟢';
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins/60)}h ${mins%60}min`;
}

/**
 * Activa el tracker ETA para un pedido.
 * Envía mensaje inicial al cliente y guarda el msgId para editarlo.
 */
async function activarETA(bot, clienteId, pedidoId, domiLat, domiLng, clienteLat, clienteLng) {
  if (!clienteId || !clienteLat || !clienteLng) return;

  const metros = haversineMetros(domiLat || 0, domiLng || 0, clienteLat, clienteLng);
  const distKm = (metros * 1.35 / 1000).toFixed(1); // factor ruta real
  const mins = Math.max(2, Math.round((metros * 1.35) / METROS_POR_MIN));

  const texto =
    `🛵 <b>Tu domiciliario está en camino</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `⏱ Tiempo estimado: <b>${fmtMins(mins)}</b>\n` +
    `📍 Distancia aprox: <b>${distKm} km</b>\n` +
    `<i>Actualización automática con GPS del domiciliario</i>`;

  try {
    const sent = await bot.telegram.sendMessage(clienteId, texto, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('📍 Ver en mapa', `eta_mapa_${pedidoId}`)]])
    });
    etaActivos[pedidoId] = {
      clienteId, chatId: clienteId,
      msgId: sent.message_id,
      clienteLat, clienteLng,
      ultimoUpdate: Date.now(),
      minsAnterior: mins
    };
    console.log(`📡 ETA activado para pedido ${pedidoId} — ${mins} min`);
  } catch (e) { console.error('activarETA:', e.message); }
}

/**
 * Actualiza el mensaje ETA del cliente cuando el domi mueve su GPS.
 * Solo actualiza si cambió más de 1 minuto la estimación.
 */
async function actualizarETA(bot, pedidoId, domiLat, domiLng) {
  const eta = etaActivos[pedidoId];
  if (!eta) return;

  const ahora = Date.now();
  if (ahora - eta.ultimoUpdate < 30000) return; // throttle 30 seg

  const metros = haversineMetros(domiLat, domiLng, eta.clienteLat, eta.clienteLng);
  const distKm = (metros * 1.35 / 1000).toFixed(1);
  const mins = Math.max(0, Math.round((metros * 1.35) / METROS_POR_MIN));

  if (Math.abs(mins - eta.minsAnterior) < 1) return; // sin cambio significativo

  const texto =
    `🛵 <b>Tu domiciliario está en camino</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `⏱ Tiempo estimado: <b>${fmtMins(mins)}</b>\n` +
    `📍 Distancia aprox: <b>${distKm} km</b>\n` +
    `🕐 Actualizado: <i>${ahoraBog().format('hh:mm A')}</i>`;

  try {
    await bot.telegram.editMessageText(eta.chatId, eta.msgId, null, texto, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('📍 Ver en mapa', `eta_mapa_${pedidoId}`)]])
    });
    eta.ultimoUpdate = ahora;
    eta.minsAnterior = mins;
    console.log(`📡 ETA actualizado ${pedidoId}: ${mins} min`);
  } catch (e) {
    // Si el mensaje fue eliminado o editado por el usuario, desactivar tracker
    if (e.message?.includes('message to edit not found') || e.message?.includes('message is not modified')) {
      delete etaActivos[pedidoId];
    }
  }
}

/**
 * Desactiva el tracker ETA cuando el pedido es entregado.
 */
async function desactivarETA(bot, pedidoId) {
  const eta = etaActivos[pedidoId];
  if (!eta) return;
  try {
    await bot.telegram.editMessageText(eta.chatId, eta.msgId, null,
      `✅ <b>¡Tu domiciliario llegó!</b>\n<i>Pedido entregado exitosamente 🛵❤️</i>`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
    );
  } catch (_) {}
  delete etaActivos[pedidoId];
}

/**
 * Registra el action del botón "Ver en mapa" del ETA.
 */
function registrarETA(bot) {
  bot.action(/^eta_mapa_(.+)$/, async ctx => {
    const pedidoId = ctx.match[1];
    await ctx.answerCbQuery();
    const eta = etaActivos[pedidoId];
    if (!eta) return ctx.answerCbQuery('Pedido ya entregado', true);
    // El mapa se abre en Google Maps con la ubicación del cliente
    const gmapsUrl = `https://www.google.com/maps?q=${eta.clienteLat},${eta.clienteLng}`;
    return ctx.reply(
      `📍 <b>Ubicación de entrega</b>\n${gmapsUrl}`,
      { parse_mode: 'HTML', disable_web_page_preview: false }
    );
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// 7. TURNO DEL DOMICILIARIO
// ══════════════════════════════════════════════════════════════════════════════

// turnos[uid] = 'manana' | 'tarde' | 'noche' | 'completo'
const turnos = {};

const TURNOS = {
  manana:   { label: '☀️ Mañana',  inicio: 6,  fin: 13 },
  tarde:    { label: '🌤 Tarde',   inicio: 13, fin: 20 },
  noche:    { label: '🌙 Noche',  inicio: 20, fin: 24 },
  completo: { label: '🔁 Completo', inicio: 0,  fin: 24 },
};

/**
 * Devuelve true si el domi con ese uid debería recibir alertas ahora según su turno.
 */
function estaEnTurno(uid) {
  const turno = turnos[uid];
  if (!turno || turno === 'completo') return true; // sin turno asignado = siempre activo
  const horaActual = ahoraBog().hours();
  const { inicio, fin } = TURNOS[turno] || TURNOS.completo;
  return horaActual >= inicio && horaActual < fin;
}

/**
 * Guarda el turno elegido por el domi.
 */
function setTurno(uid, turno) {
  if (TURNOS[turno]) {
    turnos[uid] = turno;
    console.log(`🕐 Turno ${turno} asignado a driver ${uid}`);
    return true;
  }
  return false;
}

/**
 * Construye el inline keyboard para elegir turno.
 */
function keyboardTurno() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('☀️ Mañana  (6am – 1pm)',  'turno_manana')],
    [Markup.button.callback('🌤 Tarde   (1pm – 8pm)',  'turno_tarde')],
    [Markup.button.callback('🌙 Noche   (8pm – 12am)', 'turno_noche')],
    [Markup.button.callback('🔁 Turno completo',       'turno_completo')],
  ]);
}

/**
 * Registra los actions de turno en el bot.
 */
function registrarTurnos(bot, drivers) {
  bot.action(/^turno_(manana|tarde|noche|completo)$/, async ctx => {
    const uid = ctx.from.id;
    const turno = ctx.match[1];
    await ctx.answerCbQuery();

    if (!drivers[uid]) return ctx.reply('❌ Debes iniciar sesión primero.');

    setTurno(uid, turno);
    const t = TURNOS[turno];

    try {
      await ctx.editMessageText(
        `✅ <b>Turno configurado: ${t.label}</b>\n\n` +
        `🕐 Recibirás alertas de pedidos entre <b>${t.inicio}:00 y ${t.fin}:00</b>\n\n` +
        `<i>Puedes cambiar tu turno en cualquier momento desde el menú.</i>`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
      );
    } catch (_) {}
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// INTEGRACIÓN CON wilBot.js
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Función principal de integración.
 * Llama esto desde wilBot.js después de crear el bot:
 *
 *   const features = require('./features');
 *   features.integrar(bot, { pool, drivers, ADMIN_IDS, getPedidos, guardarCalificacion, getSheetRows });
 *
 * @param {object} bot        - instancia Telegraf
 * @param {object} opts
 *   - pool               : objeto pool global de pedidos
 *   - drivers            : objeto drivers de sesiones activas
 *   - ADMIN_IDS          : array de IDs admin
 *   - getPedidos         : función (estado) → pedidos del sheet
 *   - guardarCalificacion: función (id, estrellas, categoria) del sheet
 *   - getSheetRows       : función (rango) → rows[][] del sheet (para aliados)
 *   - registrarPedido    : función del sheet para guardar pedido
 *   - activarPedidoFn    : función (id, pedido) que activa el pedido en el bot
 */
function integrar(bot, opts) {
  const {
    pool, drivers, ADMIN_IDS,
    getPedidos, guardarCalificacion,
    getSheetRows, registrarPedido,
    activarPedidoFn
  } = opts;

  const CANAL = process.env.CANAL_PEDIDOS_ID;

  // ── Encuesta mejorada ──────────────────────────────────────────────────────
  registrarEncuesta(bot, guardarCalificacion, ADMIN_IDS, CANAL, pool);

  // ── ETA botón mapa ─────────────────────────────────────────────────────────
  registrarETA(bot);

  // ── Turnos ─────────────────────────────────────────────────────────────────
  registrarTurnos(bot, drivers);

  // ── Foto del domiciliario: el domi envía una foto con caption "mi foto" ────
  bot.on('photo', async (ctx, next) => {
    const uid = ctx.from.id;
    const caption = (ctx.message.caption || '').toLowerCase().trim();
    if (drivers[uid] && (caption === 'mi foto' || caption === 'foto perfil')) {
      const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
      guardarFotoDomi(drivers[uid].nombre, fileId);
      return ctx.reply(
        `✅ <b>¡Foto guardada!</b>\n` +
        `Ahora los clientes verán tu foto cuando tomes un pedido. 📷`,
        { parse_mode: 'HTML' }
      );
    }
    return next(); // continuar al handler photo de wilBot.js
  });

  // ── Historial del cliente ──────────────────────────────────────────────────
  bot.hears(/mis pedidos|historial|mis órdenes/i, async ctx => {
    const uid = ctx.from.id;
    if (drivers[uid]) return; // domi usa su propio panel
    const msg = await buildHistorialCliente(uid, pool, getPedidos);
    // Obtener pedidos para los botones
    const enPool = Object.values(pool)
      .filter(p => p.clienteId === uid && (p.estado === 'FINALIZADO' || p.estado === 'ENTREGADO'))
      .slice(0, 3);
    return ctx.reply(msg, { parse_mode: 'HTML', ...botonesHistorial(enPool) });
  });

  // ── Repetir pedido ─────────────────────────────────────────────────────────
  bot.action(/^repetir_(.+)$/, async ctx => {
    const pedidoId = ctx.match[1];
    const uid = ctx.from.id;
    await ctx.answerCbQuery();
    const pedidoOriginal = pool[pedidoId];
    if (!pedidoOriginal?.carrito?.length) {
      return ctx.reply('❌ No se pudo recuperar ese pedido. Haz uno nuevo con el menú 🛵');
    }
    const prods = pedidoOriginal.carrito.map(i => `• ${i.cantidad}× ${i.descripcion}`).join('\n');
    return ctx.reply(
      `🔄 <b>Repetir pedido ${pedidoId}</b>\n━━━━━━━━━━━━━━━━━━\n${prods}\n━━━━━━━━━━━━━━━━━━\n\n¿Confirmas el pedido?`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Sí, repetir', `confirmar_repetir_${pedidoId}`)],
          [Markup.button.callback('❌ No, cancelar', 'menu_pedido')],
        ])
      }
    );
  });

  bot.action(/^confirmar_repetir_(.+)$/, async ctx => {
    const pedidoId = ctx.match[1];
    const uid = ctx.from.id;
    await ctx.answerCbQuery('🔄 Procesando...');
    const p = pool[pedidoId];
    if (!p) return ctx.reply('❌ Pedido no encontrado. Haz uno nuevo.');
    try {
      await ctx.editMessageText(`⏳ <b>Registrando tu pedido...</b>`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
    } catch (_) {}
    // El pedido repetido usa los mismos datos pero nuevo ID
    // Para registro completo, el llamador debe tener registrarPedido
    if (registrarPedido) {
      try {
        const nuevoId = await registrarPedido({
          nombre: p.cliente, telefono: p.telefono, metodoPago: p.metodoPago || 'EFECTIVO',
          imagenFileId: '', carrito: p.carrito,
          negocioNombre: p.negocioNombre, tienda: p.tienda,
          direccion: p.direccionCliente || p.direccion,
          precioDomicilio: p.precioDomicilio || 0,
          totalFinal: 0, presupuesto: null
        });
        pool[nuevoId] = {
          ...p, id: nuevoId,
          estado: 'PENDIENTE',
          clienteId: uid,
          hora: ahoraBog().format('hh:mm A'),
          createdAt: Date.now()
        };
        return ctx.reply(
          `✅ <b>¡Pedido repetido!</b>\n🆔 <b>${nuevoId}</b>\n\n<i>Un domiciliario lo tomará pronto. 🛵</i>`,
          { parse_mode: 'HTML' }
        );
      } catch (e) {
        return ctx.reply(`❌ Error al registrar: ${e.message}`);
      }
    }
    return ctx.reply('❌ Función de registro no disponible. Haz un nuevo pedido.');
  });

  // ── Pedidos programados: el cliente escribe "programar" ───────────────────
  bot.hears(/programar|agendar|para mañana|para el/i, async ctx => {
    const uid = ctx.from.id;
    if (drivers[uid]) return;
    return ctx.reply(
      `⏰ <b>Pedido Programado</b>\n━━━━━━━━━━━━━━━━━━\n\n` +
      `Puedes agendar tu pedido para que sea atendido a una hora específica.\n\n` +
      `Primero haz tu pedido normalmente con el menú 🛵,\n` +
      `y al confirmar elige la opción <b>"⏰ Programar para más tarde"</b>.\n\n` +
      `<i>Disponible para hoy o mañana.</i>`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🛵 Hacer pedido ahora', 'menu_pedido')]]) }
    );
  });

  // ── Turno: el domi escribe "mi turno" ─────────────────────────────────────
  bot.hears(/mi turno|cambiar turno|turno/i, async ctx => {
    const uid = ctx.from.id;
    if (!drivers[uid]) return;
    const turnoActual = turnos[uid];
    const label = turnoActual ? TURNOS[turnoActual]?.label : 'Sin definir';
    return ctx.reply(
      `🕐 <b>Configurar turno</b>\n━━━━━━━━━━━━━━━━━━\n` +
      `Turno actual: <b>${label}</b>\n\n` +
      `Solo recibirás alertas de pedidos durante tu turno.\n` +
      `Elige el horario de hoy:`,
      { parse_mode: 'HTML', ...keyboardTurno() }
    );
  });

  // ── Ver todos los aliados ─────────────────────────────────────────────────
  bot.action('ver_aliados', async ctx => {
    await ctx.answerCbQuery();
    const aliados = getSheetRows ? await getAliados(getSheetRows) : [];
    if (!aliados.length) return ctx.reply('ℹ️ No hay aliados adicionales configurados todavía.');
    let msg = `🤝 <b>Aliados WIL</b>\n━━━━━━━━━━━━━━━━━━\n\n`;
    aliados.forEach(a => {
      msg += `${a.emoji} <b>${a.nombre}</b>\n`;
      if (a.descripcion) msg += `   <i>${a.descripcion}</i>\n`;
      msg += '\n';
    });
    return ctx.reply(msg, { parse_mode: 'HTML' });
  });

  console.log('✅ features.js integrado: pedidos programados, historial, aliados, foto domi, encuesta, ETA, turnos');
}

// ══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ══════════════════════════════════════════════════════════════════════════════
module.exports = {
  // Pedidos programados
  agendarPedido,
  iniciarCronProgramados,
  getPedidosProgramadosCliente,
  cancelarPedidoProgramado,
  pedidosProgramados,

  // Historial
  buildHistorialCliente,

  // Aliados dinámicos
  getAliados,
  buildMenuPedido,
  resolverNegocio,
  invalidarCacheAliados,

  // Foto domiciliario
  guardarFotoDomi,
  getFotoDomi,
  notificarClientePedidoTomado,

  // Encuesta mejorada
  enviarEncuestaPostEntrega,
  registrarEncuesta,

  // ETA
  activarETA,
  actualizarETA,
  desactivarETA,
  haversineMetros,

  // Turnos
  estaEnTurno,
  setTurno,
  keyboardTurno,
  registrarTurnos,
  turnos,

  // Integración completa
  integrar,
};