// ============================================================
//  api/report-health.js  —  WIL Health Report
//  Genera y envía a Telegram un informe completo cada hora.
//  
//  Llamado por:
//    1. Vercel Cron Job (vercel.json) → cada hora automático
//    2. GET /api/report-health?secret=TU_CRON_SECRET  → manual
//
//  Variables de entorno requeridas en Vercel:
//    MONGODB_URI        → tu connection string de Atlas
//    TELEGRAM_BOT_TOKEN → token del bot (@BotFather)
//    TELEGRAM_CHAT_ID   → ID del chat/grupo destino
//    CRON_SECRET        → clave para llamadas manuales
// ============================================================

import { MongoClient } from 'mongodb';

// ── Conexión MongoDB (reutilizable entre invocaciones) ──────
let cachedClient = null;
async function getDB() {
  if (!cachedClient) {
    cachedClient = new MongoClient(process.env.MONGODB_URI);
    await cachedClient.connect();
  }
  return cachedClient.db(); // usa la db del URI
}

// ── Enviar mensaje a Telegram ───────────────────────────────
async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  return res.json();
}

// ── Helpers ─────────────────────────────────────────────────
const fmt = (n) => (n ?? 0).toLocaleString('es-CO');
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + '%' : '—');
const bar = (v, max, len = 8) => {
  const filled = max ? Math.round((v / max) * len) : 0;
  return '█'.repeat(filled) + '░'.repeat(len - filled);
};
function statusEmoji(pct) {
  if (pct >= 80) return '🔴';
  if (pct >= 50) return '🟡';
  return '🟢';
}

// ── Colecciones (ajusta los nombres a los tuyos) ────────────
const COLS = {
  pedidos:       'pedidos',
  domiciliarios: 'Domiciliarios',
  logs:          'logs',          // si tienes logs de acceso
  instalar:      'instalar_logs', // descargas APK
};

