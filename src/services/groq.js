// ─────────────────────────────────────────────────────────────────────────────
// groq.js  — WIL Domicilios
//
// REGLA DE TARIFAS (definitiva):
//
//   COPACABANA (y Niquía parte baja de Bello):
//     → Tarifa fija del SHEET por barrio
//
//   TODO LO DEMÁS (Medellín, Bello, Envigado, Oriente, etc.):
//     → $1.800 × km recorrido (haversine × 1.35) desde la sede
//     → Aplica tanto para DOMICILIOS como para PAQUETES
//     → El tamaño/peso del paquete NO cambia el precio
//
//   La dirección completa + barrio son OBLIGATORIOS fuera de Copacabana.
// ─────────────────────────────────────────────────────────────────────────────

const Groq = require('groq-sdk');
const { calcularDistancia, calcularPrecioPorKm, zonaLegible, esZonaCopacabana } = require('./distancia');
const { buscarBarrioCopacabana } = require('./sheets');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const SEDE_LAT = parseFloat(process.env.SEDE_LAT || '6.3538');
const SEDE_LNG = parseFloat(process.env.SEDE_LNG || '-75.4932');

// ─────────────────────────────────────────────────────────────────────────────
// extraerProductosIA
// ─────────────────────────────────────────────────────────────────────────────
async function extraerProductosIA(texto) {
  try {
    const res = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant', temperature: 0.1, max_tokens: 500,
      messages: [
        {
          role: 'system',
          content: `Eres asistente de domicilios en Colombia.
Extrae productos y cantidades. REGLAS:
- Solo JSON válido, sin texto extra
- Sin cantidad explícita → 1
- Normaliza: "dos"→2 "tres"→3 "un/una"→1
- Ignora: tráigame, mándeme, necesito, quiero
- Vago ("lo de siempre") → lista vacía
FORMATO: {"productos":[{"cantidad":2,"descripcion":"aceite 3L"}]}`
        },
        { role: 'user', content: texto }
      ]
    });
    const raw  = (res.choices[0]?.message?.content || '{"productos":[]}').replace(/```json|```/g,'').trim();
    const data = JSON.parse(raw);
    if (!Array.isArray(data.productos)) return [];
    return data.productos
      .filter(p => p.descripcion?.trim().length > 1)
      .map(p => ({
        cantidad:       parseInt(p.cantidad) || 1,
        descripcion:    p.descripcion.trim(),
        precioUnitario: 0,
        subtotal:       0
      }));
  } catch(e) {
    console.error('extraerProductosIA:', e.message);
    return [{ cantidad: 1, descripcion: texto, precioUnitario: 0, subtotal: 0 }];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// detectarIntencion
// ─────────────────────────────────────────────────────────────────────────────
async function detectarIntencion(texto) {
  try {
    const res = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant', temperature: 0, max_tokens: 10,
      messages: [
        { role: 'system', content: 'Detecta si el mensaje es intención de hacer un pedido a domicilio. Responde SOLO: SI o NO' },
        { role: 'user',   content: texto }
      ]
    });
    const r = (res.choices[0]?.message?.content || 'NO').trim().toUpperCase();
    return r.includes('SI') || r.includes('SÍ');
  } catch(e) { return false; }
}

