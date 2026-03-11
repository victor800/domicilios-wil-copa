// ══════════════════════════════════════════════════════════════════════════════
// distancia.js — Domicilios WIL
//
// VARIABLE DE ENTORNO OPCIONAL:
//   GOOGLE_MAPS_KEY=AIza...   (si no hay, usa solo Nominatim/Photon — gratis)
//
// SEDE: Cra. 50 #50-15, Copacabana, Antioquia
// ANCLA: Parque Principal Copacabana  6.3460765, -75.5083194
//
// FLUJO DE GEOCODIFICACIÓN (prioridad):
//   1. Cache sheet cols H/I          → 0 llamadas API
//   2. Google Maps Geocoding          → coord exacta (si GOOGLE_MAPS_KEY existe)
//   3. Nominatim (OpenStreetMap)      → gratuito, muy preciso
//   4. Photon (Komoot/OSM)            → gratuito, buen fallback para Colombia
//   5. Fallback barrio conocido       → hardcoded ~30 barrios comunes
//   6. Fallback municipio conocido    → hardcoded coordenada del centro
//
// REGLA DE COBRO:
//   precio = MAX( $1.800 × kmRuta, $5.000 mínimo )
//   kmRuta = haversine × 1.35  (o ruta real vía ORS/OSRM si disponible)
// ══════════════════════════════════════════════════════════════════════════════

const https = require('https');

const SEDE_LAT  = parseFloat(process.env.SEDE_LAT  || '6.35112');
const SEDE_LNG  = parseFloat(process.env.SEDE_LNG  || '-75.49190');
const SEDE_DIR  = 'Cra. 50 #50-15, Copacabana, Antioquia, Colombia';

const ANCLA_LAT = 6.3460765;
const ANCLA_LNG = -75.5083194;

const PRECIO_KM   = 1800;
const FACTOR_RUTA = 1.35;
const TARIFA_MIN  = 5000;

// ── Coordenadas de referencia por municipio (fallback) ────────────────────────
const MUNICIPIOS_COORDS = {
  'copacabana':           { lat: 6.35112,  lng: -75.49190 },
  'bello':                { lat: 6.33670,  lng: -75.55720 },
  'medellín':             { lat: 6.24420,  lng: -75.58120 },
  'medellin':             { lat: 6.24420,  lng: -75.58120 },
  'envigado':             { lat: 6.17520,  lng: -75.59280 },
  'itagüí':               { lat: 6.18430,  lng: -75.59900 },
  'itagui':               { lat: 6.18430,  lng: -75.59900 },
  'sabaneta':             { lat: 6.15140,  lng: -75.61750 },
  'la estrella':          { lat: 6.15720,  lng: -75.64270 },
  'caldas':               { lat: 6.09300,  lng: -75.63800 },
  'girardota':            { lat: 6.37830,  lng: -75.44480 },
  'barbosa':              { lat: 6.43790,  lng: -75.33160 },
  'rionegro':             { lat: 6.15530,  lng: -75.37410 },
  'guarne':               { lat: 6.27780,  lng: -75.45030 },
  'marinilla':            { lat: 6.17640,  lng: -75.34360 },
  'el peñol':             { lat: 6.21570,  lng: -75.23690 },
  'la ceja':              { lat: 6.02570,  lng: -75.43320 },
  'retiro':               { lat: 6.06370,  lng: -75.50700 },
  'el carmen de viboral': { lat: 6.08910,  lng: -75.31840 },
  'san vicente ferrer':   { lat: 6.30870,  lng: -75.33100 },
};

