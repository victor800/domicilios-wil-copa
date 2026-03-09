// ══════════════════════════════════════════════════════════════════════════════
// distancia.js — Domicilios WIL  (Google Maps Geocoding — solución definitiva)
//
// VARIABLE DE ENTORNO REQUERIDA:
//   GOOGLE_MAPS_KEY=AIza...   (Google Maps Geocoding API)
//
// SEDE: Cra. 50 #50-15, Copacabana, Antioquia
//
// FLUJO DE GEOCODIFICACIÓN (prioridad):
//   1. Cache sheet cols H/I  → 0 llamadas API
//   2. Google Maps Geocoding con municipality bias → coord exacta del predio
//   3. Fallback barrio conocido (hardcoded)
//   4. Fallback municipio conocido
//
// REGLA DE COBRO:
//   precio = MAX( $1.800 × kmRuta, $5.000 mínimo )
//   Copacabana local: tarifa ya en el sheet (misma fórmula)
// ══════════════════════════════════════════════════════════════════════════════

const https = require('https');

const SEDE_LAT  = parseFloat(process.env.SEDE_LAT  || '6.35112');
const SEDE_LNG  = parseFloat(process.env.SEDE_LNG  || '-75.49190');
const SEDE_DIR  = 'Cra. 50 #50-15, Copacabana, Antioquia, Colombia';

const PRECIO_KM   = 1800;
const FACTOR_RUTA = 1.35;
const TARIFA_MIN  = 5000;

// ── Coordenadas de referencia por municipio (fallback sin API) ────────────────
const MUNICIPIOS_COORDS = {
  'copacabana':           { lat: 6.35112, lng: -75.49190 },
  'bello':                { lat: 6.33670, lng: -75.55720 },
  'medellín':             { lat: 6.24420, lng: -75.58120 },
  'medellin':             { lat: 6.24420, lng: -75.58120 },
  'envigado':             { lat: 6.17520, lng: -75.59280 },
  'itagüí':               { lat: 6.18430, lng: -75.59900 },
  'itagui':               { lat: 6.18430, lng: -75.59900 },
  'sabaneta':             { lat: 6.15140, lng: -75.61750 },
  'la estrella':          { lat: 6.15720, lng: -75.64270 },
  'caldas':               { lat: 6.09300, lng: -75.63800 },
  'girardota':            { lat: 6.37830, lng: -75.44480 },
  'barbosa':              { lat: 6.43790, lng: -75.33160 },
  'rionegro':             { lat: 6.15530, lng: -75.37410 },
  'guarne':               { lat: 6.27780, lng: -75.45030 },
  'marinilla':            { lat: 6.17640, lng: -75.34360 },
  'el peñol':             { lat: 6.21570, lng: -75.23690 },
  'la ceja':              { lat: 6.02570, lng: -75.43320 },
  'retiro':               { lat: 6.06370, lng: -75.50700 },
  'el carmen de viboral': { lat: 6.08910, lng: -75.31840 },
  'san vicente ferrer':   { lat: 6.30870, lng: -75.33100 },
};