// ── HANDLER PRINCIPAL ───────────────────────────────────────
export default async function handler(req, res) {

  // Seguridad: solo GET con secret correcto o cron interno
  const secret = req.query.secret || req.headers['x-cron-secret'];
  const isCron = req.headers['x-vercel-cron'] === '1';
  if (!isCron && secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    const db   = await getDB();
    const now  = new Date();
    const hace1h  = new Date(now - 1 * 60 * 60 * 1000);
    const hace24h = new Date(now - 24 * 60 * 60 * 1000);
    const hoy  = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // ── 1. PEDIDOS ──────────────────────────────────────────
    const colPed = db.collection(COLS.pedidos);

    const [
      totalPedidos,
      pedidosHoy,
      pedidosUltimaHora,
      porEstado,
      sinAsignar,
      pedidosCancelados24h,
      topComercio,
      pedidosConvalor,
    ] = await Promise.all([
      colPed.countDocuments(),
      colPed.countDocuments({ createdAt: { $gte: hoy } }),
      colPed.countDocuments({ createdAt: { $gte: hace1h } }),
      colPed.aggregate([
        { $group: { _id: '$estado', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]).toArray(),
      colPed.countDocuments({
        $or: [
          { domiciliarioNombre: { $exists: false } },
          { domiciliarioNombre: null },
          { domiciliarioNombre: '' },
        ],
        estado: { $nin: ['Entregado', 'Cancelado', 'entregado', 'cancelado'] },
      }),
      colPed.countDocuments({
        createdAt: { $gte: hace24h },
        estado: { $in: ['Cancelado', 'cancelado'] },
      }),
      colPed.aggregate([
        { $match: { createdAt: { $gte: hoy } } },
        { $group: { _id: '$comercio', total: { $sum: 1 } } },
        { $sort: { total: -1 } },
        { $limit: 3 },
      ]).toArray(),
      colPed.aggregate([
        { $match: { createdAt: { $gte: hoy } } },
        {
          $group: {
            _id: null,
            totalVentas: {
              $sum: {
                $toDouble: {
                  $ifNull: ['$total', 0],
                },
              },
            },
            promedio: { $avg: { $toDouble: { $ifNull: ['$total', 0] } } },
          },
        },
      ]).toArray(),
    ]);

    const estadoMap = {};
    for (const e of porEstado) estadoMap[e._id?.toLowerCase()] = e.count;
    const totalVentas = pedidosConvalor[0]?.totalVentas || 0;
    const promedio    = pedidosConvalor[0]?.promedio || 0;

    // ── 2. DOMICILIARIOS ────────────────────────────────────
    const colDomi = db.collection(COLS.domiciliarios);
    const [totalDomis, activos, conPedidos] = await Promise.all([
      colDomi.countDocuments(),
      colDomi.countDocuments({ activo: true }),
      colDomi.aggregate([
        {
          $lookup: {
            from: COLS.pedidos,
            localField: 'nombre',
            foreignField: 'domiciliarioNombre',
            as: 'pedidos',
          },
        },
        {
          $project: {
            nombre: 1,
            activo: 1,
            pedidosHoy: {
              $size: {
                $filter: {
                  input: '$pedidos',
                  as: 'p',
                  cond: { $gte: ['$$p.createdAt', hoy] },
                },
              },
            },
          },
        },
        { $sort: { pedidosHoy: -1 } },
        { $limit: 3 },
      ]).toArray(),
    ]);

    // ── 3. LOGS / ACCESOS SOSPECHOSOS ──────────────────────
    let accesosUltimaHora = 0;
    let errores404 = 0;
    let errores500 = 0;
    let ipsSospechosas = [];
    let descargasAPK   = 0;

    // Solo si tienes colección de logs
    try {
      const colLogs = db.collection(COLS.logs);
      const [acc, e404, e500, ips, apk] = await Promise.all([
        colLogs.countDocuments({ ts: { $gte: hace1h } }),
        colLogs.countDocuments({ ts: { $gte: hace1h }, status: 404 }),
        colLogs.countDocuments({ ts: { $gte: hace1h }, status: { $gte: 500 } }),
        // IPs con más de 30 requests en 1 hora = sospechosas
        colLogs.aggregate([
          { $match: { ts: { $gte: hace1h } } },
          { $group: { _id: '$ip', count: { $sum: 1 } } },
          { $match: { count: { $gt: 30 } } },
          { $sort: { count: -1 } },
          { $limit: 5 },
        ]).toArray(),
        colLogs.countDocuments({
          ts: { $gte: hace24h },
          path: { $regex: /instalar/i },
        }),
      ]);
      accesosUltimaHora = acc;
      errores404 = e404;
      errores500 = e500;
      ipsSospechosas = ips;
      descargasAPK   = apk;
    } catch (_) {
      // colección de logs no existe aún — se omite sin romper
    }

    // También busca en colección específica de descargas
    try {
      const colApk = db.collection(COLS.instalar);
      const apkCount = await colApk.countDocuments({ ts: { $gte: hace24h } });
      descargasAPK = Math.max(descargasAPK, apkCount);
    } catch (_) {}

    // ── 4. CONSULTAS RARAS / PATRONES ANÓMALOS ─────────────
    // Pedidos duplicados en menos de 5 min del mismo teléfono
    let duplicados = 0;
    try {
      const dupes = await colPed.aggregate([
        { $match: { createdAt: { $gte: hace24h } } },
        {
          $group: {
            _id: '$telefono',
            count: { $sum: 1 },
            tiempos: { $push: '$createdAt' },
          },
        },
        { $match: { count: { $gt: 3 } } },
      ]).toArray();
      duplicados = dupes.length;
    } catch (_) {}

    // Pedidos sin ningún campo crítico (dirección o nombre vacío)
    let pedidosIncompletos = 0;
    try {
      pedidosIncompletos = await colPed.countDocuments({
        createdAt: { $gte: hace24h },
        $or: [
          { nombre: { $in: [null, '', undefined] } },
          { direccion: { $in: [null, '', undefined] } },
        ],
      });
    } catch (_) {}

    // ── 5. CONSTRUIR MENSAJE ────────────────────────────────
    const horaStr = now.toLocaleTimeString('es-CO', {
      hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota',
    });
    const fechaStr = now.toLocaleDateString('es-CO', {
      weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Bogota',
    });

    // Nivel de alerta general
    const hayAlertas = sinAsignar > 0 || errores500 > 0 || ipsSospechosas.length > 0 || duplicados > 0;
    const headerEmoji = hayAlertas ? '🚨' : '✅';

    const estadosPedidos = [
      ['pendiente', '⏳'],
      ['asignado',  '👤'],
      ['proceso',   '🔄'],
      ['encamino',  '🛵'],
      ['entregado', '✅'],
      ['cancelado', '❌'],
    ]
      .map(([k, ico]) => {
        const n = estadoMap[k] || 0;
        return n ? `  ${ico} ${k.charAt(0).toUpperCase() + k.slice(1)}: <b>${n}</b>` : null;
      })
      .filter(Boolean)
      .join('\n');

    const topDomisStr = conPedidos
      .filter(d => d.pedidosHoy > 0)
      .map((d, i) => `  ${['🥇','🥈','🥉'][i] || '▸'} ${d.nombre}: <b>${d.pedidosHoy} pedidos</b>`)
      .join('\n') || '  Sin movimiento hoy';

    const topComercioStr = topComercio
      .map(c => `  • ${c._id || 'Sin nombre'}: <b>${c.total}</b>`)
      .join('\n') || '  Sin datos';

    const alertasStr = [];
    if (sinAsignar > 0)
      alertasStr.push(`⚠️ <b>${sinAsignar} pedido${sinAsignar > 1 ? 's' : ''} sin domiciliario</b> asignado`);
    if (errores500 > 0)
      alertasStr.push(`🔴 <b>${errores500} errores 500</b> en la última hora`);
    if (ipsSospechosas.length > 0)
      alertasStr.push(`🕵️ <b>${ipsSospechosas.length} IP${ipsSospechosas.length > 1 ? 's' : ''} sospechosa${ipsSospechosas.length > 1 ? 's</b>' : '</b>'} (${ipsSospechosas.map(x => `${x._id}×${x.count}`).join(', ')})`);
    if (duplicados > 0)
      alertasStr.push(`🔁 <b>${duplicados} teléfono${duplicados > 1 ? 's' : ''}</b> con +3 pedidos en 24h`);
    if (pedidosIncompletos > 0)
      alertasStr.push(`📋 <b>${pedidosIncompletos} pedido${pedidosIncompletos > 1 ? 's' : ''}</b> con datos incompletos`);
    if (pedidosCancelados24h > 5)
      alertasStr.push(`❌ <b>${pedidosCancelados24h} cancelaciones</b> en las últimas 24h`);
    if (errores404 > 20)
      alertasStr.push(`🔍 <b>${errores404} errores 404</b> — posible scraping`);

    const cancelRate = pedidosHoy
      ? ((estadoMap['cancelado'] || 0) / pedidosHoy * 100).toFixed(1)
      : '0.0';

    const msg = [
      `${headerEmoji} <b>WIL — Informe de salud</b>`,
      `📅 ${fechaStr} · ${horaStr}`,
      '',
      `━━━━━━━━━━━━━━━━━━━━`,
      `📦 <b>PEDIDOS</b>`,
      `  Total histórico: <b>${fmt(totalPedidos)}</b>`,
      `  Hoy: <b>${fmt(pedidosHoy)}</b>  |  Última hora: <b>${fmt(pedidosUltimaHora)}</b>`,
      `  Tasa cancelación: <b>${cancelRate}%</b>`,
      '',
      `  Por estado:`,
      estadosPedidos || '  Sin datos',
      '',
      `💰 <b>VENTAS HOY</b>`,
      `  Total: <b>$${fmt(Math.round(totalVentas))}</b>`,
      `  Promedio por pedido: <b>$${fmt(Math.round(promedio))}</b>`,
      '',
      `━━━━━━━━━━━━━━━━━━━━`,
      `🏪 <b>TOP COMERCIOS (hoy)</b>`,
      topComercioStr,
      '',
      `━━━━━━━━━━━━━━━━━━━━`,
      `🛵 <b>DOMICILIARIOS</b>`,
      `  Total: <b>${totalDomis}</b>  |  Activos: <b>${activos}</b>  |  Inactivos: <b>${totalDomis - activos}</b>`,
      '',
      `  Ranking hoy:`,
      topDomisStr,
      '',
      `━━━━━━━━━━━━━━━━━━━━`,
      `📱 <b>ACTIVIDAD APP</b>`,
      `  Descargas APK (24h): <b>${fmt(descargasAPK)}</b>`,
      accesosUltimaHora ? `  Requests última hora: <b>${fmt(accesosUltimaHora)}</b>` : null,
      errores404        ? `  Errores 404: <b>${fmt(errores404)}</b>` : null,
      errores500        ? `  Errores 500: <b>${fmt(errores500)}</b>` : null,
      '',
      alertasStr.length
        ? `━━━━━━━━━━━━━━━━━━━━\n🚨 <b>ALERTAS</b>\n${alertasStr.join('\n')}`
        : `━━━━━━━━━━━━━━━━━━━━\n✅ <b>Sin alertas activas</b>`,
      '',
      `<i>Próximo informe en ~1 hora · WIL Monitor</i>`,
    ]
      .filter(l => l !== null)
      .join('\n');

    // Telegram tiene límite de 4096 chars — si supera, truncar elegantemente
    const msgFinal = msg.length > 4000
      ? msg.substring(0, 3950) + '\n\n<i>…[truncado]</i>'
      : msg;

    const tgResult = await sendTelegram(msgFinal);

    return res.status(200).json({
      ok: true,
      ts: now.toISOString(),
      pedidosHoy,
      pedidosUltimaHora,
      totalVentas,
      alertas: alertasStr.length,
      telegram: tgResult.ok,
    });

  } catch (err) {
    console.error('[report-health]', err);
    // Intentar avisar por Telegram aunque sea del error
    try {
      await sendTelegram(
        `🔴 <b>WIL Monitor — ERROR en informe</b>\n<code>${err.message?.substring(0, 200)}</code>`
      );
    } catch (_) {}
    return res.status(500).json({ ok: false, error: err.message });
  }
}