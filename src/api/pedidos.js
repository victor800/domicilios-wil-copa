// api/pedidos.js
const { google } = require('googleapis');

function pn(v) { return parseInt((v||'0').toString().replace(/[^0-9]/g,'')) || 0; }

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const tienda = (req.query.tienda || 'EXPERTOS').toUpperCase();

    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key:  (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
    });
    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: 'Pedidos!A:R'
    });

    const rows = (r.data.values || []).slice(1)
      .filter(row => row[0]?.toString().trim())
      .filter(row => {
        const marca = (row[7] || '').toUpperCase();
        if (tienda === 'CENTRAL')  return marca.includes('CENTRAL');
        if (tienda === 'EXPERTOS') return marca.includes('EXPERTOS');
        return true;
      })
      .map(row => ({
        id:          (row[0]  || '').toString().trim(),
        cliente:     (row[1]  || '').toString().trim(),
        telefono:    (row[2]  || '').toString().trim(),
        metodoPago:  (row[3]  || '').toString().trim(),
        estado:      (row[4]  || '').toString().trim(),
        productos:   (row[6]  || '').toString().trim(),
        marca:       (row[7]  || '').toString().trim(),
        direccion:   (row[11] || '').toString().trim(),
        hora:        (row[12] || '').toString().trim(),
        fecha:       (row[13] || '').toString().trim(),
        total:       pn(row[14]),
        domiciliario:(row[15] || '').toString().trim(),
        horaTomo:    (row[16] || '').toString().trim(),
        horaEntrego: (row[17] || '').toString().trim(),
      }))
      .reverse();

    res.status(200).json(rows);
  } catch (e) {
    console.error('pedidos API error:', e.message);
    res.status(500).json({ error: e.message });
  }
};