// ── Barrios conocidos con coords aproximadas (fallback sin API) ───────────────
const BARRIOS_CONOCIDOS = {
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
  'obrero':          { lat: 6.32400, lng: -75.56100, municipio: 'Bello' },
  'niquía':          { lat: 6.31850, lng: -75.52150, municipio: 'Bello' },
  'niquia':          { lat: 6.31850, lng: -75.52150, municipio: 'Bello' },
  'la madera':       { lat: 6.34500, lng: -75.55000, municipio: 'Bello' },
  'paris':           { lat: 6.34100, lng: -75.56200, municipio: 'Bello' },
  'zamora':          { lat: 6.33200, lng: -75.56800, municipio: 'Bello' },
  'girardota':       { lat: 6.37830, lng: -75.44480, municipio: 'Girardota' },
  'barbosa':         { lat: 6.43790, lng: -75.33160, municipio: 'Barbosa' },
  'envigado':        { lat: 6.17520, lng: -75.59280, municipio: 'Envigado' },
  'sabaneta':        { lat: 6.15140, lng: -75.61750, municipio: 'Sabaneta' },
  'itagüí':          { lat: 6.18430, lng: -75.59900, municipio: 'Itagüí' },
  'itagui':          { lat: 6.18430, lng: -75.59900, municipio: 'Itagüí' },
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

// ── Precio SEDE → destino ─────────────────────────────────────────────────────
function calcularTarifaKm(latDest, lngDest) {
  const lineal = haversineKm(SEDE_LAT, SEDE_LNG, latDest, lngDest);
  const ruta   = Math.round(lineal * FACTOR_RUTA * 10) / 10;
  const precio = Math.max(Math.round(ruta * PRECIO_KM / 500) * 500, TARIFA_MIN);
  return {
    precio,
    distRutaKm:   ruta,
    distLinealKm: Math.round(lineal * 10) / 10,
    formula:      `${Math.round(lineal*10)/10}km × ${FACTOR_RUTA} = ${ruta}km × $${PRECIO_KM} = $${precio}`
  };
}

// ── Precio entre dos puntos (paquetes) ────────────────────────────────────────
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

// ══════════════════════════════════════════════════════════════════════════════
// GOOGLE MAPS GEOCODING API
// ══════════════════════════════════════════════════════════════════════════════
// Una sola función: recibe la dirección del cliente, devuelve lat/lng real.
//
// Estrategia de queries (orden de precisión):
//   Q1: texto completo + ", Antioquia, Colombia"
//   Q2: Si el cliente no mencionó municipio → intentar con municipio detectado en barrio
//   Q3: Solo el municipio/barrio detectado (fallback suave)
//
// El componente `bounds` restringe a Antioquia pero NO fuerza el resultado,
// así Google puede geocodificar correctamente Bello, Medellín, Barbosa, etc.
// ──────────────────────────────────────────────────────────────────────────────

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 8000 }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try   { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON inválido')); }
      });
    });
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout Google Maps')); });
  });
}

// Cache en memoria para no re-geocodificar la misma dirección en la misma sesión
const _geoCache = new Map();

