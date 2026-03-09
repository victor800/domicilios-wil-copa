// api/import-stock.js
// POST /api/import-stock — recibe array de productos y los escribe en la hoja de stock
// Authorization: Bearer <google_id_token>

const { google }       = require('googleapis');
const { OAuth2Client } = require('google-auth-library');

async function verificarAdmin(token) {
  const client  = new OAuth2Client(process.env.GOOGLE_OAUTH_CLIENT_ID);
  const ticket  = await client.verifyIdToken({
    idToken:  token,
    audience: process.env.GOOGLE_OAUTH_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  const admins  = (process.env.ADMIN_EMAILS || '')
    .split(',').map(e => e.trim().toLowerCase());
  if (!admins.includes(payload.email.toLowerCase()))
    throw new Error('No autorizado');
  return payload;
}

// Soporta GOOGLE_SERVICE_ACCOUNT_KEY (JSON completo) O las variables separadas
// igual que productos.js — así ambos archivos usan la misma estrategia de auth
function getAuth() {
  let credentials;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  } else {
    credentials = {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key:  (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    };
  }
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    await verificarAdmin(token);

    const { tienda, productos } = req.body;
    if (!Array.isArray(productos) || productos.length === 0)
      return res.status(400).json({ error: 'Sin productos' });

    const hoja = (tienda || '').toUpperCase() === 'CENTRAL'
      ? 'STOCK_DROGUERIA_CENTRAL'
      : 'STOCK_DROGUERIA_EXPERTOS';

    const auth         = getAuth();
    const sheets       = google.sheets({ version: 'v4', auth: await auth.getClient() });
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID;

    // Limpiar hoja desde la fila 2 (mantener encabezado en fila 1)
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: `${hoja}!H2:M`,
    });

    // Columnas H-M: descripcion | laboratorio | (J vacía) | unidad | precio | precioUnitario
    const filas = productos.map(p => [
      p.descripcion    || '',
      p.laboratorio    || '',
      '',                          // J siempre vacía
      p.unidad         || '',
      p.precio         || '',
      p.precioUnitario || '',
    ]);

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range:            `${hoja}!H2`,
      valueInputOption: 'USER_ENTERED',
      resource:         { values: filas },
    });

    console.log(`📦 Import ${tienda}: ${filas.length} productos escritos en ${hoja}!H2:M`);
    res.status(200).json({ ok: true, count: filas.length });

  } catch (e) {
    console.error('import-stock error:', e.message);
    const status = e.message === 'No autorizado' ? 403 : 500;
    res.status(status).json({ error: e.message });
  }
};