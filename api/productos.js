// api/productos.js
const { google } = require('googleapis');

/* ══════════════════════════════════════════
   /api/gemini-distancia  — POST
   Calcula distancia real origen→destino
   usando OSRM (100% gratis, sin token)
   y devuelve { km, nota } al frontend
══════════════════════════════════════════ */
async function calcularDistanciaOSRM(origen, destino) {
  // Geocodificar con Nominatim
  async function geocode(txt) {
    const url = 'https://nominatim.openstreetmap.org/search?q='
      + encodeURIComponent(txt + ', Colombia')
      + '&format=json&limit=1&countrycodes=co';
    const r = await fetch(url, { headers: { 'User-Agent': 'DomiciliosWIL/1.0' } });
    const d = await r.json();
    if (!d.length) throw new Error('No se encontró: ' + txt);
    return { lat: parseFloat(d[0].lat), lng: parseFloat(d[0].lon), label: d[0].display_name };
  }

  const [A, B] = await Promise.all([geocode(origen), geocode(destino)]);

  const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${A.lng},${A.lat};${B.lng},${B.lat}?overview=false`;
  const ro = await fetch(osrmUrl);
  if (!ro.ok) throw new Error('OSRM sin respuesta');
  const od = await ro.json();
  if (!od.routes?.length) throw new Error('Ruta no encontrada');

  const km = od.routes[0].distance / 1000;
  return {
    km: parseFloat(km.toFixed(2)),
    nota: `Ruta verificada OpenStreetMap: ${A.label.split(',')[0]} → ${B.label.split(',')[0]} · ${km.toFixed(1)} km en carretera.`
  };
}

/* ══════════════════════════════════════════
   HANDLER PRINCIPAL
══════════════════════════════════════════ */
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  /* ── Enrutar /api/gemini-distancia ── */
  if (req.url?.includes('gemini-distancia') || req.query._ruta === 'gemini-distancia') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Solo POST' });
    try {
      let body = req.body;
      if (!body && req.method === 'POST') {
        // por si Vercel no parsea automáticamente
        const raw = await new Promise((resolve, reject) => {
          let data = '';
          req.on('data', c => data += c);
          req.on('end', () => resolve(data));
          req.on('error', reject);
        });
        body = JSON.parse(raw || '{}');
      }
      const { origen, destino } = body;
      if (!origen || !destino) return res.status(400).json({ error: 'Faltan origen y destino' });
      const result = await calcularDistanciaOSRM(origen, destino);
      return res.status(200).json(result);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  /* ══════════════════════════════════════════
     /api/productos  — lógica original intacta
  ══════════════════════════════════════════ */
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
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: `${hoja}!A:E`,
    });

    const rows = (r.data.values || []).slice(1);

    const productos = rows
      .filter(row => row[0]?.toString().trim())
      .map(row => ({
        descripcion:    (row[0] || '').toString().trim(),
        laboratorio:    (row[1] || '').toString().trim(),
        unidad:         (row[2] || '').toString().trim(),
        precio:         (row[3] || '').toString().trim(),
        precioUnitario: (row[4] || '').toString().trim(),
      }))
      .filter(p => p.descripcion.length > 0)
      .filter(p => {
        if (!q) return true;
        return (
          p.descripcion.toUpperCase().includes(q) ||
          p.laboratorio.toUpperCase().includes(q)
        );
      });

    res.status(200).json(productos);
  } catch (e) {
    console.error('productos API error:', e.message);
    res.status(500).json({ error: 'Error interno al obtener productos', detail: e.message });
  }
};