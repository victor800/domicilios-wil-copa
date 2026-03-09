// api/productos.js
// GET /api/productos?tienda=EXPERTOS&q=ibuprofeno
// Columnas A–E de STOCK_DROGUERIA_*:
//   A=Descripción  B=Laboratorio  C=Unidad  D=Precio  E=Precio Unitario

const { google } = require('googleapis');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const tienda    = (req.query.tienda || 'EXPERTOS').toUpperCase();
    const hoja      = tienda === 'CENTRAL'
      ? 'STOCK_DROGUERIA_CENTRAL'
      : 'STOCK_DROGUERIA_EXPERTOS';
    const q         = (req.query.q || '').toUpperCase().trim();
    const todosBool = req.query.all === '1';

    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    const auth  = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
    });
    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

    // ← CAMBIO: ahora lee A:E en vez de H:M
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: `${hoja}!A:E`
    });

    const rows = (r.data.values || []).slice(1); // saltar fila de encabezados

    const productos = rows
      .filter(row => row[0]?.toString().trim())  // descripción no vacía
      .map(row => ({
        descripcion:    (row[0] || '').toString().trim(),  // A
        laboratorio:    (row[1] || '').toString().trim(),  // B
        unidad:         (row[2] || '').toString().trim(),  // C
        precio:         (row[3] || '').toString().trim(),  // D
        precioUnitario: (row[4] || '').toString().trim(),  // E
      }))
      .filter(p => {
        if (!q || todosBool) return true;
        return (
          p.descripcion.toUpperCase().includes(q) ||
          p.laboratorio.toUpperCase().includes(q)
        );
      })
      .slice(0, todosBool ? 5000 : 150);

    res.status(200).json(productos);
  } catch (e) {
    console.error('productos API error:', e.message);
    res.status(500).json({ error: 'Error interno al obtener productos', detail: e.message });
  }
};