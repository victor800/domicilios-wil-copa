// api/productos.js
// GET /api/productos?tienda=EXPERTOS&q=ibuprofeno
// Columnas H–M de STOCK_DROGUERIA_*:
//   H=Descripción  I=Laboratorio  J=VACÍA(omitir)  K=Unidad  L=Precio  M=Precio Unitario

const { google } = require('googleapis');

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const tienda   = (req.query.tienda || 'EXPERTOS').toUpperCase();
    const hoja     = tienda === 'CENTRAL'
      ? 'STOCK_DROGUERIA_CENTRAL'
      : 'STOCK_DROGUERIA_EXPERTOS';
    const q        = (req.query.q || '').toUpperCase().trim();
    const todosBool = req.query.all === '1';   // admin quiere todos sin filtro

    // Autenticación con Service Account
    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    const auth  = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
    });
    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

    // Leer H:M (col 8–13, índices 0–5 dentro del rango)
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: `${hoja}!H:M`
    });

    const rows = (r.data.values || []).slice(1); // saltar encabezado

    const productos = rows
      .filter(row => row[0] && row[3]) // descripción y precio no vacíos
      .map(row => ({
        descripcion:    (row[0] || '').toString().trim(),
        laboratorio:    (row[1] || '').toString().trim(),
        // row[2] = columna J → OMITIDA
        unidad:         (row[3] || '').toString().trim(),
        precio:         (row[4] || '').toString().trim(),
        precioUnitario: (row[5] || '').toString().trim(),
      }))
      .filter(p => p.descripcion)
      .filter(p => {
        if (!q || todosBool) return true;
        return (
          p.descripcion.toUpperCase().includes(q) ||
          p.laboratorio.toUpperCase().includes(q)
        );
      })
      .slice(0, todosBool ? 5000 : 150); // admin = todos; clientes = 150 max

    res.status(200).json(productos);
  } catch (e) {
    console.error('productos API error:', e.message);
    res.status(500).json({ error: 'Error interno al obtener productos', detail: e.message });
  }
};