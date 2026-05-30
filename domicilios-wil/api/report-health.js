// ============================================================
//  api/report-health.js  —  WIL Health Report · HACKER EDITION
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

const fmt = (n) => (n ?? 0).toLocaleString('es-CO');

function barChart(value, max, len = 16, isAttack = false) {
  const filled = max > 0 ? Math.round((value / max) * len) : 0;
  const block  = isAttack ? '█' : '▓';
  return block.repeat(filled) + '░'.repeat(len - filled) + (isAttack && value > 0 ? ' ⚠' : '');
}

function spark(values) {
  const chars = ['▁','▂','▃','▄','▅','▆','▇','█'];
  const max   = Math.max(...values, 1);
  return values.map(v => chars[Math.round((v / max) * (chars.length - 1))]).join('');
}

// ── Guías de respuesta a incidentes ─────────────────────────
function guiaAtaque(tipo, datos = {}) {
  const guias = {
    ip_sospechosa: {
      titulo: '🕵️ IP SOSPECHOSA — POSIBLE SCRAPING / BOT',
      donde: [
        '  1. Vercel → Logs → filtra por IP: ' + (datos.ips?.map(x => x._id).join(', ') || '?'),
        '  2. MongoDB Atlas → Collections → logs → busca esa IP',
        '  3. Revisa qué rutas está golpeando (¿/api/pedidos? ¿/api/auth?)',
      ],
      pasos: [
        '  >> Vercel: Settings → Firewall → Block IP',
        '  >> Si es scraping: agrega rate-limit en tu API (max 10 req/min por IP)',
        '  >> Si persiste: habilita Vercel WAF (plan Pro) o usa Cloudflare gratis',
        '  >> Código: npm install express-rate-limit y aplica en /api/*',
      ],
    },
    brute_force: {
      titulo: '🔐 FUERZA BRUTA — INTENTOS DE LOGIN',
      donde: [
        '  1. Vercel → Logs → filtra POST /api/auth o /api/login',
        '  2. Busca IPs que repiten muchas veces en poco tiempo',
        '  3. MongoDB → logs → { method: "POST", path: /auth/ }',
      ],
      pasos: [
        '  >> Bloquea la IP en Vercel Firewall inmediatamente',
        '  >> Agrega captcha o delay de 3s después de 3 intentos fallidos',
        '  >> Habilita 2FA en las cuentas admin de WIL',
        '  >> Cambia las claves de CRON_SECRET y variables de entorno',
        '  >> npm install express-rate-limit → limita /api/auth a 5 req/min',
      ],
    },
    exploit: {
      titulo: '☠️ INTENTO DE EXPLOIT — ATAQUE ACTIVO',
      donde: [
        '  1. URGENTE: Vercel → Logs → busca paths como .env, .git, sqlmap',
        '  2. Rutas atacadas: ' + (datos.paths?.map(x => x._id?.substring(0,40)).join(' | ') || '?'),
        '  3. IPs origen: ' + (datos.paths?.map(x => x.ip).filter(Boolean).join(', ') || '?'),
      ],
      pasos: [
        '  >> INMEDIATO: bloquea IP en Vercel → Settings → Firewall',
        '  >> Verifica que .env NO esté en tu repositorio público (git status)',
        '  >> Revisa que /api/* requiera autenticación, no sea pública',
        '  >> Activa Vercel WAF o pon el proyecto detrás de Cloudflare',
        '  >> Rota TODAS las variables de entorno por precaución',
        '  >> Revisa MongoDB Atlas → accesos recientes en Security → Audit Log',
      ],
    },
    bot_scanner: {
      titulo: '🤖 BOT / SCANNER DETECTADO',
      donde: [
        '  1. Vercel → Logs → filtra User-Agent: ' + (datos.agentes?.map(x => x._id?.substring(0,30)).join(' | ') || '?'),
        '  2. Verifica si está leyendo datos sensibles (/api/pedidos, /api/domiciliarios)',
        '  3. Comprueba si hay patrones en las horas (ataques nocturnos son automatizados)',
      ],
      pasos: [
        '  >> Bloquea el User-Agent en Vercel Firewall o middleware',
        '  >> Agrega robots.txt con: User-agent: * → Disallow: /api/',
        '  >> Implementa honeypot: ruta falsa que al ser visitada bloquea la IP',
        '  >> Si es nikto/sqlmap: reporta IP en abuseipdb.com',
      ],
    },
    errores_500: {
      titulo: '🔴 ERRORES 500 — FALLO INTERNO',
      donde: [
        '  1. Vercel → Functions → revisa logs de las últimas funciones',
        '  2. Vercel → Deployments → mira si hay un deploy roto reciente',
        '  3. MongoDB Atlas → revisa si la conexión está caída o hay timeout',
      ],
      pasos: [
        '  >> Verifica variables de entorno en Vercel (MONGODB_URI, etc.)',
        '  >> Revisa si MongoDB Atlas está en pausa (free tier se pausa)',
        '  >> Haz un redeploy desde Vercel → Deployments → Redeploy',
        '  >> Si persiste: npm run dev localmente y reproduce el error',
      ],
    },
    sin_domiciliario: {
      titulo: '⚠️ PEDIDOS SIN DOMICILIARIO',
      donde: [
        '  1. Panel WIL → tab "Pendientes" → columna Domiciliario vacía',
        '  2. MongoDB → pedidos → { domiciliarioNombre: null, estado: "pendiente" }',
      ],
      pasos: [
        '  >> Entra al panel y asigna manualmente desde el botón "Asignar"',
        '  >> Notifica por WhatsApp a los domiciliarios disponibles',
        '  >> Si es recurrente: revisa el flujo de asignación automática',
      ],
    },
    cancelaciones: {
      titulo: '❌ ALTO ÍNDICE DE CANCELACIONES',
      donde: [
        '  1. Panel WIL → tab "Cancelados" → revisa los motivos',
        '  2. MongoDB → pedidos → { estado: "cancelado", createdAt: { $gte: hace24h } }',
        '  3. Revisa si hay un comercio específico con muchas cancelaciones',
      ],
      pasos: [
        '  >> Filtra por comercio en el panel para identificar el problemático',
        '  >> Contacta al comercio para verificar disponibilidad de productos',
        '  >> Si son pedidos sin domiciliario: hay escasez de domis activos',
      ],
    },
    errores_404: {
      titulo: '🔍 EXCESO DE ERRORES 404 — POSIBLE SCRAPING',
      donde: [
        '  1. Vercel → Logs → filtra status:404 en la última hora',
        '  2. Identifica qué rutas están siendo buscadas',
        '  3. Si buscan /wp-admin, /.env, /phpmyadmin → es un scanner automatizado',
      ],
      pasos: [
        '  >> Si son rutas de CMS (WordPress, etc.): es un bot, bloquea IP',
        '  >> Agrega middleware que retorne 410 Gone en vez de 404 para esas rutas',
        '  >> Usa Cloudflare Bot Fight Mode (gratis) para filtrar bots',
      ],
    },
    duplicados: {
      titulo: '🔁 TELÉFONOS CON MÚLTIPLES PEDIDOS',
      donde: [
        '  1. MongoDB → pedidos → agrupa por telefono y filtra count > 3',
        '  2. Panel WIL → busca el número de teléfono específico',
        '  3. Verifica si son pedidos legítimos o intento de abuso',
      ],
      pasos: [
        '  >> Contacta al cliente para verificar si los pedidos son reales',
        '  >> Si es abuso: cancela los duplicados desde el panel',
        '  >> Implementa límite de 2 pedidos activos por teléfono en el backend',
      ],
    },
  };
  return guias[tipo] || null;
}

