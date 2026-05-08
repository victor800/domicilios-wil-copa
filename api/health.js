const https  = require('https');
const moment = require('moment-timezone');
const { google } = require('googleapis');

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

async function getSheetsClient() {
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const auth  = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

async function getResumenHoy() {
  const sheets = await getSheetsClient();
  const hoy    = moment().tz('America/Bogota').format('DD/MM/YYYY');

  // Pedidos
  const pedRes  = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SHEETS_ID, range: 'Pedidos!A2:T' });
  const pedidos = (pedRes.data.values || []).filter(r => r[13] === hoy);
  const entregados = pedidos.filter(r => r[4] === 'Entregado').length;
  const enProceso  = pedidos.filter(r => r[4] === 'En proceso').length;
  const cancelados = pedidos.filter(r => r[4] === 'Cancelado').length;
  const ingresos   = pedidos.reduce((s, r) => {
    const v = parseFloat((r[14] || '0').toString().replace(/\./g,'').replace(',','.'));
    return s + (isNaN(v) ? 0 : v);
  }, 0);

  // Ataques
  const monRes   = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SHEETS_ID, range: 'Monitor!A2:H' });
  const eventos  = (monRes.data.values || []).filter(r => r[0] === hoy);
  const altas    = eventos.filter(r => r[7] === 'high').length;
  const medias   = eventos.filter(r => r[7] === 'medium').length;
  const tiposMap = {};
  eventos.forEach(r => { const t = r[4] || 'N/A'; tiposMap[t] = (tiposMap[t] || 0) + 1; });
  const topAtaque = Object.entries(tiposMap).sort((a,b) => b[1]-a[1])[0];

  return { pedidos: pedidos.length, entregados, enProceso, cancelados, ingresos, eventos: eventos.length, altas, medias, topAtaque };
}

module.exports = async (req, res) => {
  const ahora     = moment().tz('America/Bogota');
  const hora      = ahora.format('hh:mm A');
  const dia       = ahora.format('dddd D [de] MMMM YYYY');
  const horaH     = ahora.hour();
  const enHorario = horaH >= 9 && horaH < 23;
  const estado    = enHorario ? '🟢 App ACTIVA' : '🔴 App CERRADA (fuera de horario)';
  const horario   = enHorario ? 'Atendiendo hasta las *11:00 PM*' : 'Reabre a las *9:00 AM*';

  try {
    const d       = await getResumenHoy();
    const ingFmt  = Math.round(d.ingresos).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');

    sendTelegram(
      `📊 *Reporte DomiciliosWil*\n\n` +
      `🕐 *${hora}* — ${dia}\n` +
      `${estado} — ${horario}\n\n` +
      `📦 *Pedidos de hoy:*\n` +
      `• Total: *${d.pedidos}*\n` +
      `• ✅ Entregados: *${d.entregados}*\n` +
      `• 🔄 En proceso: *${d.enProceso}*\n` +
      `• ❌ Cancelados: *${d.cancelados}*\n` +
      `• 💰 Ingresos: *$${ingFmt}*\n\n` +
      `🔒 *Seguridad hoy:*\n` +
      `• Eventos totales: *${d.eventos}*\n` +
      `• 🚨 Alertas altas: *${d.altas}*\n` +
      `• ⚠️ Alertas medias: *${d.medias}*\n` +
      `• Tipo más frecuente: *${d.topAtaque ? d.topAtaque[0] : 'Ninguno'}*\n\n` +
      `✅ Servidor respondiendo correctamente`
    );

    res.json({ ok: true });
  } catch(e) {
    sendTelegram(`⚠️ *Error en reporte*\n\`${e.message}\``);
    res.json({ ok: false, error: e.message });
  }
};