// ── Barrios conocidos con coords aproximadas ──────────────────────────────────
const BARRIOS_CONOCIDOS = {
  // Medellín
  'castilla':        { lat: 6.29300, lng: -75.59900, municipio: 'Medellín' },
  'laureles':        { lat: 6.24370, lng: -75.60350, municipio: 'Medellín' },
  'el poblado':      { lat: 6.20990, lng: -75.56860, municipio: 'Medellín' },
  'poblado':         { lat: 6.20990, lng: -75.56860, municipio: 'Medellín' },
  'belén':           { lat: 6.22140, lng: -75.61360, municipio: 'Medellín' },
  'belen':           { lat: 6.22140, lng: -75.61360, municipio: 'Medellín' },
  'robledo':         { lat: 6.28200, lng: -75.60560, municipio: 'Medellín' },
  'aranjuez':        { lat: 6.27900, lng: -75.56050, municipio: 'Medellín' },
  'manrique':        { lat: 6.27300, lng: -75.55120, municipio: 'Medellín' },
  'boston':          { lat: 6.25200, lng: -75.55980, municipio: 'Medellín' },
  'la america':      { lat: 6.24600, lng: -75.60820, municipio: 'Medellín' },
  'la candelaria':   { lat: 6.25180, lng: -75.56360, municipio: 'Medellín' },
  'centro':          { lat: 6.25180, lng: -75.56360, municipio: 'Medellín' },
  'buenos aires':    { lat: 6.23900, lng: -75.55800, municipio: 'Medellín' },
  'floresta':        { lat: 6.25400, lng: -75.61200, municipio: 'Medellín' },
  'calasanz':        { lat: 6.25900, lng: -75.60600, municipio: 'Medellín' },
  'doce de octubre': { lat: 6.28500, lng: -75.57800, municipio: 'Medellín' },
  'campo amor':      { lat: 6.22700, lng: -75.59400, municipio: 'Medellín' },
  'san javier':      { lat: 6.24800, lng: -75.62400, municipio: 'Medellín' },
  'guayabal':        { lat: 6.22000, lng: -75.58900, municipio: 'Medellín' },
  'santa cruz':      { lat: 6.28100, lng: -75.56200, municipio: 'Medellín' },
  'villa hermosa':   { lat: 6.24900, lng: -75.54800, municipio: 'Medellín' },
  'el salvador':     { lat: 6.25600, lng: -75.55100, municipio: 'Medellín' },
  'la milagrosa':    { lat: 6.25800, lng: -75.55600, municipio: 'Medellín' },
  'conquistadores':  { lat: 6.25100, lng: -75.60100, municipio: 'Medellín' },
  'estadio':         { lat: 6.25600, lng: -75.59400, municipio: 'Medellín' },
  'bello':           { lat: 6.33670, lng: -75.55720, municipio: 'Bello' },
  // Bello
  'obrero':          { lat: 6.32400, lng: -75.56100, municipio: 'Bello' },
  'niquía':          { lat: 6.31850, lng: -75.52150, municipio: 'Bello' },
  'niquia':          { lat: 6.31850, lng: -75.52150, municipio: 'Bello' },
  'la madera':       { lat: 6.34500, lng: -75.55000, municipio: 'Bello' },
  'paris':           { lat: 6.34100, lng: -75.56200, municipio: 'Bello' },
  'zamora':          { lat: 6.33200, lng: -75.56800, municipio: 'Bello' },
  // Otros municipios
  'girardota':       { lat: 6.37830, lng: -75.44480, municipio: 'Girardota' },
  'barbosa':         { lat: 6.43790, lng: -75.33160, municipio: 'Barbosa' },
  'envigado':        { lat: 6.17520, lng: -75.59280, municipio: 'Envigado' },
  'sabaneta':        { lat: 6.15140, lng: -75.61750, municipio: 'Sabaneta' },
  'itagüí':          { lat: 6.18430, lng: -75.59900, municipio: 'Itagüí' },
  'itagui':          { lat: 6.18430, lng: -75.59900, municipio: 'Itagüí' },
  // Copacabana
  'la asuncion':     { lat: 6.3510,  lng: -75.4940,  municipio: 'Copacabana' },
  'la asunción':     { lat: 6.3510,  lng: -75.4940,  municipio: 'Copacabana' },
  'el carmelo':      { lat: 6.3480,  lng: -75.4960,  municipio: 'Copacabana' },
  'los balsos':      { lat: 6.3490,  lng: -75.5010,  municipio: 'Copacabana' },
  'el recreo':       { lat: 6.3530,  lng: -75.4890,  municipio: 'Copacabana' },
  'campo alegre':    { lat: 6.3440,  lng: -75.5070,  municipio: 'Copacabana' },
  'villamaria':      { lat: 6.3550,  lng: -75.4920,  municipio: 'Copacabana' },
  'el tablazo':      { lat: 6.3600,  lng: -75.5100,  municipio: 'Copacabana' },
  'san antonio':     { lat: 6.3460,  lng: -75.5083,  municipio: 'Copacabana' },
  'niquia copacabana': { lat: 6.3480, lng: -75.5010, municipio: 'Copacabana' },
};

