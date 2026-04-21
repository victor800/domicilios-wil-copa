// api/tarifa.js
// GET /api/tarifa?q=barrio+o+direccion
// 1. Busca en hoja BARRIO,TARIFA del sheet
// 2. Si no → geocodifica Nominatim + calcula OSRM ($1800/km)

const { google } = require('googleapis');

const PRECIO_KM    = 1800;
const TARIFA_MIN   = 5000;
const SEDE_LAT     = 6.3497;
const SEDE_LNG     = -75.5078;

const MUNICIPIOS_FIJOS = [
  'itagüí','itagui','sabaneta','la estrella','caldas',
  'san antonio de prado','envigado','medellín','medellin',
  'bello','girardota','barbosa','rionegro','guarne',
  'marinilla','el carmen de viboral','la ceja','el retiro',
  'bogotá','bogota','cali','manizales'
];
const TARIFA_FIJA_LEJANO = 50000;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function norm(s) {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
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

async function buscarEnSheet(q) {
  try {
    const sheets = await getSheets();
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: 'BARRIO,TARIFA!A2:F',
    });
    const rows = resp.data.values || [];
    const qNorm = norm(q);

    // Buscar coincidencia exacta primero, luego parcial
    let match = rows.find(r => norm(r[0] || '') === qNorm);
    if (!match) match = rows.find(r => norm(r[0] || '').includes(qNorm) || qNorm.includes(norm(r[0] || '')));
    if (!match) return null;

    return {
      barrio:  (match[0] || '').trim(),
      tarifa:  parseFloat((match[1] || '0').replace(/[^0-9.]/g, '')) || 0,
      zona:    (match[2] || '').trim(),
      municipio:(match[3]|| '').trim(),
      lat:     parseFloat(match[4]) || null,
      lng:     parseFloat(match[5]) || null,
    };
  } catch (e) {
    console.warn('buscarEnSheet:', e.message);
    return null;
  }
}

async function geocodificarNominatim(q) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q + ', Antioquia, Colombia')}&format=json&limit=1`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'DomiciliosWIL/1.0', 'Accept-Language': 'es' }
    });
    const data = await res.json();
    if (data?.length) {
      return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), display: data[0].display_name };
    }
  } catch (e) { console.warn('Nominatim:', e.message); }
  return null;
}

async function calcularOSRM(lat2, lng2) {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${SEDE_LNG},${SEDE_LAT};${lng2},${lat2}?overview=false`;
    const res = await fetch(url);
    const data = await res.json();
    if (data?.routes?.[0]?.distance) {
      return data.routes[0].distance / 1000; // → km
    }
  } catch (e) { console.warn('OSRM:', e.message); }
  return null;
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Falta parámetro q' });

  try {
    // 1. Municipio con tarifa fija
    const qNorm = norm(q);
    const esFijo = MUNICIPIOS_FIJOS.some(m => qNorm.includes(norm(m)));
    if (esFijo) {
      return res.status(200).json({ ok: true, tarifa: TARIFA_FIJA_LEJANO, barrio: q, fuente: 'fijo' });
    }

    // 2. Buscar en sheet
    const fromSheet = await buscarEnSheet(q);
    if (fromSheet?.tarifa) {
      return res.status(200).json({ ok: true, ...fromSheet, fuente: 'sheet' });
    }

    // 3. Geocodificar + OSRM
    const geo = await geocodificarNominatim(q);
    if (geo) {
      const distKm = await calcularOSRM(geo.lat, geo.lng);
      if (distKm !== null) {
        const tarifa = Math.max(TARIFA_MIN, Math.round(distKm * PRECIO_KM / 100) * 100);
        return res.status(200).json({ ok: true, tarifa, barrio: q, distKm, fuente: 'osrm' });
      }
    }

    // 4. Sin resultado
    return res.status(200).json({ ok: true, tarifa: null, barrio: q, fuente: 'ninguna' });

  } catch (e) {
    console.error('api/tarifa ERROR:', e.message);
    return res.status(500).json({ error: 'Error calculando tarifa', detail: e.message });
  }
};