async function geocodificarGoogle(textoCliente) {
  const key = process.env.GOOGLE_MAPS_KEY;
  if (!key) {
    console.warn('⚠️  GOOGLE_MAPS_KEY no configurada — usando fallback');
    return null;
  }

  // Cache en memoria (misma dirección dentro de la misma ejecución del proceso)
  const cacheKey = textoCliente.toLowerCase().trim();
  if (_geoCache.has(cacheKey)) {
    console.log(`📦 Cache Google: "${textoCliente}"`);
    return _geoCache.get(cacheKey);
  }

  // Construir queries en orden de precisión
  const queries = [];

  // Q1: Texto completo del cliente + Colombia
  // Esto cubre "Cra 53 #32-86 barrio obrero bello" → Google Maps lo resuelve perfecto
  queries.push(`${textoCliente}, Colombia`);

  // Q2: Si no menciona municipio pero menciona barrio conocido → agregar municipio explícito
  const municipioEnTexto = detectarMunicipioEnTexto(textoCliente);
  if (!municipioEnTexto) {
    const barrioDetect = detectarBarrioEnTexto(textoCliente);
    if (barrioDetect?.municipio) {
      queries.push(`${textoCliente}, ${barrioDetect.municipio}, Antioquia, Colombia`);
    }
  }

  // Q3: Solo municipio como fallback (si el usuario puso solo nombre de barrio sin dirección)
  if (municipioEnTexto) {
    queries.push(`${textoCliente}, ${municipioEnTexto}, Antioquia, Colombia`);
  }

  // Bounds de Antioquia — le da prioridad a resultados en esta región
  // pero NO bloquea resultados válidos fuera del bounds
  const bounds = '5.5,−77.1|8.9,−73.8'; // SW|NE de Antioquia aproximado

  for (const query of queries) {
    try {
      const url = `https://maps.googleapis.com/maps/api/geocode/json` +
        `?address=${encodeURIComponent(query)}` +
        `&region=co` +
        `&key=${key}`;

      console.log(`🌐 Google Maps: "${query}"`);
      const data = await httpsGet(url);

      if (data.status !== 'OK' || !data.results?.length) {
        console.log(`   Status: ${data.status}`);
        continue;
      }

      for (const result of data.results) {
        const lat = result.geometry.location.lat;
        const lng = result.geometry.location.lng;

        // Verificar que el resultado esté en zona de cobertura de Colombia
        if (!_enZonaCobertura(lat, lng)) {
          console.log(`   ⚠️ Fuera de cobertura: ${lat}, ${lng}`);
          continue;
        }

        // Extraer municipio y barrio de los address_components
        const comps       = result.address_components || [];
        const getComp     = types => comps.find(c => types.some(t => c.types.includes(t)))?.long_name || '';

        const barrio      = getComp(['neighborhood', 'sublocality_level_1', 'sublocality']) ||
                            getComp(['locality']);
        const municipio   = getComp(['locality', 'administrative_area_level_2']);
        const dpto        = getComp(['administrative_area_level_1']);
        const direccionFmt = result.formatted_address;

        // Confianza según el tipo de resultado
        const tipo        = result.geometry.location_type; // ROOFTOP, RANGE_INTERPOLATED, GEOMETRIC_CENTER, APPROXIMATE
        const confianza   = tipo === 'ROOFTOP' ? 'alta'
                          : tipo === 'RANGE_INTERPOLATED' ? 'alta'
                          : tipo === 'GEOMETRIC_CENTER' ? 'media'
                          : 'baja';

        const esCopa      = esZonaCopacabana(municipio, barrio);
        const calc        = calcularTarifaKm(lat, lng);
        const zona        = zonaLegible(municipio, barrio);

        const resultado = {
          lat, lng,
          barrio:              barrio || municipio,
          municipio:           municipio || 'Colombia',
          zona,
          direccionFormateada: direccionFmt,
          tarifa:              esCopa ? null : calc.precio,
          tarifaCalculada:     calc.precio,
          distRutaKm:          calc.distRutaKm,
          distLinealKm:        calc.distLinealKm,
          formula:             calc.formula,
          esCobertura:         true,
          esCoherente:         true,
          confianzaGeo:        confianza,
          fuenteGeo:           'google_maps',
          observaciones:       confianza === 'alta'
            ? 'Dirección verificada ✅'
            : 'Dirección aproximada — confirmar con el cliente ⚠️'
        };

        console.log(`✅ Google Maps [${tipo}]: "${barrio}", ${municipio}`);
        console.log(`   📍 ${lat.toFixed(5)}, ${lng.toFixed(5)} | ${calc.formula}`);
        console.log(`   🗺️  https://www.google.com/maps?q=${lat},${lng}`);

        _geoCache.set(cacheKey, resultado);
        return resultado;
      }
    } catch(e) {
      console.error(`Google Maps error para "${query}":`, e.message);
    }
  }

  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// calcularDistancia — función principal exportada
// textoCliente: dirección que escribió el usuario
// dirRefSheet:  col F del sheet (ya no se usa como ancla, solo para extraer municipio)
// coordsAncla:  { lat, lng } del cache del sheet (col H/I) — si existen, usar directo
// ══════════════════════════════════════════════════════════════════════════════
async function calcularDistancia(textoCliente, dirRefSheet, coordsAncla) {
  const txt = (textoCliente || '').trim();
  if (txt.length < 3) return _fallback(txt, 'Texto muy corto');

  console.log(`\n🔍 calcularDistancia: "${txt}"`);
  if (coordsAncla) console.log(`   💾 Cache H/I: ${coordsAncla.lat}, ${coordsAncla.lng}`);

  // ── 1. Cache del sheet (col H/I) → 0 llamadas API ─────────────────────────
  if (coordsAncla?.lat && coordsAncla?.lng) {
    const { lat, lng } = coordsAncla;
    if (_enZonaCobertura(lat, lng)) {
      const esCopa = esZonaCopacabana('', '');
      const calc   = calcularTarifaKm(lat, lng);

      // Intentar obtener barrio/municipio del texto o del ref del sheet
      const municipioRef = detectarMunicipioEnTexto(dirRefSheet || txt);
      const barrioDetect = detectarBarrioEnTexto(txt);
      const municipio    = municipioRef || barrioDetect?.municipio || '';
      const barrio       = barrioDetect?.barrio || txt;
      const zona         = zonaLegible(municipio, barrio);
      const esCopa2      = esZonaCopacabana(municipio, barrio);

      console.log(`💾 Usando cache: ${lat}, ${lng} → ${calc.formula}`);
      return {
        lat, lng, barrio, municipio, zona,
        tarifa:           esCopa2 ? null : calc.precio,
        tarifaCalculada:  calc.precio,
        distRutaKm:       calc.distRutaKm,
        distLinealKm:     calc.distLinealKm,
        formula:          calc.formula,
        esCobertura:      true,
        esCoherente:      true,
        confianzaGeo:     'alta',
        fuenteGeo:        'cache_sheet',
        direccionFormateada: txt,
        observaciones:    'Dirección verificada ✅'
      };
    }
  }

  // ── 2. Google Maps Geocoding ───────────────────────────────────────────────
  const geo = await geocodificarGoogle(txt);
  if (geo) return geo;

  // ── 3. Fallback: barrio conocido hardcodeado ───────────────────────────────
  const barrioDetect = detectarBarrioEnTexto(txt);
  if (barrioDetect) {
    const { lat, lng, municipio, barrio } = barrioDetect;
    const esCopa = esZonaCopacabana(municipio, barrio);
    const calc   = calcularTarifaKm(lat, lng);
    const zona   = zonaLegible(municipio, barrio);
    console.log(`📍 Barrio conocido [fallback]: "${barrio}", ${municipio} → ${calc.formula}`);
    return {
      lat, lng, barrio, municipio, zona,
      tarifa:           esCopa ? null : calc.precio,
      tarifaCalculada:  calc.precio,
      distRutaKm:       calc.distRutaKm,
      distLinealKm:     calc.distLinealKm,
      formula:          calc.formula,
      esCobertura:      true,
      esCoherente:      true,
      confianzaGeo:     'media',
      fuenteGeo:        'barrio_conocido',
      direccionFormateada: txt,
      observaciones:    'Coordenadas aproximadas al barrio ⚠️'
    };
  }

  // ── 4. Fallback: municipio detectado en el texto ──────────────────────────
  const municipioDetect = detectarMunicipioEnTexto(txt);
  if (municipioDetect) {
    const key    = municipioDetect.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const coords = MUNICIPIOS_COORDS[key];
    if (coords) {
      const esCopa = esZonaCopacabana(municipioDetect, '');
      const calc   = calcularTarifaKm(coords.lat, coords.lng);
      const zona   = zonaLegible(municipioDetect, '');
      console.log(`🗺️  Municipio [fallback]: "${municipioDetect}" → ${calc.formula}`);
      return {
        lat: coords.lat, lng: coords.lng,
        barrio: txt, municipio: municipioDetect, zona,
        tarifa:           esCopa ? null : calc.precio,
        tarifaCalculada:  calc.precio,
        distRutaKm:       calc.distRutaKm,
        distLinealKm:     calc.distLinealKm,
        formula:          calc.formula,
        esCobertura:      true,
        esCoherente:      true,
        confianzaGeo:     'baja',
        fuenteGeo:        'municipio_detectado',
        direccionFormateada: txt,
        observaciones:    'Coordenada aproximada al municipio ⚠️'
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
    esCobertura:         false,
    esCoherente:         false,
    confianzaGeo:        'baja',
    fuenteGeo:           'fallback',
    direccionFormateada: texto || '',
    observaciones:       motivo
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
  normalizarDireccion,
  zonaLegible,
  detectarMunicipioEnTexto,
  detectarBarrioEnTexto,
  detectarZonaFija,
  esZonaCopacabana,
  haversineKm,
  SEDE_LAT,
  SEDE_LNG,
  SEDE_DIR
};