// ── Haversine ─────────────────────────────────────────────────────────────────
function haversineKm(lat1, lng1, lat2, lng2) {
  const R  = 6371;
  const dL = (lat2 - lat1) * Math.PI / 180;
  const dG = (lng2 - lng1) * Math.PI / 180;
  const a  = Math.sin(dL/2)**2 +
    Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dG/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Ruta real por carretera (ORS → OSRM público → haversine fallback) ─────────
const _orsCache = new Map();

async function calcularRutaORS(latO, lngO, latD, lngD) {
  const key = `${latO.toFixed(4)},${lngO.toFixed(4)}|${latD.toFixed(4)},${lngD.toFixed(4)}`;
  if (_orsCache.has(key)) return _orsCache.get(key);

  const ORS_KEY = process.env.ORS_API_KEY;

  // Intento 1: ORS API oficial (~2000 req/día gratis con key)
  if (ORS_KEY) {
    try {
      const body = JSON.stringify({ coordinates: [[lngO, latO], [lngD, latD]], units: 'km' });
      const data = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.openrouteservice.org',
          path: '/v2/directions/driving-car',
          method: 'POST',
          headers: { 'Authorization': ORS_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          timeout: 8000
        }, res => {
          let d = ''; res.on('data', c => d += c);
          res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout ORS')); });
        req.write(body); req.end();
      });
      const seg = data?.routes?.[0]?.summary;
      if (seg?.distance && seg?.duration) {
        const r = { distanciaKm: Math.round(seg.distance * 10) / 10, duracionMin: Math.round(seg.duration / 60), fuente: 'ors' };
        _orsCache.set(key, r);
        console.log(`🛣️ ORS: ${r.distanciaKm}km ${r.duracionMin}min`);
        return r;
      }
    } catch(e) { console.error('ORS:', e.message); }
  }

  // Intento 2: OSRM público (sin key, gratuito)
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${lngO},${latO};${lngD},${latD}?overview=false`;
    const data = await new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: { 'User-Agent': 'DomiciliosWIL/1.0' }, timeout: 7000
      }, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout OSRM')); });
    });
    const ruta = data?.routes?.[0];
    if (ruta?.distance && ruta?.duration) {
      const r = { distanciaKm: Math.round(ruta.distance / 1000 * 10) / 10, duracionMin: Math.round(ruta.duration / 60), fuente: 'osrm' };
      _orsCache.set(key, r);
      console.log(`🛣️ OSRM: ${r.distanciaKm}km ${r.duracionMin}min`);
      return r;
    }
  } catch(e) { console.error('OSRM:', e.message); }

  // Fallback: haversine × FACTOR_RUTA
  const lineal = haversineKm(latO, lngO, latD, lngD);
  const km     = Math.round(lineal * FACTOR_RUTA * 10) / 10;
  console.log(`📐 Haversine fallback: ${km}km`);
  return { distanciaKm: km, duracionMin: Math.round(km / 25 * 60), fuente: 'haversine' };
}

// ── Precio SEDE → destino ─────────────────────────────────────────────────────
async function calcularTarifaKm(latDest, lngDest) {
  const { distanciaKm, duracionMin, fuente } = await calcularRutaORS(SEDE_LAT, SEDE_LNG, latDest, lngDest);
  const precio  = Math.max(Math.round(distanciaKm * PRECIO_KM / 500) * 500, TARIFA_MIN);
  const lineal  = Math.round(haversineKm(SEDE_LAT, SEDE_LNG, latDest, lngDest) * 10) / 10;
  return {
    precio, distRutaKm: distanciaKm, distLinealKm: lineal,
    duracionMin, fuente,
    formula: `${distanciaKm}km (${fuente}) × $${PRECIO_KM} = $${precio}`
  };
}

// ── Precio entre dos puntos arbitrarios (paquetes) ───────────────────────────
function calcularPrecioPorKm(latO, lngO, latD, lngD) {
  const lineal = haversineKm(latO, lngO, latD, lngD);
  const ruta   = Math.round(lineal * FACTOR_RUTA * 10) / 10;
  const precio = Math.max(Math.round(ruta * PRECIO_KM / 500) * 500, TARIFA_MIN);
  return {
    distanciaLinealKm: Math.round(lineal * 10) / 10,
    distanciaRutaKm:   ruta,
    precioCOP:         precio,
    formula:           `${Math.round(lineal*10)/10}km × ${FACTOR_RUTA} = ${ruta}km × $${PRECIO_KM} = $${precio}`
  };
}

function calcularPreciosPaquete(tarifaBase) {
  if (!tarifaBase) return { paqPeq: null, paqMed: null, paqGran: null };
  return { paqPeq: tarifaBase, paqMed: tarifaBase, paqGran: tarifaBase };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function esZonaCopacabana(municipio, barrio) {
  const m = (municipio || '').toLowerCase().trim();
  const b = (barrio    || '').toLowerCase().trim();
  if (m.includes('copacabana')) return true;
  if (m.includes('bello') && (b.includes('niquía') || b.includes('niquia'))) return true;
  return false;
}

function zonaLegible(municipio, barrio) {
  if (!municipio) return 'Área Metropolitana';
  const m = municipio.toLowerCase();
  const b = (barrio || '').toLowerCase();
  if (m.includes('copacabana'))   return 'Copacabana';
  if (m.includes('bello')) {
    if (b.includes('niquía') || b.includes('niquia')) return 'Copacabana / Niquía';
    return 'Bello';
  }
  if (m.includes('girardota'))    return 'Girardota';
  if (m.includes('barbosa'))      return 'Barbosa';
  if (m.includes('itagüí') || m.includes('itagui')) return 'Itagüí';
  if (m.includes('envigado'))     return 'Envigado';
  if (m.includes('sabaneta'))     return 'Sabaneta';
  if (m.includes('la estrella'))  return 'La Estrella';
  if (m.includes('caldas'))       return 'Caldas';
  if (m.includes('rionegro')  || m.includes('guarne')   || m.includes('marinilla') ||
      m.includes('carmen')    || m.includes('peñol')    || m.includes('santuario') ||
      m.includes('retiro')    || m.includes('la ceja')  || m.includes('san vicente')) {
    return 'Oriente Antioqueño';
  }
  if (m.includes('medellín') || m.includes('medellin')) return 'Medellín';
  return municipio;
}

function detectarMunicipioEnTexto(texto) {
  if (!texto) return null;
  const t = texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const orden = [
    'el carmen de viboral','carmen de viboral','san vicente ferrer','san vicente',
    'el santuario','el penol','la estrella','la ceja','la union',
    'copacabana','girardota','barbosa','rionegro','marinilla','guarne',
    'envigado','sabaneta','itagui','retiro','caldas','bello','medellin'
  ];
  for (const mun of orden) {
    if (t.includes(mun))
      return mun.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }
  return null;
}

function detectarBarrioEnTexto(texto) {
  if (!texto) return null;
  const t = texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const orden = Object.keys(BARRIOS_CONOCIDOS).sort((a, b) => b.length - a.length);
  for (const barrio of orden) {
    const bn = barrio.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (t.includes(bn)) return { barrio, ...BARRIOS_CONOCIDOS[barrio] };
  }
  return null;
}

function _enZonaCobertura(lat, lng) {
  return lat >= 5.80 && lat <= 6.70 && lng >= -76.00 && lng <= -74.80;
}

// ── Utilidad HTTP genérica con timeout ───────────────────────────────────────
function _httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'DomiciliosWIL/1.0 (copacabana-antioquia-colombia)', ...headers },
      timeout: 7000
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(new Error('JSON inválido')); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── Construir resultado geocodificado ────────────────────────────────────────
async function _construirResultado(lat, lng, barrio, municipio, direccionFmt, confianza, fuente) {
  const esCopa = esZonaCopacabana(municipio, barrio);
  const calc   = await calcularTarifaKm(lat, lng);
  const zona   = zonaLegible(municipio, barrio);
  const obs    = confianza === 'alta'
    ? 'Dirección verificada ✅'
    : confianza === 'media'
      ? 'Verificado por OpenStreetMap ✅'
      : 'Coordenadas aproximadas — confirmar con el cliente ⚠️';
  return {
    lat, lng, barrio, municipio, zona,
    tarifa:              esCopa ? null : calc.precio,
    tarifaCalculada:     calc.precio,
    distRutaKm:          calc.distRutaKm,
    distLinealKm:        calc.distLinealKm,
    formula:             calc.formula,
    esCobertura:         true,
    esCoherente:         true,
    confianzaGeo:        confianza,
    fuenteGeo:           fuente,
    direccionFormateada: direccionFmt || '',
    observaciones:       obs
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// NOMINATIM — geocodificación directa
// Estrategia de queries múltiples: de más específica a más general
// ══════════════════════════════════════════════════════════════════════════════
const _nomCache = new Map();

async function geocodificarNominatim(textoCliente) {
  const cacheKey = (textoCliente || '').toLowerCase().trim();
  if (_nomCache.has(cacheKey)) {
    console.log(`📦 Cache Nominatim: "${textoCliente}"`);
    return _nomCache.get(cacheKey);
  }

  // Detectar municipio en el texto para construir queries más precisas
  const municipioDetect = detectarMunicipioEnTexto(textoCliente);

  // Queries en orden de precisión — de más específica a más general
  const queries = [];

  if (municipioDetect) {
    // Si el texto ya menciona el municipio, usarlo directo
    queries.push(`${textoCliente}, Antioquia, Colombia`);
    queries.push(`${textoCliente}, Colombia`);
  } else {
    // Sin municipio explícito → probar primero con Copacabana (sede), luego abrir
    queries.push(`${textoCliente}, Copacabana, Antioquia, Colombia`);
    queries.push(`${textoCliente}, Área Metropolitana de Medellín, Antioquia, Colombia`);
    queries.push(`${textoCliente}, Antioquia, Colombia`);
  }

  for (const query of queries) {
    try {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=3&countrycodes=co&addressdetails=1`;
      console.log(`🗺️ Nominatim: "${query}"`);

      const data = await _httpGet(url);

      if (!Array.isArray(data) || !data.length) continue;

      // Evaluar los resultados — preferir el que esté en zona de cobertura
      for (const r of data) {
        const lat = parseFloat(r.lat);
        const lng = parseFloat(r.lon);
        if (!_enZonaCobertura(lat, lng)) continue;

        const addr      = r.address || {};
        const municipio = addr.city || addr.town || addr.municipality || addr.county || 'Copacabana';
        const barrio    = addr.suburb || addr.neighbourhood || addr.quarter || addr.road || textoCliente;
        const dirFmt    = (r.display_name || textoCliente).split(',').slice(0, 4).join(',').trim();

        // Confianza según tipo de resultado OSM
        const tipo      = r.type || r.class || '';
        const confianza = (tipo === 'house' || tipo === 'building') ? 'alta'
          : (tipo === 'residential' || tipo === 'road' || tipo === 'street') ? 'media'
          : 'media';

        console.log(`✅ Nominatim [${tipo}]: "${barrio}", ${municipio} → ${lat.toFixed(5)}, ${lng.toFixed(5)}`);
        const resultado = await _construirResultado(lat, lng, barrio, municipio, dirFmt, confianza, 'nominatim');
        _nomCache.set(cacheKey, resultado);
        return resultado;
      }
    } catch(e) {
      console.error(`Nominatim error para "${query}":`, e.message);
    }
  }

  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// PHOTON (Komoot / OpenStreetMap) — fallback gratuito adicional
