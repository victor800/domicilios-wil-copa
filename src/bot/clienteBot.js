const { Telegraf, Markup } = require('telegraf');
const { registrarPedido, buscarProductos, fmt } = require('../services/sheets');
const { obtenerPrecio, tarifasTexto } = require('../data/tarifas');

const bot = new Telegraf(process.env.BOT_CLIENTE_TOKEN);

// ── Sesiones en memoria ──────────────────────────────────────────────────────
const S = {};  // { userId: sesion }

const NEGOCIOS = {
  wil:      { nombre: '🏪 Domicilios WIL',     tienda: null },
  expertos: { nombre: '💊 Farmacia Expertos',   tienda: 'EXPERTOS' },
  central:  { nombre: '🏥 Farmacia La Central', tienda: 'CENTRAL' }
};

// ── Renderizar resumen de pedido siempre visible ─────────────────────────────
function renderPedido(s) {
  if (!s) return '';
  const subtotal = (s.carrito||[]).reduce((a,i) => a+i.subtotal, 0);
  const total    = subtotal + (s.precioDomicilio||0);
  let txt =
    `╔═══════════════════════╗\n` +
    `║   🛒  TU PEDIDO WIL   ║\n` +
    `╚═══════════════════════╝\n` +
    `🏪 ${s.negocioNombre||'?'}\n` +
    `👤 ${s.nombre||'—'}  📱 ${s.telefono||'—'}\n` +
    `📍 ${s.direccion||'—'}\n\n`;

  if (s.carrito?.length > 0) {
    txt += `📦 *Productos:*\n`;
    s.carrito.forEach((item,i) => {
      txt += `  ${i+1}. ${item.descripcion}\n`;
      txt += `     ${item.cantidad} × $${fmt(item.precioUnitario)} = *$${fmt(item.subtotal)}*\n`;
    });
    txt += `\n`;
  }

  txt += `━━━━━━━━━━━━━━━━━━━━━\n`;
  if (subtotal > 0) txt += `🧾 Productos:  $${fmt(subtotal)}\n`;
  txt += `🛵 Domicilio: $${s.precioDomicilio ? fmt(s.precioDomicilio) : 'Por confirmar'}\n`;
  if (subtotal > 0 || s.precioDomicilio) {
    txt += `💵 *TOTAL: $${fmt(total)}*\n`;
  }
  txt += `━━━━━━━━━━━━━━━━━━━━━`;
  return txt;
}

// ── /start ───────────────────────────────────────────────────────────────────
bot.start(async ctx => {
  delete S[ctx.from.id];
  return ctx.reply(
    `🛵 *¡Bienvenido a Domicilios WIL!*\n📍 Copacabana, Antioquia 🇨🇴\n\n¿De dónde quieres pedir?`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🏪 Domicilios WIL (general)', 'neg_wil')],
        [Markup.button.callback('💊 Farmacia Expertos',        'neg_expertos')],
        [Markup.button.callback('🏥 Farmacia La Central',     'neg_central')],
        [Markup.button.callback('💲 Ver tarifas',             'tarifas')]
      ])
    }
  );
});

bot.command('cancelar', ctx => {
  delete S[ctx.from.id];
  return ctx.reply('❌ Pedido cancelado.', {
    ...Markup.inlineKeyboard([[Markup.button.callback('🔄 Nuevo pedido', 'nuevo_pedido')]])
  });
});

bot.action('nuevo_pedido', async ctx => {
  await ctx.answerCbQuery();
  delete S[ctx.from.id];
  return ctx.editMessageText(
    `¿De dónde quieres pedir?`,
    Markup.inlineKeyboard([
      [Markup.button.callback('🏪 Domicilios WIL (general)', 'neg_wil')],
      [Markup.button.callback('💊 Farmacia Expertos',        'neg_expertos')],
      [Markup.button.callback('🏥 Farmacia La Central',     'neg_central')]
    ])
  );
});

bot.action('tarifas', async ctx => {
  await ctx.answerCbQuery();
  return ctx.reply(tarifasTexto(), {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('🛵 Hacer pedido', 'nuevo_pedido')]])
  });
});

// ── Seleccionar negocio ───────────────────────────────────────────────────────
bot.action(/^neg_(.+)$/, async ctx => {
  const key = ctx.match[1];
  await ctx.answerCbQuery();
  S[ctx.from.id] = { negocio: key, negocioNombre: NEGOCIOS[key].nombre, tienda: NEGOCIOS[key].tienda, carrito: [], paso: 'nombre' };
  return ctx.reply(
    renderPedido(S[ctx.from.id]) + `\n\n✏️ ¿Cuál es tu *nombre completo*?`,
    { parse_mode: 'Markdown' }
  );
});

