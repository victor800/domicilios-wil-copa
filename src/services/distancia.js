
const axios  = require('axios');
const { google } = require('googleapis');
const { obtenerPrecio } = require('../data/tarifas');

// ─── Sede WIL — actualiza con coords reales del Parque de Copacabana ─────────
const SEDE = { lat: 6.3536, lng: -75.4832 };

// ─── Cache en memoria para no consultar Sheets en cada pedido ─────────────────
let cacheCoords   = null;   // { 'ASUNCIÓN': { lat, lng, tarifa }, ... }
let cacheTimestamp = 0;
const CACHE_TTL   = 1000 * 60 * 30; // 30 minutos

const auth = new google.auth.GoogleAuth({
  keyFile: './credentials.json',
  scopes:  ['https://www.googleapis.com/auth/spreadsheets']
});

// ─────────────────────────────────────────────────────────────────────────────
// LEER COORDENADAS DESDE SHEETS
// Hoja: coordenadas | Columnas: A=BARRIO B=LAT C=LNG D=TARIFA E=NOTAS
// ─────────────────────────────────────────────────────────────────────────────
async function cargarCoordenadas() {
  const ahora = Date.now();

  // Retornar cache si está fresco
  if (cacheCoords && (ahora - cacheTimestamp) < CACHE_TTL) {
    return cacheCoords;
  }

  try {
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });

    const res  = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: 'coordenadas!A:E'
    });

    const rows  = (res.data.values || []).slice(1); // saltar encabezado
    const mapa  = {};

    for (const row of rows) {
      const barrio  = (row[0] || '').toString().trim().toUpperCase();
      const lat     = parseFloat(row[1]);
      const lng     = parseFloat(row[2]);
      const tarifa  = parseInt((row[3] || '').toString().replace(/[^0-9]/g, '')) || null;

      if (barrio && !isNaN(lat) && !isNaN(lng)) {
        mapa[barrio] = { lat, lng, tarifa };
      }
    }

    cacheCoords    = mapa;
    cacheTimestamp = ahora;

    console.log(`📍 Coordenadas cargadas: ${Object.keys(mapa).length} barrios`);
    return mapa;

  } catch(e) {
    console.error('Error cargando coordenadas:', e.message);
    return cacheCoords || {}; // retornar cache viejo si hay error
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DETECTAR BARRIO en texto del cliente
// ─────────────────────────────────────────────────────────────────────────────
async function detectarBarrio(texto) {
  const coords = await cargarCoordenadas();
  const t      = (texto || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  let mejorBarrio = null;
  let mejorLen    = 0;

  for (const barrio of Object.keys(coords)) {
    const bn = barrio.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (t.includes(bn) && bn.length > mejorLen) {
      mejorBarrio = barrio;
      mejorLen    = bn.length;
    }
  }

  return mejorBarrio;
}

// ─────────────────────────────────────────────────────────────────────────────
// CALCULAR RUTA REAL con OSRM (gratis)
// ─────────────────────────────────────────────────────────────────────────────
async function calcularRutaOSRM(latD, lngD) {
  try {
    const url = `http://router.project-osrm.org/route/v1/driving/${SEDE.lng},${SEDE.lat};${lngD},${latD}?overview=false`;
    const res = await axios.get(url, { timeout: 10000 });

    if (res.data?.code !== 'Ok') return null;

    const r = res.data.routes[0];
    return {
      distancia: `${(r.distance / 1000).toFixed(1)} km`,
      moto:      `${Math.ceil(r.duration / 60 * 0.65)} min`,
      carro:     `${Math.ceil(r.duration / 60)} min`
    };
  } catch(e) {
    console.error('OSRM error:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNCIÓN PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────
async function calcularDistancia(texto) {
  const coordsMap = await cargarCoordenadas();
  const barrio    = await detectarBarrio(texto);
  const tarifa    = obtenerPrecio(texto) || (barrio && coordsMap[barrio]?.tarifa) || null;

  let coords = null;

  // ── Prioridad 1: coordenadas desde Sheets ────────────────────────────────
  if (barrio && coordsMap[barrio]) {
    coords = coordsMap[barrio];
    console.log(`📍 Barrio encontrado en Sheets: ${barrio}`);
  }

  // ── Prioridad 2: Nominatim para direcciones completas ────────────────────
  if (!coords) {
    try {
      const q   = encodeURIComponent(`${texto}, Copacabana, Antioquia, Colombia`);
      const geo = await axios.get(
        `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1&countrycodes=co`,
        { headers: { 'User-Agent': 'DomiciliosWIL/1.0' }, timeout: 8000 }
      );
      if (geo.data?.length) {
        coords = { lat: parseFloat(geo.data[0].lat), lng: parseFloat(geo.data[0].lon) };
        console.log(`📍 Geocodificado con Nominatim: ${texto}`);
      }
    } catch(e) {
      console.error('Nominatim error:', e.message);
    }
  }

  // ── Sin coordenadas ───────────────────────────────────────────────────────
  if (!coords) {
    return {
      error: true,
      msg:
        `⚠️ No encontré ese barrio.\n\n` +
        `Escribe el nombre del barrio exacto:\n` +
        `<i>Ej: "Asunción", "Fátima", "Tablazo"</i>\n\n` +
        `O una dirección completa:\n` +
        `<i>Ej: "Cra 50 #30-10, Barrio Asunción"</i>`
    };
  }

  // ── Calcular ruta REAL con OSRM ───────────────────────────────────────────
  const ruta = await calcularRutaOSRM(coords.lat, coords.lng);

  if (!ruta) {
    if (barrio && tarifa) {
      return { error:false, parcial:true, barrio, tarifa, distancia:'—', moto:'—', carro:'—' };
    }
    return { error: true, msg: '❌ No pude calcular la ruta. Intenta de nuevo.' };
  }

  return {
    error:     false,
    parcial:   false,
    distancia: ruta.distancia,
    moto:      ruta.moto,
    carro:     ruta.carro,
    barrio:    barrio || null,
    tarifa:    tarifa || null
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TARIFA RÁPIDA (sin calcular ruta) para el flujo del pedido
// ─────────────────────────────────────────────────────────────────────────────
async function obtenerTarifaRapida(texto) {
  const coordsMap = await cargarCoordenadas();
  const barrio    = await detectarBarrio(texto);
  const tarifa    = obtenerPrecio(texto) || (barrio && coordsMap[barrio]?.tarifa) || null;
  return { barrio, tarifa };
}

// ─────────────────────────────────────────────────────────────────────────────
// REFRESCAR CACHE manualmente (para admin)
// ─────────────────────────────────────────────────────────────────────────────
function limpiarCache() {
  cacheCoords    = null;
  cacheTimestamp = 0;
  console.log('🔄 Cache de coordenadas limpiado');
}

module.exports = { calcularDistancia, obtenerTarifaRapida, detectarBarrio, limpiarCache };