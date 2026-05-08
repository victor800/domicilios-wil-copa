const https   = require('https');
const moment  = require('moment-timezone');
const { google } = require('googleapis');

// ── Telegram ──────────────────────────────────────────────
function sendTelegram(text) {
  const token = process.env.MONITOR_TOKEN;
  const chat  = process.env.MONITOR_CHAT;
  const body  = JSON.stringify({ chat_id: chat, text, parse_mode: 'Markdown' });
  const req   = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${token}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  });
  req.on('error', () => {});
  req.write(body);
  req.end();
}

// ── Google Sheets ─────────────────────────────────────────
async function getPedidosHoy() {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: './credentials.json',
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const client  = await auth.getClient();
    const sheets  = google.sheets({ version: 'v4', auth: client });
    const res     = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: 'Pedidos!A2:T',
    });

    const hoy  = moment().tz('America/Bogota').format('DD/MM/YYYY');
    const rows = (res.data.values || []).filter(r => r[13] === hoy); // col N = FECHA

    const total       = rows.length;
    const entregados  = rows.filter(r => r[4] === 'Entregado').length;
    const enProceso   = rows.filter(r => r[4] === 'En proceso').length;
    const cancelados  = rows.filter(r => r[4] === 'Cancelado').length;
    const ingresos    = rows.reduce((s, r) => {
      const v = parseFloat((r[14] || '0').toString().replace(/\./g,'').replace(',','.'));
      return s + (isNaN(v) ? 0 : v);
    }, 0);

    // Método de pago más usado
    const metodos = {};
    rows.forEach(r => { const m = r[3] || 'N/A'; metodos[m] = (metodos[m] || 0) + 1; });
    const topMetodo = Object.entries(metodos).sort((a,b) => b[1]-a[1])[0];

    return { total, entregados, enProceso, cancelados, ingresos, topMetodo };
  } catch (e) {
    return null;
  }
}

// ── Handler ───────────────────────────────────────────────
module.exports = async (req, res) => {
  const ahora     = moment().tz('America/Bogota');
  const hora      = ahora.format('hh:mm A');
  const dia       = ahora.format('dddd D [de] MMMM YYYY');
  const horaH     = ahora.hour();
  const enHorario = horaH >= 9 && horaH < 23;
  const estado    = enHorario ? '🟢 App ACTIVA' : '🔴 App CERRADA (fuera de horario)';
  const horario   = enHorario ? 'Atendiendo hasta las *11:00 PM*' : 'Reabre a las *9:00 AM*';

  const pedidos = await getPedidosHoy();

  let reportePedidos = '';
  if (pedidos) {
    const ingresos = Math.round(pedidos.ingresos).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    reportePedidos =
      `\n📦 *Pedidos de hoy:*\n` +
      `• Total: *${pedidos.total}*\n` +
      `• ✅ Entregados: *${pedidos.entregados}*\n` +
      `• 🔄 En proceso: *${pedidos.enProceso}*\n` +
      `• ❌ Cancelados: *${pedidos.cancelados}*\n` +
      `• 💰 Ingresos: *$${ingresos}*\n` +
      `• 💳 Pago más usado: *${pedidos.topMetodo ? pedidos.topMetodo[0] : 'N/A'}*`;
  } else {
    reportePedidos = '\n📦 *Pedidos:* No se pudo consultar Sheets';
  }

  sendTelegram(
    `📊 *Reporte de salud — DomiciliosWil*\n\n` +
    `🕐 *${hora}* — ${dia}\n` +
    `${estado}\n` +
    `${horario}\n` +
    reportePedidos + `\n\n` +
    `✅ Servidor respondiendo correctamente`
  );

  res.json({ ok: true });
};