// ── Captura de texto ─────────────────────────────────────────────────────────
bot.on('text', async ctx => {
  const uid = ctx.from.id;
  const s   = S[uid];
  const txt = ctx.message.text.trim();
  if (!s || txt.startsWith('/')) return;

  switch(s.paso) {

    case 'nombre':
      s.nombre = txt;
      s.paso   = 'telefono';
      return ctx.reply(
        renderPedido(s) + `\n\n📱 ¿Cuál es tu *teléfono*?`,
        { parse_mode: 'Markdown' }
      );

    case 'telefono':
      s.telefono = txt;
      s.paso     = 'direccion';
      return ctx.reply(
        renderPedido(s) + `\n\n📍 ¿Dirección de entrega? _(incluye el barrio)_\n_Ej: Cra 50 #30-10, Barrio Asunción_`,
        { parse_mode: 'Markdown' }
      );

    case 'direccion': {
      s.direccion       = txt;
      s.precioDomicilio = obtenerPrecio(txt);
      const msgZona     = s.precioDomicilio
        ? `✅ Zona detectada — Domicilio: *$${fmt(s.precioDomicilio)}*`
        : `⚠️ Zona no reconocida — precio se confirma`;

      if (s.negocio === 'wil') {
        s.paso = 'pedido_libre';
        return ctx.reply(
          renderPedido(s) + `\n\n${msgZona}\n\n📦 ¿Qué necesitas? _(describe todo lo que quieres)_`,
          { parse_mode: 'Markdown' }
        );
      }
      s.paso = 'buscar';
      return ctx.reply(
        renderPedido(s) + `\n\n${msgZona}\n\n🔍 Escribe el nombre del producto que buscas:`,
        { parse_mode: 'Markdown' }
      );
    }

    case 'pedido_libre':
      s.carrito = [{ descripcion: txt, cantidad: 1, precioUnitario: 0, subtotal: 0 }];
      s.paso    = 'pago';
      return ctx.reply(
        renderPedido(s) + `\n\n💳 ¿Cómo vas a pagar?`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('💵 Efectivo',        'pago_EFECTIVO')],
            [Markup.button.callback('📲 Nequi/Daviplata', 'pago_NEQUI')],
            [Markup.button.callback('🏦 Transferencia',   'pago_TRANSFERENCIA')]
          ])
        }
      );

    case 'buscar': {
      if (txt.length < 2) return ctx.reply('🔍 Escribe al menos 2 letras...');
      const cargando = await ctx.reply(`⏳ Buscando *"${txt}"*...`, { parse_mode: 'Markdown' });
      const res      = await buscarProductos(txt, s.tienda);

      if (res.length === 0) {
        return ctx.reply(
          `😕 No encontré *"${txt}"*.\n\nIntenta con otro nombre o abreviación:`,
          { parse_mode: 'Markdown' }
        );
      }

      s.busqueda = res;
      const bots = res.map((p, i) => [
        Markup.button.callback(
          `${p.descripcion.substring(0,32)} · $${fmt(p.precioUnitario||p.precio)}`,
          `prod_${i}`
        )
      ]);
      bots.push([Markup.button.callback('🔍 Buscar otro', 'buscar_otro')]);

      return ctx.reply(
        `💊 *${res.length}* resultado(s) para *"${txt}"*:\n_Toca el que necesitas:_`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard(bots) }
      );
    }

    case 'cantidad': {
      const n = parseInt(txt);
      if (isNaN(n) || n <= 0) return ctx.reply('❌ Ingresa un número válido:');
      const p   = s.prodSeleccionado;
      const pu  = p.precioUnitario || p.precio || 0;
      s.carrito.push({ descripcion: p.descripcion, laboratorio: p.laboratorio, unidad: p.unidad, cantidad: n, precioUnitario: pu, subtotal: pu*n });
      s.paso = 'buscar';
      return ctx.reply(
        renderPedido(s) + `\n\n✅ *Agregado al carrito*\n\n¿Qué más necesitas?`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('➕ Agregar otro producto',  'buscar_otro')],
            [Markup.button.callback('✅ Finalizar pedido',       'finalizar')],
            [Markup.button.callback('🗑️ Vaciar carrito',         'vaciar')]
          ])
        }
      );
    }
  }
});

