// api/buscar-productos.js
// Busca coincidencias en STOCK_DROGUERIA_CENTRAL o STOCK_DROGUERIA_EXPERTOS
// ─────────────────────────────────────────────────────────────
// GET /api/buscar-productos?tienda=EXPERTOS&q=acetaminofen
// ─────────────────────────────────────────────────────────────

const { google } = require('googleapis');

// ── Auth Google ───────────────────────────────────────────────
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

// ── Normalizar texto para comparación fuzzy ───────────────────
function norm(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quitar tildes
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Score de coincidencia ─────────────────────────────────────
function score(haystack, needleWords) {
  const h = norm(haystack);
  let hits = 0;
  for (const w of needleWords) {
    if (h.includes(w)) hits++;
  }
  return hits;
}

// ── Parsear precio COP desde celda ───────────────────────────
function parsePrecio(val) {
  if (!val) return 0;
  const n = parseFloat(String(val).replace(/[^0-9.]/g, ''));
  return isNaN(n) ? 0 : Math.round(n);
}

// ── CORS ──────────────────────────────────────────────────────
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ═════════════════════════════════════════════════════════════
module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { tienda, q } = req.query;

  if (!q || q.trim().length < 2) {
    return res.status(400).json({ error: 'Búsqueda muy corta' });
  }
  if (!tienda || !['EXPERTOS', 'CENTRAL'].includes(tienda.toUpperCase())) {
    return res.status(400).json({ error: 'tienda debe ser EXPERTOS o CENTRAL' });
  }

  const sheetName = tienda.toUpperCase() === 'EXPERTOS'
    ? 'STOCK_DROGUERIA_EXPERTOS'
    : 'STOCK_DROGUERIA_CENTRAL';

  try {
    const sheets = await getSheets();

    // Columnas del sheet de stock:
    // A = Descripción, B = Laboratorio, C = Unidad,
    // D = Precio (precio por varios / precio venta),
    // E = Precio Unitario (precio por 1 unidad)
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: `${sheetName}!A2:E`,
    });

    const rows = resp.data.values || [];
    const needleWords = norm(q).split(' ').filter(w => w.length >= 2);

    // Buscar coincidencias
    const resultados = [];
    for (const r of rows) {
      const descripcion = (r[0] || '').trim();
      const laboratorio = (r[1] || '').trim();
      const unidad      = (r[2] || '').trim();
      const precio      = parsePrecio(r[3]);       // Precio (varios)
      const precioUnit  = parsePrecio(r[4]);       // Precio Unitario (1 und)

      if (!descripcion) continue;

      // Score: busca en descripción + unidad
      const s = score(descripcion, needleWords) + score(unidad, needleWords) * 0.5;
      if (s === 0) continue;

      // Precio a mostrar: precioUnit si existe, sino precio
      const precioMostrar = precioUnit > 0 ? precioUnit : precio;
      if (precioMostrar === 0) continue; // sin precio no se muestra

      resultados.push({
        descripcion,
        descripcionCompleta: descripcion,
        laboratorio,
        unidad,
        precioUnitario: precioUnit > 0 ? precioUnit : precio,
        precioUnidad:   precioUnit > 0 ? precioUnit : precio,
        precioVarios:   precio,
        tienePrecioVarios: precio > 0 && precioUnit > 0 && precio !== precioUnit,
        _score: s,
      });
    }

    // Ordenar por score descendente, máx 12 resultados
    resultados.sort((a, b) => b._score - a._score);
    const top = resultados.slice(0, 12).map(r => {
      const { _score, ...rest } = r;
      return rest;
    });

    return res.status(200).json({ ok: true, resultados: top, total: top.length });

  } catch (e) {
    console.error('buscar-productos ERROR:', e.message);
    return res.status(500).json({ error: 'Error al buscar productos', detail: e.message });
  }
};