// ─────────────────────────────────────────────────────────────────────────────
// interpretarDireccion — para DOMICILIOS NORMALES y consulta de tarifa
//
// IMPORTANTE: NO asume que todo es Copacabana.
// Copacabana/Niquía → tarifa del sheet
// Todo lo demás     → $1.800 × km desde la sede
// ─────────────────────────────────────────────────────────────────────────────
async function interpretarDireccion(texto, todosBarrios, dirRefSheet) {
  try {
    // Solo barrios reales de Copacabana para el prompt
    const barriosCopa = (todosBarrios || [])
      .filter(b => {
        const z = (b.zona || '').toLowerCase();
        const n = (b.barrio || '').toLowerCase();
        return z.includes('copacabana') || z.includes('local') ||
               (!z && !n.includes('bello') && !n.includes('medellín'));
      })
      .slice(0, 30)
      .map(b => `${b.barrio}`)
      .join(', ');

    // Contexto de zona extraído de la col F del sheet
    // Ejemplo: "Cra 68 #97-95, Castilla, Medellín" → zona = Castilla, Medellín
    const contextoZona = dirRefSheet
      ? `\nCONTEXTO DE ZONA (punto de referencia del barrio en el sheet): "${dirRefSheet}"
→ Úsalo para confirmar/determinar el municipio y zona correctos.`
      : '';

    const prompt = `Eres un asistente de domicilios en Copacabana y Área Metropolitana de Medellín, Colombia.
La sede está en Cra. 50 #50-15, Copacabana, Antioquia (lat: ${SEDE_LAT}, lng: ${SEDE_LNG}).

Dirección del cliente: "${texto}"${contextoZona}

REGLAS:
- Determina el municipio REAL (Medellín, Bello, Envigado, Copacabana, etc.)
- El contexto de zona del sheet es una guía confiable del área — úsalo
- "Castilla", "Laureles", "El Poblado", "Aranjuez", "Robledo" → MEDELLÍN
- "Bello" sin mencionar Niquía → BELLO, no Copacabana
- Solo es Copacabana si lo dice explícitamente o son estos barrios: ${barriosCopa}
- Si el cliente puso solo el barrio sin número, lat/lng serán aproximados

Responde SOLO en JSON sin texto adicional:
{
  "barrio": "nombre del barrio",
  "municipio": "municipio exacto",
  "zona": "descripción de zona",
  "esCopacabana": true|false,
  "tarifa": 0,
  "confianza": "alta|media|baja",
  "lat": número o null,
  "lng": número o null
}`;

    const res   = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 300, temperature: 0.1
    });

    const txt   = res.choices[0]?.message?.content || '';
    const clean = txt.replace(/```json|```/g, '').trim();
    const data  = JSON.parse(clean);

    // Si Groq dice que NO es Copacabana y tenemos coords, calculamos por km
    if (!data.esCopacabana && data.lat && data.lng) {
      const { calcularPrecioPorKm } = require('./distancia');
      const dist  = calcularPrecioPorKm(SEDE_LAT, SEDE_LNG, data.lat, data.lng);
      data.tarifa = dist.precioCOP;
      data.distKm = dist.distanciaRutaKm;
    }

    return data;
  } catch(e) {
    console.error('interpretarDireccion error:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// interpretarDireccionPaquete — PAQUETERÍA
//
// El precio de paquete es SIEMPRE por km recorrido, independiente del tamaño.
// El tamaño/peso se registra como información para el domiciliario.
// ─────────────────────────────────────────────────────────────────────────────
async function interpretarDireccionPaquete(textoDir, latOrigen, lngOrigen, dirRefSheet) {
  try {
    console.log(`\n📦 interpretarDireccionPaquete: "${textoDir}"`);

    const orLat = latOrigen || SEDE_LAT;
    const orLng = lngOrigen || SEDE_LNG;

    // PASO 1: Geocodificar destino
    const geo = await calcularDistancia(textoDir, dirRefSheet);

    const lat         = geo.lat;
    const lng         = geo.lng;
    const barrio      = geo.barrio    || textoDir;
    const municipio   = geo.municipio || '';
    const confianza   = geo.confianzaGeo  || 'baja';
    const obs         = geo.observaciones || '';
    const tieneCoords = geo.esCoherente && lat && lng;

    console.log(`📍 Destino: "${barrio}", ${municipio} [${lat?.toFixed(6)}, ${lng?.toFixed(6)}] conf=${confianza}`);
    if (lat && lng) console.log(`   🗺️  https://www.google.com/maps?q=${lat},${lng}`);

    // PASO 2: Calcular precio por km (SIEMPRE por km para paquetes)
    let precioPaquete = null;
    let distanciaInfo = null;

    if (tieneCoords) {
      distanciaInfo = calcularPrecioPorKm(orLat, orLng, lat, lng);
      precioPaquete = distanciaInfo.precioCOP;
      console.log(`🧮 Paquete: ${distanciaInfo.formula}`);
    } else if (geo.tarifa) {
      // Fallback: usar tarifa ya calculada (puede venir del sheet si es local)
      precioPaquete = geo.tarifa;
    }

    // PASO 3: Groq estructura dirección + extrae punto de referencia
    const promptPaquete =
`Analiza esta dirección para paquetería en Antioquia, Colombia:
Texto usuario: "${textoDir}"
Google Maps / geocodificación devolvió: barrio="${barrio}", municipio="${municipio}", dirección="${geo.direccionFormateada || textoDir}"

Extrae y estructura. Deja vacío si no está en el texto.
IMPORTANTE: punto_referencia es cualquier referencia que mencione el usuario (ej: "frente al Éxito", "junto al parque", "cerca de la iglesia").

FORMATO JSON sin markdown:
{"direccion_completa":"","barrio":"","municipio":"","punto_referencia":"","observaciones":""}`;

    let direccionCompleta = geo.direccionFormateada || textoDir;
    let barrioFinal       = barrio;
    let municipioFinal    = municipio || 'Sin confirmar';
    let puntoReferencia   = '';
    let obsGroq           = obs;

    try {
      const rGroq = await groq.chat.completions.create({
        model: 'llama-3.1-8b-instant', temperature: 0.1, max_tokens: 200,
        messages: [
          { role: 'system', content: 'Experto en direcciones de Antioquia. Solo JSON válido sin markdown.' },
          { role: 'user',   content: promptPaquete }
        ]
      });
      const raw = rGroq.choices[0]?.message?.content?.trim() || '{}';
      const pg  = JSON.parse(raw.replace(/```json|```/g,'').trim());
      if (pg.direccion_completa) direccionCompleta = pg.direccion_completa;
      if (pg.barrio)             barrioFinal       = pg.barrio;
      if (pg.municipio)          municipioFinal    = pg.municipio;
      if (pg.punto_referencia)   puntoReferencia   = pg.punto_referencia;
      if (pg.observaciones)      obsGroq           = pg.observaciones;
      console.log(`🗺️  Groq: dir="${direccionCompleta}" barrio="${barrioFinal}" ref="${puntoReferencia}"`);
    } catch(e) {
      console.warn('Groq paquete falló:', e.message);
    }

    const zonaSheets = esZonaCopacabana(municipioFinal, barrioFinal);

    return {
      lat, lng, tieneCoords,
      confianzaGeo:      confianza,
      direccionCompleta,
      barrio:            barrioFinal,
      municipio:         municipioFinal,
      puntoReferencia,
      observaciones:     obsGroq,
      displayName:       geo.direccionFormateada,
      precioPaquete,
      distanciaKm:       distanciaInfo?.distanciaRutaKm   || null,
      distanciaLinealKm: distanciaInfo?.distanciaLinealKm || null,
      formulaPrecio:     distanciaInfo?.formula           || null,
      esZonaSheets:      zonaSheets,
      nota: `${municipioFinal}${barrioFinal ? ' — ' + barrioFinal : ''}`,
      razon: tieneCoords
        ? `Verificado: ${(geo.direccionFormateada||'').substring(0, 60)}`
        : 'Sin geocodificación exacta — verificar con el cliente'
    };

  } catch(e) {
    console.error('interpretarDireccionPaquete ERROR:', e.message);
    return null;
  }
}

module.exports = {
  extraerProductosIA,
  detectarIntencion,
  interpretarDireccion,
  interpretarDireccionPaquete
};