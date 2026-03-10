const { google } = require('googleapis');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const { productos, lote, total, tienda: t } = body;

    const tienda = (t || 'EXPERTOS').toUpperCase();
    const hoja = tienda === 'CENTRAL' ? 'STOCK_DROGUERIA_CENTRAL' : 'STOCK_DROGUERIA_EXPERTOS';

    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
    const sid = process.env.GOOGLE_SHEETS_ID;

    if (lote === 0) {
      await sheets.spreadsheets.values.clear({ spreadsheetId: sid, range: `${hoja}!A:E` });
      await sheets.spreadsheets.values.update({
        spreadsheetId: sid, range: `${hoja}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [['Descripción','Laboratorio','Unidad','Precio','Precio Unitario'], ...productos] },
      });
    } else {
      const startRow = lote * 500 + 2;
      await sheets.spreadsheets.values.update({
        spreadsheetId: sid, range: `${hoja}!A${startRow}`,
        valueInputOption: 'RAW',
        requestBody: { values: productos },
      });
    }

    res.status(200).json({ ok: true, lote, count: productos.length });
  } catch (e) {
    console.error('import API error:', e.message);
    res.status(500).json({ error: e.message });
  }
};
