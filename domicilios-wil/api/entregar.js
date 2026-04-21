// api/entregar.js
// POST /api/entregar
// Body: { pedidoId, domiciliarioNombre }
// Actualiza estado a FINALIZADO en el sheet + hora de entrega

const { google } = require('googleapis');
const moment = require('moment-timezone');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function getSheets() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

async function notificarTelegram(chatId, texto) {
  const token = process.env.BOT_TOKEN;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: 'HTML' }),
    });
  } catch (e) { console.warn('notificarTelegram:', e.message); }
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const { pedidoId, domiciliarioNombre } = req.body;

  if (!pedidoId) {
    return res.status(400).json({ error: 'Falta pedidoId' });
  }

  try {
    const sheets = await getSheets();

    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: 'Pedidos!A2:P',
    });

    const rows = resp.data.values || [];
    const idx = rows.findIndex(r => (r[0] || '').trim() === pedidoId);

    if (idx === -1) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const fila = idx + 2;
    const hora = moment().tz('America/Bogota').format('hh:mm A');
    const fecha = moment().tz('America/Bogota').format('DD/MM/YYYY');

    // Columnas a actualizar:
    // E = ESTADO → FINALIZADO
    // columna Q (17) = HORA_ENTREGA (si existe, si no usa M)
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      resource: {
        valueInputOption: 'USER_ENTERED',
        data: [
          { range: `Pedidos!E${fila}`, values: [['FINALIZADO']] },
          { range: `Pedidos!Q${fila}`, values: [[hora]] }, // hora entrega
        ],
      },
    });

    console.log(`🟢 Pedido ${pedidoId} FINALIZADO ⏰ ${hora}`);

    // Notificar canal
    const canalId = (process.env.CANAL_PEDIDOS_ID || '').trim();
    if (canalId) {
      const clienteNombre = (rows[idx][1] || '—').trim();
      const direccion = (rows[idx][8] || '—').trim();
      const domi = domiciliarioNombre || (rows[idx][11] || '—').trim();
      const total = (rows[idx][10] || '').trim();
      await notificarTelegram(canalId,
        `🟢 <b>ENTREGADO — ${pedidoId}</b>\n` +
        `🛵 <b>${domi}</b>\n` +
        `👤 ${clienteNombre}  📍 ${direccion}\n` +
        (total ? `💵 <b>Total: $${total}</b>\n` : '') +
        `⏰ ${hora}`
      );
    }

    return res.status(200).json({ ok: true, pedidoId, hora });

  } catch (e) {
    console.error('api/entregar ERROR:', e.message);
    return res.status(500).json({ error: 'Error al marcar entregado', detail: e.message });
  }
};