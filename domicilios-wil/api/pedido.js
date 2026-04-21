// api/pedido.js
// GET /api/pedido?id=WIL-001
// Lee un pedido específico del sheet por ID

const { google } = require('googleapis');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function getSheets() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Falta id' });

  try {
    const sheets = await getSheets();
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: 'Pedidos!A2:Q',
    });

    const rows = resp.data.values || [];
    const r = rows.find(r => (r[0] || '').trim() === id);

    if (!r) return res.status(404).json({ error: 'Pedido no encontrado' });

    return res.status(200).json({
      ok: true,
      id:              (r[0]  || '').trim(),
      cliente:         (r[1]  || '').trim(),
      telefono:        (r[2]  || '').trim(),
      metodoPago:      (r[3]  || '').trim(),
      estado:          (r[4]  || '').trim().toUpperCase(),
      negocioNombre:   (r[5]  || '').trim(),
      tienda:          (r[6]  || '').trim() || null,
      productos:       (r[7]  || '').trim(),
      direccion:       (r[8]  || '').trim(),
      precioDomicilio: parseFloat((r[9]  || '0').replace(/[^0-9.]/g, '')) || 0,
      total:           parseFloat((r[10] || '0').replace(/[^0-9.]/g, '')) || 0,
      domiciliario:    (r[11] || '').trim(),
      hora:            (r[12] || '').trim(),
      fecha:           (r[13] || '').trim(),
      presupuesto:     (r[14] || '').trim(),
      barrioDetectado: (r[15] || '').trim(),
      horaEntrega:     (r[16] || '').trim(),
    });

  } catch (e) {
    console.error('api/pedido ERROR:', e.message);
    return res.status(500).json({ error: 'Error leyendo pedido', detail: e.message });
  }
};