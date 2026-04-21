// api/notificar.js
// POST /api/notificar
// Body: { tipo, titulo, mensaje, url, targets }
// Envía notificación push a todos los suscritos del tipo indicado
// tipos: 'domi' | 'admin' | 'cliente' | 'all'

const { google } = require('googleapis');
const webpush = require('web-push');

// Configurar VAPID
webpush.setVapidDetails(
  'mailto:' + (process.env.VAPID_EMAIL || 'admin@domicilioswil.com'),
  process.env.VAPID_PUBLIC_KEY || '',
  process.env.VAPID_PRIVATE_KEY || ''
);

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

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const {
    tipo = 'domi',
    titulo = '🛵 Domicilios WIL',
    mensaje = 'Tienes una notificación nueva',
    url = '/',
    pedidoId = '',
  } = req.body;

  try {
    const sheets = await getSheets();
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: 'PushSubs!A2:E',
    });

    const rows = resp.data.values || [];

    // Filtrar por tipo
    const targets = rows.filter(r => {
      const t = (r[0] || '').toLowerCase();
      if (tipo === 'all') return true;
      return t === tipo;
    });

    if (!targets.length) {
      return res.status(200).json({ ok: true, enviados: 0, msg: 'Sin suscriptores' });
    }

    const payload = JSON.stringify({
      title: titulo,
      body: mensaje,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      url,
      pedidoId,
      timestamp: Date.now(),
    });

    let enviados = 0;
    let errores = 0;

    await Promise.allSettled(targets.map(async r => {
      const endpoint = r[2];
      const p256dh  = r[3];
      const auth    = r[4];

      if (!endpoint || !p256dh || !auth) return;

      const sub = { endpoint, keys: { p256dh, auth } };

      try {
        await webpush.sendNotification(sub, payload);
        enviados++;
      } catch (e) {
        errores++;
        console.warn(`Push failed ${endpoint.slice(-20)}:`, e.message);
      }
    }));

    console.log(`📲 Push enviadas: ${enviados} ok, ${errores} errores`);
    return res.status(200).json({ ok: true, enviados, errores });

  } catch (e) {
    console.error('api/notificar ERROR:', e.message);
    return res.status(500).json({ error: e.message });
  }
};