// ============================================================
//  api/report-health.js  —  WIL Health Report
//  Genera y envía a Telegram un informe completo cada hora.
//
//  Variables de entorno requeridas en Vercel:
//    MONGODB_URI        → tu connection string de Atlas
//    TELEGRAM_BOT_TOKEN → token del bot (@BotFather)
//    TELEGRAM_CHAT_ID   → ID del chat/grupo destino
//    CRON_SECRET        → clave para llamadas manuales
// ============================================================

import { MongoClient } from 'mongodb';

let cachedClient = null;
async function getDB() {
  if (!cachedClient) {
    cachedClient = new MongoClient(process.env.MONGODB_URI);
    await cachedClient.connect();
  }
  return cachedClient.db();
}

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

const fmt  = (n) => (n ?? 0).toLocaleString('es-CO');
const bar  = (v, max, len = 8) => {
  const filled = max ? Math.round((v / max) * len) : 0;
  return '█'.repeat(filled) + '░'.repeat(len - filled);
};

const COLS = {
  pedidos:       'pedidos',
  domiciliarios: 'Domiciliarios',
  logs:          'logs',
  instalar:      'instalar_logs',
};

export default async function handler(req, res) {

  const secret = req.query.secret || req.headers['x-cron-secret'];
  const isCron = req.headers['x-vercel-cron'] === '1';
  if (!isCron && secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    const db    = await getDB();
    const now   = new Date();
    const hace1h   = new Date(now - 1 * 60 * 60 * 1000);
    const hace6h   = new Date(now - 6 * 60 * 60 * 1000);
    const hace24h  = new Date(now - 24 * 60 * 60 * 1000);
    const hace7d   = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const hoy   = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // ── 1. PEDIDOS ──────────────────────────────────────────
    const colPed = db.collection(COLS.pedidos);

    const [
      totalPedidos,
      pedidosHoy,
      pedidosUltimaHora,
      pedidos6h,
      porEstado,
      sinAsignar,
      pedidosCancelados24h,
      topComercio,
      pedidosConvalor,
      pedidosSemana,
    ] = await Promise.all([
      colPed.countDocuments(),
      colPed.countDocuments({ createdAt: { $gte: hoy } }),
      colPed.countDocuments({ createdAt: { $gte: hace1h } }),
      colPed.countDocuments({ createdAt: { $gte: hace6h } }),
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
            totalVentas: { $sum: { $toDouble: { $ifNull: ['$total', 0] } } },
            promedio:    { $avg: { $toDouble: { $ifNull: ['$total', 0] } } },
          },
        },
      ]).toArray(),
      colPed.countDocuments({ createdAt: { $gte: hace7d } }),
    ]);

    const estadoMap  = {};
    for (const e of porEstado) estadoMap[e._id?.toLowerCase()] = e.count;
    const totalVentas = pedidosConvalor[0]?.totalVentas || 0;
    const promedio    = pedidosConvalor[0]?.promedio    || 0;

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

    // ── 3. SEGURIDAD / LOGS ─────────────────────────────────
    let accesosUltimaHora  = 0;
    let accesos24h         = 0;
    let errores404         = 0;
    let errores500         = 0;
    let ipsSospechosas     = [];
    let ipsNuevas          = [];
    let descargasAPK       = 0;
    let agentesRaros       = [];
    let paisesExtranjeros  = [];
    let peticionesRaras    = [];
    let intentosBrute      = 0;
    let pathsMasFrecuentes = [];

    try {
      const colLogs = db.collection(COLS.logs);

      const [acc1h, acc24h, e404, e500, ips, ipNew, agentes, paises, bruteForce, paths, petRaras] = await Promise.all([

        // Accesos última hora y 24h
        colLogs.countDocuments({ ts: { $gte: hace1h } }),
        colLogs.countDocuments({ ts: { $gte: hace24h } }),

        // Errores
        colLogs.countDocuments({ ts: { $gte: hace1h }, status: 404 }),
        colLogs.countDocuments({ ts: { $gte: hace1h }, status: { $gte: 500 } }),

        // IPs con más de 30 requests en 1h = sospechosas
        colLogs.aggregate([
          { $match: { ts: { $gte: hace1h } } },
          { $group: { _id: '$ip', count: { $sum: 1 } } },
          { $match: { count: { $gt: 30 } } },
          { $sort: { count: -1 } },
          { $limit: 5 },
        ]).toArray(),

        // IPs que aparecen por primera vez hoy (no estaban en 7 días anteriores)
        colLogs.aggregate([
          { $match: { ts: { $gte: hoy } } },
          { $group: { _id: '$ip' } },
          {
            $lookup: {
              from: COLS.logs,
              let: { ip: '$_id' },
              pipeline: [
                { $match: { $expr: { $and: [
                  { $eq: ['$ip', '$$ip'] },
                  { $lt: ['$ts', hoy] },
                  { $gte: ['$ts', hace7d] },
                ]}}},
                { $limit: 1 },
              ],
              as: 'historial',
            },
          },
          { $match: { historial: { $size: 0 } } },
          { $limit: 5 },
        ]).toArray(),

        // User-agents raros (bots, scanners)
        colLogs.aggregate([
          { $match: { ts: { $gte: hace24h }, userAgent: { $exists: true } } },
          {
            $match: {
              userAgent: {
                $regex: /curl|python|scrapy|bot|crawler|scanner|nikto|sqlmap|nmap|masscan|zgrab|nuclei/i,
              },
            },
          },
          { $group: { _id: '$userAgent', count: { $sum: 1 }, ip: { $first: '$ip' } } },
          { $sort: { count: -1 } },
          { $limit: 5 },
        ]).toArray(),

        // Países/regiones inusuales (si tienes campo 'country')
        colLogs.aggregate([
          { $match: { ts: { $gte: hace24h }, country: { $exists: true } } },
          { $group: { _id: '$country', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 5 },
        ]).toArray(),

        // Intentos de fuerza bruta (muchos POST a /api/auth o /login)
        colLogs.countDocuments({
          ts: { $gte: hace1h },
          method: 'POST',
          path: { $regex: /auth|login|signin/i },
        }),

        // Paths más visitados en 24h
        colLogs.aggregate([
          { $match: { ts: { $gte: hace24h } } },
          { $group: { _id: '$path', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 5 },
        ]).toArray(),

        // Peticiones a rutas raras / intentos de exploits
        colLogs.aggregate([
          { $match: { ts: { $gte: hace24h } } },
          {
            $match: {
              path: {
                $regex: /\.env|\.git|wp-admin|phpmyadmin|eval\(|select\s+\*|union\s+select|<script|passwd|etc\/shadow|base64_decode/i,
              },
            },
          },
          { $group: { _id: '$path', count: { $sum: 1 }, ip: { $first: '$ip' } } },
          { $sort: { count: -1 } },
          { $limit: 5 },
        ]).toArray(),
      ]);

      accesosUltimaHora  = acc1h;
      accesos24h         = acc24h;
      errores404         = e404;
      errores500         = e500;
      ipsSospechosas     = ips;
      ipsNuevas          = ipNew;
      agentesRaros       = agentes;
      paisesExtranjeros  = paises;
      intentosBrute      = bruteForce;
      pathsMasFrecuentes = paths;
      peticionesRaras    = petRaras;

    } catch (_) {
      // colección logs no existe aún — se omite sin romper
    }

    // Descargas APK
    try {
      const colApk  = db.collection(COLS.instalar);
      const apkCount = await colApk.countDocuments({ ts: { $gte: hace24h } });
      descargasAPK  = Math.max(descargasAPK, apkCount);
    } catch (_) {}

    // ── 4. ANOMALÍAS EN PEDIDOS ─────────────────────────────
    let duplicados = 0;
    try {
      const dupes = await colPed.aggregate([
        { $match: { createdAt: { $gte: hace24h } } },
        { $group: { _id: '$telefono', count: { $sum: 1 } } },
        { $match: { count: { $gt: 3 } } },
      ]).toArray();
      duplicados = dupes.length;
    } catch (_) {}

    let pedidosIncompletos = 0;
    try {
      pedidosIncompletos = await colPed.countDocuments({
        createdAt: { $gte: hace24h },
        $or: [
          { nombre:   { $in: [null, '', undefined] } },
          { direccion: { $in: [null, '', undefined] } },
        ],
      });
    } catch (_) {}

    // ── 5. CONSTRUIR MENSAJE ────────────────────────────────
    const horaStr  = now.toLocaleTimeString('es-CO', {
      hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota',
    });
    const fechaStr = now.toLocaleDateString('es-CO', {
      weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Bogota',
    });

    const hayAlertas   = sinAsignar > 0 || errores500 > 0 || ipsSospechosas.length > 0
                      || duplicados > 0 || peticionesRaras.length > 0 || intentosBrute > 10
                      || agentesRaros.length > 0;
    const headerEmoji  = hayAlertas ? '🚨' : '✅';

    // Alertas
    const alertasStr = [];
    if (sinAsignar > 0)
      alertasStr.push(`⚠️ <b>${sinAsignar} pedido${sinAsignar > 1 ? 's' : ''} sin domiciliario</b> asignado`);
    if (errores500 > 0)
      alertasStr.push(`🔴 <b>${errores500} errores 500</b> en la última hora`);
    if (ipsSospechosas.length > 0)
      alertasStr.push(`🕵️ <b>${ipsSospechosas.length} IP sospechosa${ipsSospechosas.length > 1 ? 's' : ''}</b>\n${ipsSospechosas.map(x => `    · ${x._id} → ${x.count} reqs`).join('\n')}`);
    if (peticionesRaras.length > 0)
      alertasStr.push(`☠️ <b>Intentos de exploit detectados</b>\n${peticionesRaras.map(x => `    · <code>${x._id?.substring(0,40)}</code> (${x.count}×) IP: ${x.ip}`).join('\n')}`);
    if (intentosBrute > 10)
      alertasStr.push(`🔐 <b>${intentosBrute} intentos de login</b> en la última hora — posible fuerza bruta`);
    if (agentesRaros.length > 0)
      alertasStr.push(`🤖 <b>Bots/Scanners detectados</b>\n${agentesRaros.map(x => `    · ${x._id?.substring(0,35)} (${x.count}×)`).join('\n')}`);
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

    const pathsStr = pathsMasFrecuentes
      .map(p => `  · <code>${p._id?.substring(0,35) || '/'}</code> → ${p.count} visitas`)
      .join('\n') || '  Sin datos';

    const paisesStr = paisesExtranjeros.length
      ? paisesExtranjeros.map(p => `  · ${p._id || 'Desconocido'}: ${p.count}`).join('\n')
      : '  Sin datos';

    // Barra de tráfico visual
    const maxReqs = Math.max(accesosUltimaHora, 1);
    const trafficBar = bar(accesosUltimaHora, Math.max(accesosUltimaHora * 2, 100));

    const msg = [
      // ── Saludo ──
      `👋 <b>Hola Victor!</b> Aquí tu informe WIL`,
      `${headerEmoji} <b>WIL — Informe de salud</b>`,
      `📅 ${fechaStr} · ${horaStr}`,
      '',
      // ── Pedidos ──
      `━━━━━━━━━━━━━━━━━━━━`,
      `📦 <b>PEDIDOS</b>`,
      `  Total histórico: <b>${fmt(totalPedidos)}</b>`,
      `  Esta semana: <b>${fmt(pedidosSemana)}</b>`,
      `  Hoy: <b>${fmt(pedidosHoy)}</b>  |  Últimas 6h: <b>${fmt(pedidos6h)}</b>  |  Última hora: <b>${fmt(pedidosUltimaHora)}</b>`,
      `  Tasa cancelación: <b>${cancelRate}%</b>`,
      '',
      `  Por estado:`,
      estadosPedidos || '  Sin datos',
      '',
      // ── Ventas ──
      `💰 <b>VENTAS HOY</b>`,
      `  Total: <b>$${fmt(Math.round(totalVentas))}</b>`,
      `  Promedio por pedido: <b>$${fmt(Math.round(promedio))}</b>`,
      '',
      // ── Comercios ──
      `━━━━━━━━━━━━━━━━━━━━`,
      `🏪 <b>TOP COMERCIOS (hoy)</b>`,
      topComercioStr,
      '',
      // ── Domiciliarios ──
      `━━━━━━━━━━━━━━━━━━━━`,
      `🛵 <b>DOMICILIARIOS</b>`,
      `  Total: <b>${totalDomis}</b>  |  Activos: <b>${activos}</b>  |  Inactivos: <b>${totalDomis - activos}</b>`,
      '',
      `  Ranking hoy:`,
      topDomisStr,
      '',
      // ── Actividad App ──
      `━━━━━━━━━━━━━━━━━━━━`,
      `📱 <b>ACTIVIDAD APP</b>`,
      `  Descargas APK (24h): <b>${fmt(descargasAPK)}</b>`,
      '',
      // ── Tráfico ──
      `━━━━━━━━━━━━━━━━━━━━`,
      `🌐 <b>TRÁFICO WEB</b>`,
      `  Requests última hora: <b>${fmt(accesosUltimaHora)}</b>  [${trafficBar}]`,
      `  Requests últimas 24h: <b>${fmt(accesos24h)}</b>`,
      errores404 ? `  Errores 404: <b>${fmt(errores404)}</b>` : null,
      errores500 ? `  Errores 500: <b>${fmt(errores500)}</b>` : null,
      '',
      `  Rutas más visitadas:`,
      pathsStr,
      '',
      // ── Seguridad ──
      `━━━━━━━━━━━━━━━━━━━━`,
      `🔒 <b>SEGURIDAD</b>`,
      `  IPs sospechosas (1h): <b>${ipsSospechosas.length}</b>`,
      `  IPs nuevas (hoy): <b>${ipsNuevas.length}</b>`,
      `  Intentos login (1h): <b>${intentosBrute}</b>`,
      `  Bots/Scanners (24h): <b>${agentesRaros.length}</b>`,
      `  Intentos exploit (24h): <b>${peticionesRaras.length}</b>`,
      '',
      paisesExtranjeros.length ? `  Países con tráfico:\n${paisesStr}` : null,
      '',
      // ── Alertas ──
      alertasStr.length
        ? `━━━━━━━━━━━━━━━━━━━━\n🚨 <b>ALERTAS ACTIVAS</b>\n${alertasStr.join('\n')}`
        : `━━━━━━━━━━━━━━━━━━━━\n✅ <b>Sin alertas activas — Todo en orden</b>`,
      '',
      // ── Footer ──
      `<i>Próximo informe en ~1 hora · WIL Monitor</i>`,
      `<i>👨‍💻 Ingeniero Victor Henao</i>`,
    ]
      .filter(l => l !== null)
      .join('\n');

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
      seguridad: {
        ipsSospechosas: ipsSospechosas.length,
        intentosBrute,
        bots: agentesRaros.length,
        exploits: peticionesRaras.length,
      },
      telegram: tgResult.ok,
    });

  } catch (err) {
    console.error('[report-health]', err);
    try {
      await sendTelegram(
        `🔴 <b>WIL Monitor — ERROR en informe</b>\n<code>${err.message?.substring(0, 200)}</code>`
      );
    } catch (_) {}
    return res.status(500).json({ ok: false, error: err.message });
  }
}