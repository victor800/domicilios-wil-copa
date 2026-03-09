// api/productos.js
const { google } = require('googleapis');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const tienda = (req.query.tienda || 'EXPERTOS').toUpperCase();
    const hoja   = tienda === 'CENTRAL'
      ? 'STOCK_DROGUERIA_CENTRAL'
      : 'STOCK_DROGUERIA_EXPERTOS';
    const q      = (req.query.q || '').toUpperCase().trim();

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
      range: `${hoja}!A:E`
    });

    const rows = (r.data.values || []).slice(1); // saltar fila de encabezado

    const productos = rows
      .filter(row => row[0]?.toString().trim())  // omitir filas vacías o sin descripción
      .map(row => ({
        descripcion:    (row[0] || '').toString().trim(),
        laboratorio:    (row[1] || '').toString().trim(),
        unidad:         (row[2] || '').toString().trim(),
        precio:         (row[3] || '').toString().trim(),
        precioUnitario: (row[4] || '').toString().trim(),
      }))
      .filter(p => p.descripcion.length > 0)     // segunda pasada por seguridad
      .filter(p => {
        if (!q) return true;                      // sin búsqueda → devolver todos
        return (
          p.descripcion.toUpperCase().includes(q) ||
          p.laboratorio.toUpperCase().includes(q)
        );
      });
    // Sin .slice() → se devuelven TODOS los productos sin límite

    res.status(200).json(productos);
  } catch (e) {
    console.error('productos API error:', e.message);
    res.status(500).json({ error: 'Error interno al obtener productos', detail: e.message });
  }
};
