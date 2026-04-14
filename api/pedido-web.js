// api/pedido-web.js
// Endpoint Vercel — recibe pedidos del bot HTML web
// Replica exactamente lo que hace procesarPedido() en wilBot.js
// ─────────────────────────────────────────────────────────────
// POST /api/pedido-web
// Body JSON: { nombre, telefono, direccion, barrioDetectado,
//              negocioNombre, tienda, carrito, precioDomicilio,
//              metodoPago, presupuesto?, latCliente?, lngCliente? }
// ─────────────────────────────────────────────────────────────

const { registrarPedido } = require('../services/sheets');

// ── Telegram sendMessage sin importar Telegraf completo ───────
async function tgSend(chatId, text, extra = {}) {
  const token = process.env.BOT_TOKEN;
  if (!token || !chatId) return;
  try {
    const body = { chat_id: chatId, text, parse_mode: 'HTML', ...extra };
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`tgSend a ${chatId}:`, err);
    }
  } catch (e) {
    console.error('tgSend error:', e.message);
  }
}

function COP(n) {
  if (!n) return '$0';
  return '$' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function gmapsLink(dir) {
  return 'https://www.google.com/maps/search/?api=1&query=' +
    encodeURIComponent((dir || '') + ', Antioquia, Colombia');
}

// ── Obtener drivers activos desde variable de entorno ─────────
// Formato en .env: DRIVERS_TELEGRAM_IDS=123456,789012,...
// Esto es una lista estática de respaldo.
// En producción, el pool en memoria del bot ya notifica —
// este endpoint es el fallback para pedidos que llegan del HTML.
function getDriverIds() {
  const raw = process.env.DRIVERS_TELEGRAM_IDS || '';
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function getAdminIds() {
  const raw = process.env.ADMIN_TELEGRAM_IDS || '';
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

// ── CORS ──────────────────────────────────────────────────────
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ═════════════════════════════════════════════════════════════
module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  try {
    const {
      nombre, telefono, direccion,
      barrioDetectado, zona, municipio,
      negocioNombre, tienda,
      carrito = [],
      precioDomicilio = 0,
      metodoPago = 'EFECTIVO',
      presupuesto,
      latCliente, lngCliente,
      referencia,
    } = req.body;

    // ── Validación básica ─────────────────────────────────────
    if (!nombre || !telefono || !direccion || !carrito.length) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    const sub = carrito.reduce((a, i) => a + (i.subtotal || 0), 0);
    const dom = Number(precioDomicilio) || 0;
    // Si tiene tienda (farmacia) hay precio real; WIL es 0 hasta la factura
    const totalFinal = tienda ? sub + dom : 0;

    // ── 1. Guardar en Google Sheets ───────────────────────────
    const id = await registrarPedido({
      nombre,
      telefono,
      metodoPago,
      imagenFileId: '',
      carrito,
      negocioNombre: negocioNombre || 'Domicilios WIL',
      tienda: tienda || null,
      direccion,
      direccionDetectada: barrioDetectado || '',
      precioDomicilio: dom,
      totalFinal,
      presupuesto: presupuesto || null,
    });

    console.log(`📦 pedido-web: ${id} | ${nombre} | ${negocioNombre} | ${direccion} | ${metodoPago}`);

    // ── 2. Armar mensajes de notificación ─────────────────────
    const esTransferencia = metodoPago === 'TRANSFERENCIA';
    const hora = new Date().toLocaleTimeString('es-CO', {
      timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: true
    });

    // Productos para el mensaje
    const prodLines = carrito.map(i =>
      `• ${i.cantidad}× ${i.descripcion}` +
      (i.precioUnitario > 0 ? `  ${COP(i.precioUnitario)} = ${COP(i.subtotal)}` : '')
    ).join('\n');

    const dirLink = gmapsLink(direccion);

    // ── Mensaje para canal (igual al de wilBot.js) ────────────
    let msgCanal =
      `🔴 <b>NUEVO PEDIDO — ${id}</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `🌐 <i>Pedido desde App Web</i>\n` +
      `🏪 ${negocioNombre || 'WIL'}\n` +
      `👤 ${nombre}  📱 ${telefono}\n` +
      `📍 <a href="${dirLink}">${direccion}</a>\n` +
      (referencia ? `📌 Ref: ${referencia}\n` : '') +
      `💳 Pago: <b>${esTransferencia ? '🏦 Transferencia Bancolombia' : '💵 Efectivo'}</b>\n` +
      `🛵 Domicilio: <b>${COP(dom)}</b>\n`;

    if (sub > 0) msgCanal += `🧾 Productos: <b>${COP(sub)}</b>\n`;
    if (totalFinal > 0) msgCanal += `💵 <b>TOTAL: ${COP(totalFinal)}</b>\n`;
    msgCanal += `⏰ ${hora}\n━━━━━━━━━━━━━━━━━━`;

    if (esTransferencia) {
      msgCanal += `\n⚠️ <b>PAGO POR TRANSFERENCIA BANCOLOMBIA</b>`;
    }

    // ── Mensaje corto para drivers ────────────────────────────
    const msgDriver =
      `🔴 <b>Nuevo pedido (App Web)</b>\n` +
      `🆕 <b>${id}</b>\n` +
      `🏪 ${negocioNombre || 'WIL'}\n` +
      `👤 ${nombre}  📱 ${telefono}\n` +
      `📍 ${direccion}\n` +
      `💳 Pago: <b>${esTransferencia ? 'Transferencia' : 'Efectivo'}</b>\n` +
      `🛵 <b>${COP(dom)}</b>\n\n` +
      `Presiona 📋 <b>Pendientes</b> en el bot`;

    // ── 3. Notificar al canal ─────────────────────────────────
    const canalId = (process.env.CANAL_PEDIDOS_ID || '').trim();
    if (canalId) {
      await tgSend(canalId, msgCanal, { disable_web_page_preview: true });
    }

    // ── 4. Notificar a drivers ────────────────────────────────
    const driverIds = getDriverIds();
    await Promise.allSettled(driverIds.map(did => tgSend(did, msgDriver)));

    // ── 5. Notificar a admins (si no están en drivers) ────────
    const adminIds = getAdminIds();
    const adminExtra = adminIds.filter(a => !driverIds.includes(a));
    await Promise.allSettled(adminExtra.map(aid => tgSend(aid, msgCanal, { disable_web_page_preview: true })));

    // ── 6. Responder al cliente (HTML web) ────────────────────
    return res.status(200).json({
      ok: true,
      id,
      total: totalFinal,
      subtotal: sub,
      domicilio: dom,
      hora,
    });

  } catch (e) {
    console.error('pedido-web ERROR:', e.message);
    return res.status(500).json({ error: 'Error interno al registrar el pedido', detail: e.message });
  }
};