//
// Ventajas sobre Nominatim en algunos casos:
//   - Motor de búsqueda diferente, puede encontrar lo que Nominatim no
//   - También basado en OSM pero con índice propio
//   - Sin rate limit estricto para usos razonables
//   - Excelente para nombres de barrios y lugares populares
// ══════════════════════════════════════════════════════════════════════════════
const _photonCache = new Map();

async function geocodificarPhoton(textoCliente) {
  const cacheKey = (textoCliente || '').toLowerCase().trim();
  if (_photonCache.has(cacheKey)) {
    console.log(`📦 Cache Photon: "${textoCliente}"`);
    return _photonCache.get(cacheKey);
  }

  // Detectar municipio para añadir contexto a la búsqueda
  const municipioDetect = detectarMunicipioEnTexto(textoCliente);

  // Photon soporta parámetro `location_bias` para priorizar resultados cercanos a un punto
  // Usamos la sede como punto de referencia → resultados de Antioquia primero
  const queries = [];

  if (municipioDetect) {
    queries.push(`${textoCliente}, ${municipioDetect}, Antioquia`);
  } else {
    queries.push(`${textoCliente}, Copacabana, Antioquia`);
    queries.push(`${textoCliente}, Antioquia`);
  }

  for (const query of queries) {
    try {
      // lat/lon bias hacia la sede + limit=5 para tener más opciones de filtrar
      const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=5&lang=es&lat=${SEDE_LAT}&lon=${SEDE_LNG}`;
      console.log(`🔭 Photon: "${query}"`);

      const data = await _httpGet(url);

      const features = data?.features || [];
      if (!features.length) continue;

      // Filtrar por zona de cobertura y encontrar el mejor resultado
      for (const feature of features) {
        const coords = feature.geometry?.coordinates;
        if (!coords || coords.length < 2) continue;

        const lng = parseFloat(coords[0]);
        const lat = parseFloat(coords[1]);
        if (!_enZonaCobertura(lat, lng)) continue;

        const props     = feature.properties || {};
        const municipio = props.city || props.county || props.state || 'Antioquia';
        const barrio    = props.name || props.district || props.suburb || textoCliente;

        // Photon da tipo: house, street, district, city, etc.
        const tipo      = props.type || props.osm_value || '';
        const confianza = (tipo === 'house' || tipo === 'building') ? 'alta'
          : (tipo === 'street' || tipo === 'residential') ? 'media'
          : 'media';

        // Construir dirección formateada
        const partes = [props.name, props.street, props.city, props.county].filter(Boolean);
        const dirFmt = partes.slice(0, 3).join(', ');

        console.log(`✅ Photon [${tipo}]: "${barrio}", ${municipio} → ${lat.toFixed(5)}, ${lng.toFixed(5)}`);
        const resultado = await _construirResultado(lat, lng, barrio, municipio, dirFmt, confianza, 'photon');
        _photonCache.set(cacheKey, resultado);
        return resultado;
      }
    } catch(e) {
      console.error(`Photon error para "${query}":`, e.message);
    }
  }

  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// NOMINATIM INVERSO — coords GPS → barrio/municipio/tarifa
// ══════════════════════════════════════════════════════════════════════════════
async function geocodificarInversaNominatim(lat, lng) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`;
    console.log(`🔄 Nominatim reverse: ${lat.toFixed(6)}, ${lng.toFixed(6)}`);

    const data = await _httpGet(url);

    if (!data || data.error) return null;

    const addr      = data.address || {};
    const barrio    = addr.suburb || addr.neighbourhood || addr.quarter || addr.road || addr.village || '';
    const municipio = addr.city || addr.town || addr.municipality || addr.county || 'Copacabana';
    const esCopa    = esZonaCopacabana(municipio, barrio);
    const calc      = await calcularTarifaKm(lat, lng);

    console.log(`✅ Reverse: "${barrio}", ${municipio} → tarifa=$${calc.precio}`);

    return {
      barrio, municipio,
      zona:         zonaLegible(municipio, barrio),
      esCopacabana: esCopa,
      tarifa:       calc.precio,
      formula:      calc.formula,
      displayName:  (data.display_name || '').split(',').slice(0, 3).join(',').trim()
    };
  } catch(e) {
    console.error('geocodificarInversaNominatim:', e.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// GOOGLE MAPS GEOCODING (opcional — si GOOGLE_MAPS_KEY existe)
// ══════════════════════════════════════════════════════════════════════════════
const _geoCache = new Map();

async function geocodificarGoogle(textoCliente) {
  const key = process.env.GOOGLE_MAPS_KEY;
  if (!key) return null;

  const cacheKey = textoCliente.toLowerCase().trim();
  if (_geoCache.has(cacheKey)) {
    console.log(`📦 Cache Google: "${textoCliente}"`);
    return _geoCache.get(cacheKey);
  }

  const municipioEnTexto = detectarMunicipioEnTexto(textoCliente);
  const barrioDetect     = !municipioEnTexto ? detectarBarrioEnTexto(textoCliente) : null;

  const queries = [`${textoCliente}, Colombia`];
  if (municipioEnTexto) queries.push(`${textoCliente}, ${municipioEnTexto}, Antioquia, Colombia`);
  if (barrioDetect?.municipio) queries.push(`${textoCliente}, ${barrioDetect.municipio}, Antioquia, Colombia`);

  for (const query of queries) {
    try {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&region=co&key=${key}`;
      console.log(`🌐 Google Maps: "${query}"`);

      const data = await _httpGet(url);
      if (data.status !== 'OK' || !data.results?.length) { console.log(`   Status: ${data.status}`); continue; }

      for (const result of data.results) {
        const lat = result.geometry.location.lat;
        const lng = result.geometry.location.lng;
        if (!_enZonaCobertura(lat, lng)) continue;

        const comps     = result.address_components || [];
        const getComp   = types => comps.find(c => types.some(t => c.types.includes(t)))?.long_name || '';
        const barrio    = getComp(['neighborhood', 'sublocality_level_1', 'sublocality']) || getComp(['locality']);
        const municipio = getComp(['locality', 'administrative_area_level_2']);
        const tipo      = result.geometry.location_type;
        const confianza = tipo === 'ROOFTOP' || tipo === 'RANGE_INTERPOLATED' ? 'alta' : 'media';

        console.log(`✅ Google Maps [${tipo}]: "${barrio}", ${municipio}`);
        const resultado = await _construirResultado(lat, lng, barrio || municipio, municipio || 'Colombia', result.formatted_address, confianza, 'google_maps');
        _geoCache.set(cacheKey, resultado);
        return resultado;
      }
    } catch(e) { console.error(`Google Maps error para "${query}":`, e.message); }
  }

  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// calcularDistancia — función principal exportada
//
// ORDEN DE PRIORIDAD:
//   1. Cache sheet (cols H/I)     — más rápido, 0 llamadas
//   2. Google Maps                — más preciso (si hay key)
//   3. Nominatim (OSM)            — gratuito, muy bueno
//   4. Photon (Komoot/OSM)        — gratuito, segundo motor OSM  ← NUEVO
//   5. Barrio conocido hardcoded  — ~40 barrios comunes
//   6. Municipio hardcoded        — coordenada del centro
// ══════════════════════════════════════════════════════════════════════════════
async function calcularDistancia(textoCliente, dirRefSheet, coordsAncla) {
  const txt = (textoCliente || '').trim();
  if (txt.length < 3) return _fallback(txt, 'Texto muy corto');

  console.log(`\n🔍 calcularDistancia: "${txt}"`);
  if (coordsAncla) console.log(`   💾 Cache H/I: ${coordsAncla.lat}, ${coordsAncla.lng}`);

  // ── 1. Cache del sheet (col H/I) ─────────────────────────────────────────
  if (coordsAncla?.lat && coordsAncla?.lng) {
    const { lat, lng } = coordsAncla;
    if (_enZonaCobertura(lat, lng)) {
      const municipioRef = detectarMunicipioEnTexto(dirRefSheet || txt);
      const barrioDetect = detectarBarrioEnTexto(txt);
      const municipio    = municipioRef || barrioDetect?.municipio || '';
      const barrio       = barrioDetect?.barrio || txt;
      const calc         = await calcularTarifaKm(lat, lng);
      const zona         = zonaLegible(municipio, barrio);
      const esCopa       = esZonaCopacabana(municipio, barrio);

      console.log(`💾 Usando cache: ${lat}, ${lng} → ${calc.formula}`);
      return {
        lat, lng, barrio, municipio, zona,
        tarifa:              esCopa ? null : calc.precio,
        tarifaCalculada:     calc.precio,
        distRutaKm:          calc.distRutaKm,
        distLinealKm:        calc.distLinealKm,
        formula:             calc.formula,
        esCobertura:         true,
        esCoherente:         true,
        confianzaGeo:        'alta',
        fuenteGeo:           'cache_sheet',
        direccionFormateada: txt,
        observaciones:       'Dirección verificada ✅'
      };
    }
  }

  // ── 2. Google Maps (si hay API key) ──────────────────────────────────────
  const geoGoogle = await geocodificarGoogle(txt);
  if (geoGoogle) return geoGoogle;

  // ── 3. Nominatim (OpenStreetMap) ─────────────────────────────────────────
  const geoNom = await geocodificarNominatim(txt);
  if (geoNom) return geoNom;

  // ── 4. Photon (Komoot/OSM) — segundo motor gratuito ──────────────────────
  console.log(`🔭 Nominatim no encontró "${txt}" — intentando Photon...`);
  const geoPhoton = await geocodificarPhoton(txt);
  if (geoPhoton) return geoPhoton;

  // ── 5. Barrio conocido hardcoded ─────────────────────────────────────────
  const barrioDetect = detectarBarrioEnTexto(txt);
  if (barrioDetect) {
    const { lat, lng, municipio, barrio } = barrioDetect;
    const esCopa = esZonaCopacabana(municipio, barrio);
    const calc   = await calcularTarifaKm(lat, lng);
    const zona   = zonaLegible(municipio, barrio);
    console.log(`📍 Barrio conocido [fallback]: "${barrio}", ${municipio} → ${calc.formula}`);
    return {
      lat, lng, barrio, municipio, zona,
      tarifa:              esCopa ? null : calc.precio,
      tarifaCalculada:     calc.precio,
      distRutaKm:          calc.distRutaKm,
      distLinealKm:        calc.distLinealKm,
      formula:             calc.formula,
      esCobertura:         true,
      esCoherente:         true,
      confianzaGeo:        'media',
      fuenteGeo:           'barrio_conocido',
      direccionFormateada: txt,
      observaciones:       'Coordenadas aproximadas al barrio ⚠️'
    };
  }

  // ── 6. Municipio detectado en el texto ───────────────────────────────────
  const municipioDetect = detectarMunicipioEnTexto(txt);
  if (municipioDetect) {
    const keyMun = municipioDetect.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const coords = MUNICIPIOS_COORDS[keyMun];
    if (coords) {
      const esCopa = esZonaCopacabana(municipioDetect, '');
      const calc   = await calcularTarifaKm(coords.lat, coords.lng);
      const zona   = zonaLegible(municipioDetect, '');
      console.log(`🗺️  Municipio [fallback]: "${municipioDetect}" → ${calc.formula}`);
      return {
        lat: coords.lat, lng: coords.lng,
        barrio: txt, municipio: municipioDetect, zona,
        tarifa:              esCopa ? null : calc.precio,
        tarifaCalculada:     calc.precio,
        distRutaKm:          calc.distRutaKm,
        distLinealKm:        calc.distLinealKm,
        formula:             calc.formula,
        esCobertura:         true,
        esCoherente:         true,
        confianzaGeo:        'baja',
        fuenteGeo:           'municipio_detectado',
        direccionFormateada: txt,
        observaciones:       'Coordenada aproximada al municipio ⚠️'
      };
    }
  }

  return _fallback(txt, 'No encontrado — el domiciliario confirmará');
}

function _fallback(texto, motivo) {
  return {
    lat: null, lng: null,
    barrio: texto || 'Desconocido', municipio: null,
    zona: 'Por confirmar', tarifa: null, tarifaCalculada: null,
    distRutaKm: null, distLinealKm: null, formula: null,
    esCobertura: false, esCoherente: false,
    confianzaGeo: 'baja', fuenteGeo: 'fallback',
    direccionFormateada: texto || '',
    observaciones: motivo
  };
}

function normalizarDireccion(dir) {
  if (!dir) return '';
  return dir
    .replace(/\bCr\.?\s*/gi,  'Carrera ')
    .replace(/\bCra\.?\s*/gi, 'Carrera ')
    .replace(/\bCl\.?\s*/gi,  'Calle ')
    .replace(/\bTv\.?\s*/gi,  'Transversal ')
    .replace(/\bAv\.?\s*/gi,  'Avenida ')
    .replace(/\s*#\s*/g,      ' # ')
    .replace(/\s{2,}/g,       ' ').trim();
}

function detectarZonaFija() { return null; }

module.exports = {
  calcularDistancia,
  calcularPrecioPorKm,
  calcularPreciosPaquete,
  calcularTarifaKm,
  calcularRutaORS,
  normalizarDireccion,
  zonaLegible,
  detectarMunicipioEnTexto,
  detectarBarrioEnTexto,
  detectarZonaFija,
  esZonaCopacabana,
  haversineKm,
  geocodificarNominatim,
  geocodificarPhoton,
  geocodificarInversaNominatim,
  SEDE_LAT,
  SEDE_LNG,
  SEDE_DIR,
  ANCLA_LAT,
  ANCLA_LNG,
};