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
  const empty  = len - filled;
  const block  = isAttack ? '█' : '▓';
  const danger = isAttack && value > 0;
  return block.repeat(filled) + '░'.repeat(empty) + (danger ? ' ⚠' : '');
}

function spark(values) {
  const chars = ['▁','▂','▃','▄','▅','▆','▇','█'];
  const max   = Math.max(...values, 1);
  return values.map(v => chars[Math.round((v / max) * (chars.length - 1))]).join('');
}

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
    const db      = await getDB();
    const now     = new Date();
    const hace1h  = new Date(now - 1 * 60 * 60 * 1000);
    const hace6h  = new Date(now - 6 * 60 * 60 * 1000);
    const hace24h = new Date(now - 24 * 60 * 60 * 1000);
    const hace7d  = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const hoy     = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const proximo = new Date(now.getTime() + 60 * 60 * 1000);

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
      colPed.countDocuments({
        $or: [{ domiciliarioNombre: { $exists: false } },{ domiciliarioNombre: null },{ domiciliarioNombre: '' }],
        estado: { $nin: ['Entregado','Cancelado','entregado','cancelado'] },
      }),
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

    let accesosUltimaHora=0, accesos24h=0, errores404=0, errores500=0;
    let ipsSospechosas=[], ipsNuevas=[], agentesRaros=[];
    let peticionesRaras=[], pathsMasFrecuentes=[], trafficPorHora=[];
    let intentosBrute=0, descargasAPK=0;

    try {
      const colLogs = db.collection(COLS.logs);
      const [a1h,a24h,e404,e500,ips,ipN,agt,brute,paths,petR,trafH] = await Promise.all([
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
      ]);
      accesosUltimaHora=a1h; accesos24h=a24h; errores404=e404; errores500=e500;
      ipsSospechosas=ips; ipsNuevas=ipN; agentesRaros=agt;
      intentosBrute=brute; pathsMasFrecuentes=paths; peticionesRaras=petR; trafficPorHora=trafH;
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

    // Tráfico por hora
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

    // Alertas
    const alertasStr = [];
    if (sinAsignar > 0)         alertasStr.push(`  >> ${sinAsignar} pedido(s) SIN domiciliario asignado`);
    if (errores500 > 0)         alertasStr.push(`  >> ${errores500} errores 500 en ultima hora`);
    if (ipsSospechosas.length)  alertasStr.push(`  >> ${ipsSospechosas.length} IP(s) sospechosa(s) detectadas`);
    if (peticionesRaras.length) alertasStr.push(`  >> ${peticionesRaras.length} intento(s) de exploit`);
    if (intentosBrute > 10)     alertasStr.push(`  >> ${intentosBrute} intentos brute-force en login`);
    if (agentesRaros.length)    alertasStr.push(`  >> ${agentesRaros.length} bot/scanner activo`);
    if (duplicados > 0)         alertasStr.push(`  >> ${duplicados} telefono(s) con +3 pedidos/24h`);
    if (pedidosIncompletos > 0) alertasStr.push(`  >> ${pedidosIncompletos} pedido(s) con datos incompletos`);
    if (pedidosCancelados24h > 5) alertasStr.push(`  >> ${pedidosCancelados24h} cancelaciones en 24h`);
    if (errores404 > 20)        alertasStr.push(`  >> ${errores404} errores 404 — posible scraping`);

    const hayAlertas   = alertasStr.length > 0;
    const nivelSeguridad = hayAlertas
      ? Math.max(10, 100 - (alertasStr.length * 15))
      : 100;
    const barSeguridad = barChart(nivelSeguridad, 100, 12, hayAlertas);

    // Fechas formateadas
    const optsDate = { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Bogota' };
    const optsTime = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'America/Bogota' };
    const fechaScan  = now.toLocaleDateString('es-CO', optsDate).replace(/\//g,'/');
    const horaScan   = now.toLocaleTimeString('es-CO', optsTime);
    const fechaProx  = proximo.toLocaleDateString('es-CO', optsDate).replace(/\//g,'/');
    const horaProx   = proximo.toLocaleTimeString('es-CO', optsTime);
    const fechaLarga = now.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Bogota' });

    // Gráficas
    const pedHoraLines     = horasLabels.map((l,i) => `  ${l} ${barChart(horasValues[i],   maxPedHora, 14)}  ${String(horasValues[i]).padStart(4,' ')}`).join('\n');
    const trafficHoraLines = horasLabels.map((l,i) => `  ${l} ${barChart(trafficValues[i], maxTraffic, 14)}  ${String(trafficValues[i]).padStart(5,' ')}`).join('\n');
    const attackHoraLines  = horasLabels.map((l,i) => `  ${l} ${barChart(attackValues[i],  maxAttack,  14, true)}  ${String(attackValues[i]).padStart(4,' ')}`).join('\n');

    const maxDomiPed    = Math.max(...conPedidos.map(d => d.pedidosHoy), 1);
    const domiLines     = conPedidos.filter(d => d.pedidosHoy > 0)
      .map((d,i) => `  #${String(i+1).padStart(2,'0')} ${d.nombre.substring(0,10).padEnd(10,' ')} ${barChart(d.pedidosHoy, maxDomiPed, 10)}  ${d.pedidosHoy}`)
      .join('\n') || '  >> sin movimiento hoy';

    const maxCom        = topComercio[0]?.total || 1;
    const comercioLines = topComercio.map((c,i) =>
      `  ${String(i+1).padStart(2,'0')} ${(c._id||'?').substring(0,10).padEnd(10,' ')} ${barChart(c.total, maxCom, 10)}  ${c.total}`
    ).join('\n') || '  >> sin datos';

    const estadosOrden  = [['pendiente','PEND'],['asignado','ASIG'],['proceso','PROC'],['encamino','ENVO'],['entregado','ENTR'],['cancelado','CANC']];
    const maxEst        = Math.max(...estadosOrden.map(([k]) => estadoMap[k]||0), 1);
    const estadoLines   = estadosOrden.map(([k,label]) => {
      const n = estadoMap[k]||0; if (!n) return null;
      return `  ${label} ${barChart(n, maxEst, 12, k==='cancelado')}  ${String(n).padStart(4,' ')}`;
    }).filter(Boolean).join('\n') || '  >> sin datos';

    const ipsLines      = ipsSospechosas.length
      ? ipsSospechosas.map(x => `  ${x._id.padEnd(16,' ')} ${barChart(x.count, ipsSospechosas[0].count, 10, true)}  ${x.count} reqs`).join('\n')
      : '  >> ninguna detectada';

    const botsLines     = agentesRaros.length
      ? agentesRaros.map(x => `  [${x.count}x] ${x._id.substring(0,25)} :: ${x.ip||'?'}`).join('\n')
      : '  >> ninguno detectado';

    const exploitLines  = peticionesRaras.length
      ? peticionesRaras.map(x => `  [${x.count}x] ${(x._id||'?').substring(0,28)} >> ${x.ip||'?'}`).join('\n')
      : '  >> ninguno detectado';

    const maxPath       = pathsMasFrecuentes[0]?.count || 1;
    const pathLines     = pathsMasFrecuentes.length
      ? pathsMasFrecuentes.map(p => `  ${barChart(p.count, maxPath, 8)}  ${(p._id||'/').substring(0,25)}  (${p.count})`).join('\n')
      : '  >> sin datos';

    const sparkPed      = spark(horasValues);
    const sparkTraffic  = spark(trafficValues);
    const sparkAttack   = spark(attackValues);

    // ── MENSAJE ──────────────────────────────────────────────
    const msg = `👋 <b>Hola Victor!</b> Aquí tu informe WIL.

<pre>
╔══════════════════════════════════════╗
║     /\_____/\                       ║
║    /  o   o  \                      ║
║   ( ==  ^  == )    MONITOR  v2.0    ║
║    )         (                      ║
║   (           )                     ║
║  ( (  )   (  ) )                    ║
║  (__(__)___(__)__)                   ║
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
│  📱  A P P   A C T I V I D A D      │
├─────────────────────────────────────┤
  Descargas APK 24h  >>  ${fmt(descargasAPK)}

┌─────────────────────────────────────┐
│  🌐  T R A F I C O   W E B          │
├─────────────────────────────────────┤
  Requests 1h   >>  ${fmt(accesosUltimaHora)}
  Requests 24h  >>  ${fmt(accesos24h)}
  Errores 404   >>  ${fmt(errores404)}
  Errores 500   >>  ${fmt(errores500)}

  TENDENCIA 8H >> ${sparkTraffic}

  TRAFICO/HORA:
${trafficHoraLines}

  RUTAS MAS VISITADAS:
${pathLines}

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

╔══════════════════════════════════════╗
║  ESCANEO >>  ${fechaScan}  ${horaScan}  ║
║  PROXIMO >>  ${fechaProx}  ${horaProx}  ║
╠══════════════════════════════════════╣
║  AMENAZAS  >>  ${hayAlertas ? '!! ' + alertasStr.length + ' DETECTADA(S) !!' : 'NINGUNA              '}  ║
║  SEGURIDAD >>  ${barSeguridad}  ${String(nivelSeguridad).padStart(3,'0')}%  ║
║  SISTEMA   >>  ${hayAlertas ? '⚠ REVISAR AHORA      ' : '✓ TODO EN ORDEN      '}  ║
╠══════════════════════════════════════╣
║  >> Ing. Victor Henao                ║
║  >> WIL MONITOR v2.0                 ║
╚══════════════════════════════════════╝
</pre>`;

    const msgFinal = msg.length > 4000
      ? msg.substring(0, 3950) + '\n</pre>\n<i>...[truncado]</i>'
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