// ── Seleccionar producto del resultado ────────────────────────────────────────
bot.action(/^prod_(\d+)$/, async ctx => {
  const uid = ctx.from.id;
  const s   = S[uid];
  await ctx.answerCbQuery();
  if (!s?.busqueda?.[ctx.match[1]]) return ctx.reply('❌ Busca de nuevo.');
  s.prodSeleccionado = s.busqueda[parseInt(ctx.match[1])];
  s.paso = 'cantidad';
  const p  = s.prodSeleccionado;
  const pu = p.precioUnitario || p.precio || 0;
  return ctx.reply(
    `💊 *${p.descripcion}*\n🏭 ${p.laboratorio||'—'}\n📦 ${p.unidad||'Unidad'}\n💰 *$${fmt(pu)}* c/u\n\n¿Cuántas unidades?`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('buscar_otro', async ctx => {
  const s = S[ctx.from.id];
  await ctx.answerCbQuery();
  if (!s) return;
  s.paso = 'buscar';
  return ctx.reply('🔍 Escribe el nombre del producto:');
});

bot.action('vaciar', async ctx => {
  const s = S[ctx.from.id];
  await ctx.answerCbQuery('🗑️ Vaciado');
  if (!s) return;
  s.carrito = [];
  s.paso    = 'buscar';
  return ctx.reply(renderPedido(s) + '\n\n🔍 Busca un producto:', { parse_mode: 'Markdown' });
});

bot.action('finalizar', async ctx => {
  const s = S[ctx.from.id];
  await ctx.answerCbQuery();
  if (!s?.carrito?.length) return ctx.reply('❌ Tu carrito está vacío.');
  s.paso = 'pago';
  return ctx.reply(
    renderPedido(s) + `\n\n💳 ¿Cómo vas a pagar?`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('💵 Efectivo',        'pago_EFECTIVO')],
        [Markup.button.callback('📲 Nequi/Daviplata', 'pago_NEQUI')],
        [Markup.button.callback('🏦 Transferencia',   'pago_TRANSFERENCIA')]
      ])
    }
  );
});

// ── Método de pago ────────────────────────────────────────────────────────────
bot.action(/^pago_(.+)$/, async ctx => {
  const s = S[ctx.from.id];
  await ctx.answerCbQuery();
  if (!s) return;
  s.metodoPago = ctx.match[1];
  if (s.metodoPago !== 'EFECTIVO') {
    s.paso = 'comprobante';
    return ctx.reply('📸 Envía la *foto del comprobante* (Nequi, Bancolombia, etc.):', { parse_mode: 'Markdown' });
  }
  await procesarPedido(ctx, ctx.from.id);
});

bot.on('photo', async ctx => {
  const s = S[ctx.from.id];
  if (!s || s.paso !== 'comprobante') return;
  s.imagenFileId = ctx.message.photo[ctx.message.photo.length-1].file_id;
  await procesarPedido(ctx, ctx.from.id);
});

// ── Procesar y guardar pedido ─────────────────────────────────────────────────
async function procesarPedido(ctx, uid) {
  const s          = S[uid];
  const subtotal   = s.carrito.reduce((a,i)=>a+i.subtotal, 0);
  const totalFinal = subtotal + (s.precioDomicilio||0);

  const id = await registrarPedido({
    nombre: s.nombre, telefono: s.telefono, metodoPago: s.metodoPago,
    imagenFileId: s.imagenFileId||'', carrito: s.carrito,
    negocioNombre: s.negocioNombre, direccion: s.direccion,
    precioDomicilio: s.precioDomicilio||0, totalFinal
  });

  // Confirmación visible para el cliente con todo el resumen
  await ctx.reply(
    `✅ *¡PEDIDO CONFIRMADO!*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    renderPedido({...s, carrito: s.carrito}) +
    `\n\n🆔 ID: *${id}*\n💳 Pago: ${s.metodoPago}\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `_🛵 En breve un domiciliario tomará tu pedido._\n` +
    `_Escribe /cancelar si necesitas cancelar._`,
    { parse_mode: 'Markdown' }
  );

  // Notificar canal
  try {
    await ctx.telegram.sendMessage(
      process.env.CANAL_PEDIDOS_ID,
      `🔔 *NUEVO PEDIDO — ${id}*\n🏪 ${s.negocioNombre}\n` +
      `👤 ${s.nombre}  📱 ${s.telefono}\n📍 ${s.direccion}\n` +
      `📦 ${s.carrito.map(i=>`${i.cantidad}x ${i.descripcion}`).join(', ')}\n` +
      `💰 Total: *$${fmt(totalFinal)}*`,
      { parse_mode: 'Markdown' }
    );
  } catch(e) { console.error('canal:', e.message); }

  // Al pool de domiciliarios
  const { agregarPedido } = require('./domiciliarioBot');
  agregarPedido({ id, negocioNombre:s.negocioNombre, cliente:s.nombre, telefono:s.telefono,
    direccion:s.direccion, productos:s.carrito.map(i=>`${i.cantidad}x ${i.descripcion}`).join(', '),
    total:totalFinal, precioDomicilio:s.precioDomicilio||0 });

  delete S[uid];
}

module.exports = { clienteBot: bot };