const COLS = {
  pedidos:       'pedidos',
  domiciliarios: 'domiciliarios',
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
    const db      = await getDB();
    const now     = new Date();
    const hace1h  = new Date(now - 1 * 60 * 60 * 1000);
    const hace6h  = new Date(now - 6 * 60 * 60 * 1000);
    const hace24h = new Date(now - 24 * 60 * 60 * 1000);
    const hace7d  = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const hoy     = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const proximo = new Date(now.getTime() + 60 * 60 * 1000);

    // ── PEDIDOS ─────────────────────────────────────────────
    const colPed = db.collection(COLS.pedidos);
    const [
      totalPedidos, pedidosHoy, pedidosUltimaHora, pedidos6h,
      porEstado, sinAsignar, pedidosCancelados24h,
      topComercio, pedidosConvalor, pedidosSemana, pedidosPorHora,
    ] = await Promise.all([
      colPed.countDocuments(),
      colPed.countDocuments({ createdAt: { $gte: hoy } }),
      colPed.countDocuments({ createdAt: { $gte: hace1h } }),
      colPed.countDocuments({ createdAt: { $gte: hace6h } }),
      colPed.aggregate([{ $group: { _id: '$estado', count: { $sum: 1 } } },{ $sort: { count: -1 } }]).toArray(),
      colPed.countDocuments({ $or: [{ domiciliarioNombre: { $exists: false } },{ domiciliarioNombre: null },{ domiciliarioNombre: '' }], estado: { $nin: ['Entregado','Cancelado','entregado','cancelado'] } }),
      colPed.countDocuments({ createdAt: { $gte: hace24h }, estado: { $in: ['Cancelado','cancelado'] } }),
      colPed.aggregate([{ $match: { createdAt: { $gte: hoy } } },{ $group: { _id: '$comercio', total: { $sum: 1 } } },{ $sort: { total: -1 } },{ $limit: 3 }]).toArray(),
      colPed.aggregate([{ $match: { createdAt: { $gte: hoy } } },{ $group: { _id: null, totalVentas: { $sum: { $toDouble: { $ifNull: ['$total',0] } } }, promedio: { $avg: { $toDouble: { $ifNull: ['$total',0] } } } } }]).toArray(),
      colPed.countDocuments({ createdAt: { $gte: hace7d } }),
      colPed.aggregate([{ $match: { createdAt: { $gte: hace6h } } },{ $group: { _id: { $hour: '$createdAt' }, count: { $sum: 1 } } },{ $sort: { _id: 1 } }]).toArray(),
    ]);

    const estadoMap   = {};
    for (const e of porEstado) estadoMap[e._id?.toLowerCase()] = e.count;
    const totalVentas = pedidosConvalor[0]?.totalVentas || 0;
    const promedio    = pedidosConvalor[0]?.promedio    || 0;
    const cancelRate  = pedidosHoy ? ((estadoMap['cancelado'] || 0) / pedidosHoy * 100).toFixed(1) : '0.0';

    const horaActual  = now.getUTCHours();
    const horasLabels = [];
    const horasValues = [];
    for (let i = 7; i >= 0; i--) {
      const h = (horaActual - i + 24) % 24;
      const f = pedidosPorHora.find(x => x._id === h);
      horasLabels.push(String(h).padStart(2,'0') + 'h');
      horasValues.push(f?.count || 0);
    }
    const maxPedHora = Math.max(...horasValues, 1);

    // ── DOMICILIARIOS ────────────────────────────────────────
    const colDomi = db.collection(COLS.domiciliarios);
    const [totalDomis, activos, conPedidos] = await Promise.all([
      colDomi.countDocuments(),
      colDomi.countDocuments({ activo: true }),
      colDomi.aggregate([
        { $lookup: { from: COLS.pedidos, localField: 'nombre', foreignField: 'domiciliarioNombre', as: 'pedidos' } },
        { $project: { nombre: 1, activo: 1, pedidosHoy: { $size: { $filter: { input: '$pedidos', as: 'p', cond: { $gte: ['$$p.createdAt', hoy] } } } } } },
        { $sort: { pedidosHoy: -1 } },
        { $limit: 5 },
      ]).toArray(),
    ]);

    // ── SEGURIDAD + TRÁFICO ──────────────────────────────────
    let accesosUltimaHora=0, accesos24h=0, errores404=0, errores500=0;
    let ipsSospechosas=[], ipsNuevas=[], agentesRaros=[];
    let peticionesRaras=[], pathsMasFrecuentes=[], trafficPorHora=[];
    let intentosBrute=0, descargasAPK=0;

    // ── NUEVAS: rutas con detalle ok/fail + login por IP ────
    let rutasDetalle=[], loginPorIP=[], loginOk=0, loginFail=0;

    try {
      const colLogs = db.collection(COLS.logs);
      const [
        a1h, a24h, e404, e500, ips, ipN, agt, brute,
        paths, petR, trafH,
        rutDet, logIP, logResumen,
      ] = await Promise.all([
        colLogs.countDocuments({ ts: { $gte: hace1h } }),
        colLogs.countDocuments({ ts: { $gte: hace24h } }),
        colLogs.countDocuments({ ts: { $gte: hace1h }, status: 404 }),
        colLogs.countDocuments({ ts: { $gte: hace1h }, status: { $gte: 500 } }),
        colLogs.aggregate([{ $match: { ts: { $gte: hace1h } } },{ $group: { _id: '$ip', count: { $sum: 1 } } },{ $match: { count: { $gt: 30 } } },{ $sort: { count: -1 } },{ $limit: 5 }]).toArray(),
        colLogs.aggregate([{ $match: { ts: { $gte: hoy } } },{ $group: { _id: '$ip' } },{ $lookup: { from: COLS.logs, let: { ip: '$_id' }, pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$ip','$$ip'] },{ $lt: ['$ts',hoy] },{ $gte: ['$ts',hace7d] }] } } },{ $limit: 1 }], as: 'h' } },{ $match: { h: { $size: 0 } } },{ $limit: 5 }]).toArray(),
        colLogs.aggregate([{ $match: { ts: { $gte: hace24h }, userAgent: { $regex: /curl|python|scrapy|bot|crawler|scanner|nikto|sqlmap|nmap|masscan|zgrab|nuclei/i } } },{ $group: { _id: '$userAgent', count: { $sum: 1 }, ip: { $first: '$ip' } } },{ $sort: { count: -1 } },{ $limit: 5 }]).toArray(),
        colLogs.countDocuments({ ts: { $gte: hace1h }, method: 'POST', path: { $regex: /auth|login|signin/i } }),
        colLogs.aggregate([{ $match: { ts: { $gte: hace24h } } },{ $group: { _id: '$path', count: { $sum: 1 } } },{ $sort: { count: -1 } },{ $limit: 5 }]).toArray(),
        colLogs.aggregate([{ $match: { ts: { $gte: hace24h }, path: { $regex: /\.env|\.git|wp-admin|phpmyadmin|eval\(|select\s+\*|union\s+select|<script|passwd|etc\/shadow|base64_decode/i } } },{ $group: { _id: '$path', count: { $sum: 1 }, ip: { $first: '$ip' } } },{ $sort: { count: -1 } },{ $limit: 5 }]).toArray(),
        colLogs.aggregate([{ $match: { ts: { $gte: hace6h } } },{ $group: { _id: { $hour: '$ts' }, count: { $sum: 1 } } },{ $sort: { _id: 1 } }]).toArray(),

        // ── NUEVO: top rutas con conteo ok (2xx) y fail (4xx/5xx) ──
        colLogs.aggregate([
          { $match: { ts: { $gte: hace24h } } },
          { $group: {
            _id: '$path',
            total:  { $sum: 1 },
            ok:     { $sum: { $cond: [{ $and: [{ $gte: ['$status', 200] }, { $lt: ['$status', 400] }] }, 1, 0] } },
            fail:   { $sum: { $cond: [{ $gte: ['$status', 400] }, 1, 0] } },
            s500:   { $sum: { $cond: [{ $gte: ['$status', 500] }, 1, 0] } },
          }},
          { $sort: { total: -1 } },
          { $limit: 8 },
        ]).toArray(),

        // ── NUEVO: intentos login fallidos agrupados por IP ──
        colLogs.aggregate([
          { $match: {
            ts:     { $gte: hace24h },
            method: 'POST',
            path:   { $regex: /auth|login|signin/i },
            status: { $gte: 400 },
          }},
          { $group: {
            _id:       '$ip',
            intentos:  { $sum: 1 },
            ultimaVez: { $max: '$ts' },
          }},
          { $sort: { intentos: -1 } },
          { $limit: 5 },
        ]).toArray(),

        // ── NUEVO: total login ok vs fail en 24h ──
        colLogs.aggregate([
          { $match: {
            ts:     { $gte: hace24h },
            method: 'POST',
            path:   { $regex: /auth|login|signin/i },
          }},
          { $group: {
            _id: null,
            ok:   { $sum: { $cond: [{ $and: [{ $gte: ['$status', 200] }, { $lt: ['$status', 400] }] }, 1, 0] } },
            fail: { $sum: { $cond: [{ $gte: ['$status', 400] }, 1, 0] } },
          }},
        ]).toArray(),
      ]);

      accesosUltimaHora=a1h; accesos24h=a24h; errores404=e404; errores500=e500;
      ipsSospechosas=ips; ipsNuevas=ipN; agentesRaros=agt;
      intentosBrute=brute; pathsMasFrecuentes=paths; peticionesRaras=petR; trafficPorHora=trafH;
      rutasDetalle=rutDet;
      loginPorIP=logIP;
      loginOk   = logResumen[0]?.ok   || 0;
      loginFail = logResumen[0]?.fail  || 0;

    } catch(_) {}

    try {
      const c = await db.collection(COLS.instalar).countDocuments({ ts: { $gte: hace24h } });
      descargasAPK = Math.max(descargasAPK, c);
    } catch(_) {}

    let duplicados=0, pedidosIncompletos=0;
    try {
      duplicados = (await colPed.aggregate([{ $match: { createdAt: { $gte: hace24h } } },{ $group: { _id: '$telefono', count: { $sum: 1 } } },{ $match: { count: { $gt: 3 } } }]).toArray()).length;
    } catch(_) {}
    try {
      pedidosIncompletos = await colPed.countDocuments({ createdAt: { $gte: hace24h }, $or: [{ nombre: { $in: [null,'',undefined] } },{ direccion: { $in: [null,'',undefined] } }] });
    } catch(_) {}

    // ── Tráfico por hora ─────────────────────────────────────
    const trafMap = {};
    for (const t of trafficPorHora) trafMap[t._id] = t.count;
    const trafficValues = horasLabels.map((_, i) => {
      const h = (horaActual - (7 - i) + 24) % 24;
      return trafMap[h] || 0;
    });
    const maxTraffic = Math.max(...trafficValues, 1);
    const attackValues = trafficValues.map(v =>
      Math.round(v * (errores404 + errores500) / Math.max(accesos24h, 1))
    );
    const maxAttack = Math.max(...attackValues, 1);

    // ── Alertas + Guías de respuesta ─────────────────────────
    const alertasStr  = [];
    const guiasBlocks = [];

    if (ipsSospechosas.length > 0) {
      alertasStr.push(`  >> ${ipsSospechosas.length} IP(s) sospechosa(s): ${ipsSospechosas.map(x => x._id + ' (' + x.count + ' reqs)').join(', ')}`);
      const g = guiaAtaque('ip_sospechosa', { ips: ipsSospechosas });
      if (g) guiasBlocks.push(g);
    }
    if (intentosBrute > 10) {
      alertasStr.push(`  >> ${intentosBrute} intentos brute-force en login`);
      const g = guiaAtaque('brute_force');
      if (g) guiasBlocks.push(g);
    }
    if (peticionesRaras.length > 0) {
      alertasStr.push(`  >> ${peticionesRaras.length} intento(s) de exploit detectados`);
      const g = guiaAtaque('exploit', { paths: peticionesRaras });
      if (g) guiasBlocks.push(g);
    }
    if (agentesRaros.length > 0) {
      alertasStr.push(`  >> ${agentesRaros.length} bot/scanner activo: ${agentesRaros.map(x => x._id?.substring(0,20)).join(' | ')}`);
      const g = guiaAtaque('bot_scanner', { agentes: agentesRaros });
      if (g) guiasBlocks.push(g);
    }
    if (errores500 > 0) {
      alertasStr.push(`  >> ${errores500} errores 500 en ultima hora`);
      const g = guiaAtaque('errores_500');
      if (g) guiasBlocks.push(g);
    }
    if (sinAsignar > 0) {
      alertasStr.push(`  >> ${sinAsignar} pedido(s) SIN domiciliario asignado`);
      const g = guiaAtaque('sin_domiciliario');
      if (g) guiasBlocks.push(g);
    }
    if (pedidosCancelados24h > 5) {
      alertasStr.push(`  >> ${pedidosCancelados24h} cancelaciones en 24h`);
      const g = guiaAtaque('cancelaciones');
      if (g) guiasBlocks.push(g);
    }
    if (errores404 > 20) {
      alertasStr.push(`  >> ${errores404} errores 404 — posible scraping`);
      const g = guiaAtaque('errores_404');
      if (g) guiasBlocks.push(g);
    }
    if (duplicados > 0) {
      alertasStr.push(`  >> ${duplicados} telefono(s) con +3 pedidos/24h`);
      const g = guiaAtaque('duplicados');
      if (g) guiasBlocks.push(g);
    }
    if (pedidosIncompletos > 0) {
      alertasStr.push(`  >> ${pedidosIncompletos} pedido(s) con datos incompletos`);
    }
    if (loginFail > 20) {
      alertasStr.push(`  >> ${loginFail} intentos de login fallidos en 24h`);
      const g = guiaAtaque('brute_force');
      if (g && !guiasBlocks.find(x => x.titulo === g.titulo)) guiasBlocks.push(g);
    }

    const hayAlertas = alertasStr.length > 0;
    const nivelSeguridad = hayAlertas ? Math.max(10, 100 - (guiasBlocks.length * 18)) : 100;
    const barSeguridad   = barChart(nivelSeguridad, 100, 12, hayAlertas);

    // ── Construir bloque de guías ────────────────────────────
    let guiasSection = '';
    if (guiasBlocks.length > 0) {
      guiasSection = guiasBlocks.map((g, idx) => `
┌─[ INCIDENTE ${String(idx+1).padStart(2,'0')} ]──────────────────────
  ${g.titulo}
  ·
  DONDE REVISAR:
${g.donde.join('\n')}
  ·
  COMO DETENERLO:
${g.pasos.join('\n')}`).join('\n');
    }

    // ── Fechas ───────────────────────────────────────────────
    const optsDate = { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Bogota' };
    const optsTime = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'America/Bogota' };
    const fechaScan = now.toLocaleDateString('es-CO', optsDate);
    const horaScan  = now.toLocaleTimeString('es-CO', optsTime);
    const fechaProx = proximo.toLocaleDateString('es-CO', optsDate);
    const horaProx  = proximo.toLocaleTimeString('es-CO', optsTime);

    // ── Gráficas ─────────────────────────────────────────────
    const pedHoraLines     = horasLabels.map((l,i) => `  ${l} ${barChart(horasValues[i],   maxPedHora,  14)}  ${String(horasValues[i]).padStart(4,' ')}`).join('\n');
    const trafficHoraLines = horasLabels.map((l,i) => `  ${l} ${barChart(trafficValues[i], maxTraffic,  14)}  ${String(trafficValues[i]).padStart(5,' ')}`).join('\n');
    const attackHoraLines  = horasLabels.map((l,i) => `  ${l} ${barChart(attackValues[i],  maxAttack,   14, true)}  ${String(attackValues[i]).padStart(4,' ')}`).join('\n');

    const maxDomiPed = Math.max(...conPedidos.map(d => d.pedidosHoy), 1);
    const domiLines  = conPedidos.filter(d => d.pedidosHoy > 0)
      .map((d,i) => `  #${String(i+1).padStart(2,'0')} ${d.nombre.substring(0,10).padEnd(10,' ')} ${barChart(d.pedidosHoy, maxDomiPed, 10)}  ${d.pedidosHoy}`)
      .join('\n') || '  >> sin movimiento hoy';

    const maxCom        = topComercio[0]?.total || 1;
    const comercioLines = topComercio.map((c,i) =>
      `  ${String(i+1).padStart(2,'0')} ${(c._id||'?').substring(0,10).padEnd(10,' ')} ${barChart(c.total, maxCom, 10)}  ${c.total}`
    ).join('\n') || '  >> sin datos';

    const estadosOrden = [['pendiente','PEND'],['asignado','ASIG'],['proceso','PROC'],['encamino','ENVO'],['entregado','ENTR'],['cancelado','CANC']];
    const maxEst       = Math.max(...estadosOrden.map(([k]) => estadoMap[k]||0), 1);
    const estadoLines  = estadosOrden.map(([k,label]) => {
      const n = estadoMap[k]||0; if (!n) return null;
      return `  ${label} ${barChart(n, maxEst, 12, k==='cancelado')}  ${String(n).padStart(4,' ')}`;
    }).filter(Boolean).join('\n') || '  >> sin datos';

    const ipsLines = ipsSospechosas.length
      ? ipsSospechosas.map(x => `  ${x._id.padEnd(16,' ')} ${barChart(x.count, ipsSospechosas[0].count, 10, true)}  ${x.count} reqs`).join('\n')
      : '  >> ninguna detectada';

    const botsLines = agentesRaros.length
      ? agentesRaros.map(x => `  [${x.count}x] ${x._id.substring(0,25)} :: ${x.ip||'?'}`).join('\n')
      : '  >> ninguno detectado';

    const exploitLines = peticionesRaras.length
      ? peticionesRaras.map(x => `  [${x.count}x] ${(x._id||'?').substring(0,28)} >> ${x.ip||'?'}`).join('\n')
      : '  >> ninguno detectado';

    // ── NUEVO: rutas con ok/fail detallado ───────────────────
    const maxRutTotal = rutasDetalle[0]?.total || 1;
    const rutasLines  = rutasDetalle.length
      ? rutasDetalle.map(r => {
          const ruta  = (r._id || '/').substring(0, 22).padEnd(22, ' ');
          const bar   = barChart(r.total, maxRutTotal, 8, r.fail > r.ok);
          const okStr   = String(r.ok  ).padStart(4, ' ');
          const failStr = String(r.fail).padStart(4, ' ');
          const s5Str   = r.s500 > 0 ? ` 💀${r.s500}` : '';
          return `  ${ruta} ${bar}  ✅${okStr} ❌${failStr}${s5Str}`;
        }).join('\n')
      : '  >> sin datos';

    // ── NUEVO: login fallidos por IP ─────────────────────────
    const loginIPLines = loginPorIP.length
      ? loginPorIP.map(x => {
          const ip  = (x._id || '?').padEnd(16, ' ');
          const bar = barChart(x.intentos, loginPorIP[0].intentos, 10, true);
          const hora = x.ultimaVez
            ? new Date(x.ultimaVez).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' })
            : '??:??';
          return `  ${ip} ${bar}  ${x.intentos} intentos  última: ${hora}`;
        }).join('\n')
      : '  >> ningún intento fallido';

    const sparkPed     = spark(horasValues);
    const sparkTraffic = spark(trafficValues);
    const sparkAttack  = spark(attackValues);

    // ── MENSAJE ──────────────────────────────────────────────
    const msg = `👋 <b>Hola Victor!</b> Aquí tu informe WIL.

<pre>
╔══════════════════════════════════════╗
║    ,___,                            ║
║    [O.O]    WIL MONITOR  v2.0       ║
║    /)  (\\                           ║
║   (__ __)                           ║
╚══════════════════════════════════════╝

┌─────────────────────────────────────┐
│  📦  P E D I D O S                  │
├─────────────────────────────────────┤
  Historico   ........  ${fmt(totalPedidos).padStart(8,' ')}
  Semana      ........  ${fmt(pedidosSemana).padStart(8,' ')}
  Hoy         ........  ${fmt(pedidosHoy).padStart(8,' ')}
  Ultimas 6h  ........  ${fmt(pedidos6h).padStart(8,' ')}
  Ultima hora ........  ${fmt(pedidosUltimaHora).padStart(8,' ')}
  Cancelacion ........  ${cancelRate.padStart(7,' ')}%
  Sin asignar ........  ${fmt(sinAsignar).padStart(8,' ')}

  TENDENCIA 8H >> ${sparkPed}

  ESTADOS:
${estadoLines}

  PEDIDOS/HORA:
${pedHoraLines}

┌─────────────────────────────────────┐
│  💰  V E N T A S   H O Y            │
├─────────────────────────────────────┤
  Total    >>  $${fmt(Math.round(totalVentas))}
  Promedio >>  $${fmt(Math.round(promedio))}

┌─────────────────────────────────────┐
│  🏪  C O M E R C I O S   T O P      │
├─────────────────────────────────────┤
${comercioLines}

┌─────────────────────────────────────┐
│  🛵  D O M I C I L I A R I O S      │
├─────────────────────────────────────┤
  Total     : ${totalDomis}
  Activos   : ${activos}
  Inactivos : ${totalDomis - activos}

  RANKING HOY:
${domiLines}

┌─────────────────────────────────────┐
│  🌐  T R A F I C O   W E B          │
├─────────────────────────────────────┤
  Requests 1h   >>  ${fmt(accesosUltimaHora)}
  Requests 24h  >>  ${fmt(accesos24h)}
  Descargas APK >>  ${fmt(descargasAPK)}
  Errores 404   >>  ${fmt(errores404)}
  Errores 500   >>  ${fmt(errores500)}

  TENDENCIA 8H >> ${sparkTraffic}

  TRAFICO/HORA:
${trafficHoraLines}

  RUTAS 24H  [ruta               ]  ✅ OK  ❌FAIL
${rutasLines}

┌─────────────────────────────────────┐
│  🔑  L O G I N   A U D I T          │
├─────────────────────────────────────┤
  Intentos 24h  >>  ${fmt(loginOk + loginFail)}
  Exitosos      >>  ✅ ${fmt(loginOk)}
  Fallidos      >>  ❌ ${fmt(loginFail)}
  Tasa exito    >>  ${(loginOk + loginFail > 0 ? (loginOk / (loginOk + loginFail) * 100).toFixed(1) : '0.0')}%

  IPs CON FALLOS (24h):
${loginIPLines}

┌─────────────────────────────────────┐
│  🔒  S E G U R I D A D              │
├─────────────────────────────────────┤
  IPs sospechosas  >>  ${ipsSospechosas.length}
  IPs nuevas hoy   >>  ${ipsNuevas.length}
  Brute-force      >>  ${intentosBrute}
  Bots/Scanners    >>  ${agentesRaros.length}
  Intentos exploit >>  ${peticionesRaras.length}

  ATAQUES/HORA >> ${sparkAttack}

${attackHoraLines}

  [IPs SOSPECHOSAS]
${ipsLines}

  [BOTS DETECTADOS]
${botsLines}

  [INTENTOS DE EXPLOIT]
${exploitLines}

┌─────────────────────────────────────┐
│  🚨  A L E R T A S                  │
├─────────────────────────────────────┤
${alertasStr.length ? alertasStr.join('\n') : '  >> SIN ALERTAS ACTIVAS [OK]'}
${guiasBlocks.length > 0 ? `
╔══════════════════════════════════════╗
║  ⚡ GUIA DE RESPUESTA A INCIDENTES   ║
╚══════════════════════════════════════╝
${guiasSection}` : ''}

╔══════════════════════════════════════╗
║  ESCANEO >>  ${fechaScan}  ${horaScan}  ║
║  PROXIMO >>  ${fechaProx}  ${horaProx}  ║
╠══════════════════════════════════════╣
║  AMENAZAS  >>  ${hayAlertas ? '!! ' + guiasBlocks.length + ' INCIDENTE(S) !!' : 'NINGUNA              '}  ║
║  SEGURIDAD >>  ${barSeguridad}  ${String(nivelSeguridad).padStart(3,'0')}%  ║
║  SISTEMA   >>  ${hayAlertas ? '⚠ REVISAR AHORA      ' : '✓ TODO EN ORDEN      '}  ║
╠══════════════════════════════════════╣
║  >> Ing. Victor Henao                ║
║  >> WIL MONITOR v2.0                 ║
╚══════════════════════════════════════╝
</pre>`;

    // Si el mensaje supera 4000 chars, enviar en 2 partes
    if (msg.length > 4000) {
      const parte1 = msg.substring(0, 3900) + '\n\n<i>...continua en siguiente mensaje...</i>\n</pre>';
      await sendTelegram(parte1);

      if (guiasBlocks.length > 0) {
        const parte2 = `<pre>
╔══════════════════════════════════════╗
║  ⚡ GUIA DE RESPUESTA (continuacion) ║
╚══════════════════════════════════════╝
${guiasSection}

╔══════════════════════════════════════╗
║  >> Ing. Victor Henao                ║
║  >> WIL MONITOR v2.0                 ║
╚══════════════════════════════════════╝
</pre>`;
        await sendTelegram(parte2.length > 4000 ? parte2.substring(0,3950) + '\n</pre>' : parte2);
      }

      return res.status(200).json({ ok: true, ts: now.toISOString(), pedidosHoy, alertas: alertasStr.length, incidentes: guiasBlocks.length, telegram: true, split: true });
    }

    const tgResult = await sendTelegram(msg);

    return res.status(200).json({
      ok: true,
      ts: now.toISOString(),
      pedidosHoy,
      pedidosUltimaHora,
      totalVentas,
      descargasAPK,
      login: { ok: loginOk, fail: loginFail },
      alertas: alertasStr.length,
      incidentes: guiasBlocks.length,
      seguridad: {
        ipsSospechosas: ipsSospechosas.length,
        intentosBrute,
        bots: agentesRaros.length,
        exploits: peticionesRaras.length,
        nivel: nivelSeguridad,
      },
      telegram: tgResult.ok,
    });

  } catch (err) {
    console.error('[report-health]', err);
    try {
      await sendTelegram(`🔴 <b>WIL Monitor — ERROR</b>\n<code>${err.message?.substring(0,200)}</code>`);
    } catch(_) {}
    return res.status(500).json({ ok: false, error: err.message });
  }
}