// api/suscribir.js
// POST /api/suscribir
// Body: { subscription, tipo, nombre }
// Guarda la suscripción push en hoja "PushSubs" del sheet
// Columnas: A=tipo(domi/cliente/admin) B=nombre C=endpoint D=p256dh E=auth F=fecha

const { google } = require('googleapis');

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

  const { subscription, tipo = 'cliente', nombre = '' } = req.body;

  if (!subscription?.endpoint) {
    return res.status(400).json({ error: 'Suscripción inválida' });
  }

  try {
    const sheets = await getSheets();
    const fecha = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });

    // Buscar si ya existe este endpoint para no duplicar
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: 'PushSubs!A2:C',
    });

    const rows = resp.data.values || [];
    const existe = rows.some(r => (r[2] || '') === subscription.endpoint);

    if (!existe) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.GOOGLE_SHEETS_ID,
        range: 'PushSubs!A:F',
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [[
            tipo,
            nombre,
            subscription.endpoint,
            subscription.keys?.p256dh || '',
            subscription.keys?.auth || '',
            fecha,
          ]],
        },
      });
      console.log(`✅ Push sub guardada: ${tipo} — ${nombre}`);
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('api/suscribir ERROR:', e.message);
    return res.status(500).json({ error: e.message });
  }
};