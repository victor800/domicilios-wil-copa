// ─────────────────────────────────────────────────────────────────────────────
// groq.js  — WIL Domicilios
//
// REGLA DE TARIFAS (definitiva):
//
//   COPACABANA (y Niquía parte baja de Bello):
//     → Tarifa fija del SHEET por barrio
//
//   TODO LO DEMÁS (Medellín, Bello, Envigado, Oriente, etc.):
//     → $1.800 × km recorrido desde la sede (ruta real via ORS/OSRM o haversine×1.35)
//     → Aplica tanto para DOMICILIOS como para PAQUETES
//     → El tamaño/peso del paquete NO cambia el precio
//
// FLUJO interpretarDireccion (MEJORADO):
//   1. calcularDistancia() → coords reales (Nominatim + Photon + fallbacks)
//   2. Groq llama-3.3-70b  → valida municipio, extrae barrio limpio, punto de referencia
//   3. Si Groq discrepa del municipio geocodificado → se usa el geocodificado (más confiable)
//   4. Si geocodificación falló → Groq intenta inferir coords por conocimiento propio
// ─────────────────────────────────────────────────────────────────────────────

const Groq = require('groq-sdk');
const {
  calcularDistancia, calcularPrecioPorKm, calcularTarifaKm,
  zonaLegible, esZonaCopacabana, detectarMunicipioEnTexto
} = require('./distancia');
const { buscarBarrioCopacabana } = require('./sheets');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const SEDE_LAT = parseFloat(process.env.SEDE_LAT || '6.35112');
const SEDE_LNG = parseFloat(process.env.SEDE_LNG || '-75.49190');

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
                    Extrae productos, cantidades y presentaciones exactas. REGLAS:
                  - Solo JSON válido, sin texto extra
                  - Sin cantidad explícita → 1
                  - Normaliza cantidades: "dos"→2 "tres"→3 "un/una"→1
                  - Ignora verbos: tráigame, mándeme, necesito, quiero
                  - Vago ("lo de siempre") → lista vacía
                  - IMPORTANTE: incluye la presentación/especificación completa en descripcion:
                  "aguardiente tapa roja garrafa" → descripcion: "Aguardiente Tapa Roja garrafa"
                  "azúcar libra" → descripcion: "Azúcar (1 libra)"
                  "arroz 500g" → descripcion: "Arroz 500g"
                  "pollo asado entero" → descripcion: "Pollo asado entero"
                  "carne de res libra" → descripcion: "Carne de res (1 libra)"
                  - Capitaliza el nombre del producto
                  - NO abrevies ni simplifiques la descripción
                  FORMATO: {"productos":[{"cantidad":2,"descripcion":"Pollo asado entero"}]}`
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
// interpretarDireccion — FLUJO MEJORADO
//
// ANTES: Groq inventaba coords → poco confiable
// AHORA:
//   Paso 1 → calcularDistancia() obtiene coords REALES (Nominatim + Photon + fallbacks)
//   Paso 2 → Groq enriquece: limpia nombre barrio, extrae punto de referencia,
//             valida municipio, detecta si es Copacabana
//   Paso 3 → Se usa el municipio geocodificado (más confiable que la inferencia de Groq)
//             y solo se usa lat/lng de Groq si la geocodificación no encontró nada
// ─────────────────────────────────────────────────────────────────────────────
async function interpretarDireccion(texto, todosBarrios, dirRefSheet) {
  console.log(`\n🤖 interpretarDireccion: "${texto}"`);

  // ── PASO 1: Geocodificación real (Nominatim → Photon → fallbacks) ─────────
  let geo = null;
  try {
    geo = await calcularDistancia(texto, dirRefSheet, null);
    if (geo?.lat && geo?.lng) {
      console.log(`📍 Geo real: ${geo.fuenteGeo} → ${geo.lat.toFixed(5)}, ${geo.lng.toFixed(5)} (${geo.municipio})`);
    }
  } catch(e) {
    console.error('interpretarDireccion - calcularDistancia:', e.message);
  }

  // ── PASO 2: Groq enriquece y valida ───────────────────────────────────────
  // Solo barrios de Copacabana para el prompt (para no confundir el modelo)
  const barriosCopa = (todosBarrios || [])
    .filter(b => {
      const z = (b.zona || '').toLowerCase();
      const n = (b.barrio || '').toLowerCase();
      return z.includes('copacabana') || z.includes('local') ||
             (!z && !n.includes('bello') && !n.includes('medellín'));
    })
    .slice(0, 30)
    .map(b => b.barrio)
    .join(', ');

  // Contexto de zona del sheet (columna F) — ancla geográfica confiable
  const contextoZona = dirRefSheet
    ? `\nCONTEXTO GEOGRÁFICO DEL SHEET: "${dirRefSheet}" — usa esto para confirmar el municipio.`
    : '';

  // Resultado de geocodificación para que Groq lo use como contexto
  const contextoGeo = geo?.lat
    ? `\nGEOCODIFICACIÓN (${geo.fuenteGeo}): lat=${geo.lat.toFixed(5)}, lng=${geo.lng.toFixed(5)}, municipio="${geo.municipio}", barrio="${geo.barrio}" — ESTO ES CONFIABLE, valídalo.`
    : `\nGEOCODIFICACIÓN: No se encontraron coordenadas — infiere lo mejor posible.`;

  const prompt = `Eres un experto en direcciones de Antioquia, Colombia.
Sede WIL: Cra. 50 #50-15, Copacabana (lat: ${SEDE_LAT}, lng: ${SEDE_LNG}).

Dirección del cliente: "${texto}"${contextoZona}${contextoGeo}

REGLAS ESTRICTAS:
1. Municipio: usa el de la geocodificación si está disponible — es más confiable que tu inferencia
2. "Castilla", "Laureles", "Poblado", "Robledo", "Aranjuez" → MEDELLÍN (no Copacabana)
3. "Bello" sin mencionar Niquía → BELLO, NO Copacabana
4. Solo es Copacabana si dice explícitamente o el barrio está en: ${barriosCopa}
5. Si no hay coordenadas de geocodificación, infiere lat/lng con tu conocimiento (aproximado)
6. punto_referencia: cualquier detalle extra que mencione el cliente (edificio, local, color, "frente a", "cerca de", etc.)

Responde SOLO en JSON, sin texto adicional, sin markdown:
{
  "barrio": "nombre limpio del barrio/sector",
  "municipio": "municipio exacto",
  "zona": "descripción corta de la zona",
  "esCopacabana": true/false,
  "confianza": "alta|media|baja",
  "punto_referencia": "detalle adicional si lo hay, o vacío",
  "lat": número o null,
  "lng": número o null
}`;

  let groqData = null;
  try {
    const res = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 300, temperature: 0.1
    });
    const raw = (res.choices[0]?.message?.content || '').replace(/```json|```/g, '').trim();
    groqData  = JSON.parse(raw);
    console.log(`🤖 Groq: municipio="${groqData.municipio}" esCopa=${groqData.esCopacabana} barrio="${groqData.barrio}"`);
  } catch(e) {
    console.error('interpretarDireccion - Groq:', e.message);
  }

  // ── PASO 3: Fusionar geocodificación real + enriquecimiento Groq ──────────
  //
  // Prioridad de coords: geo real > Groq (solo si geo falló)
  // Prioridad de municipio: geo real > Groq (geo es más confiable)
  // Prioridad de barrio: Groq (nombre más limpio) > geo
  // punto_referencia: solo viene de Groq

  const lat        = geo?.lat       || groqData?.lat       || null;
  const lng        = geo?.lng       || groqData?.lng       || null;
  const municipio  = geo?.municipio || groqData?.municipio || null;
  const barrio     = groqData?.barrio     || geo?.barrio     || texto;
  const zona       = groqData?.zona       || geo?.zona       || zonaLegible(municipio, barrio);
  const esCopa     = esZonaCopacabana(municipio || '', barrio);
  const confianza  = geo?.confianzaGeo || groqData?.confianza || 'baja';
  const ptRef      = groqData?.punto_referencia || '';
  const nota       = dirRefSheet || geo?.direccionFormateada || '';

  // Calcular tarifa con coords reales
  let tarifa = null;
  if (lat && lng) {
    try {
      const calc = await calcularTarifaKm(lat, lng);
      tarifa = calc.precio;
      console.log(`💰 Tarifa final: ${calc.formula}`);
    } catch(e) {
      // Si las coords vienen de Groq, usar calcularPrecioPorKm (síncrono)
      const dist = calcularPrecioPorKm(SEDE_LAT, SEDE_LNG, lat, lng);
      tarifa = dist.precioCOP;
    }
  }

  return {
    barrio,
    municipio,
    zona,
    esCopacabana: esCopa,
    tarifa:       esCopa ? null : tarifa,
    confianza,
    lat,
    lng,
    nota,
    puntoReferencia: ptRef,
    fuenteGeo: geo?.fuenteGeo || (groqData?.lat ? 'groq_inferido' : 'sin_coords'),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// interpretarDireccionPaquete — PAQUETERÍA
//
// También mejorado: geocodificación real primero, Groq solo estructura.
// ─────────────────────────────────────────────────────────────────────────────
async function interpretarDireccionPaquete(textoDir, latOrigen, lngOrigen, dirRefSheet) {
  try {
    console.log(`\n📦 interpretarDireccionPaquete: "${textoDir}"`);

    const orLat = latOrigen || SEDE_LAT;
    const orLng = lngOrigen || SEDE_LNG;

    // PASO 1: Geocodificar destino con el stack completo (Nominatim + Photon + fallbacks)
    const geo = await calcularDistancia(textoDir, dirRefSheet, null);

    const lat         = geo.lat;
    const lng         = geo.lng;
    const barrio      = geo.barrio    || textoDir;
    const municipio   = geo.municipio || '';
    const confianza   = geo.confianzaGeo  || 'baja';
    const obs         = geo.observaciones || '';
    const tieneCoords = geo.esCoherente && lat && lng;

    console.log(`📍 Destino: "${barrio}", ${municipio} [${lat?.toFixed(6)}, ${lng?.toFixed(6)}] conf=${confianza} fuente=${geo.fuenteGeo}`);

    // PASO 2: Calcular precio (siempre por km para paquetes)
    let precioPaquete = null;
    let distanciaInfo = null;

    if (tieneCoords) {
      distanciaInfo = calcularPrecioPorKm(orLat, orLng, lat, lng);
      precioPaquete = distanciaInfo.precioCOP;
      console.log(`🧮 Paquete: ${distanciaInfo.formula}`);
    } else if (geo.tarifa) {
      precioPaquete = geo.tarifa;
    }

    // PASO 3: Groq estructura la dirección y extrae punto de referencia
    const promptPaquete =
`Analiza esta dirección de paquetería en Antioquia, Colombia:
Texto del cliente: "${textoDir}"
Geocodificación obtuvo: barrio="${barrio}", municipio="${municipio}", dirección="${geo.direccionFormateada || textoDir}"

Extrae. Deja vacío si no está en el texto original.
punto_referencia: indicación extra que dé el cliente ("frente al Éxito", "edificio azul", "apto 302", etc.)

JSON sin markdown:
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
      // Barrio y municipio de Groq solo si la geocodificación no los encontró
      if (pg.barrio    && !barrio)    barrioFinal    = pg.barrio;
      if (pg.municipio && !municipio) municipioFinal = pg.municipio;
      if (pg.punto_referencia)        puntoReferencia = pg.punto_referencia;
      if (pg.observaciones)           obsGroq         = pg.observaciones;
      console.log(`🤖 Groq paquete: dir="${direccionCompleta}" ref="${puntoReferencia}"`);
    } catch(e) {
      console.warn('Groq paquete falló:', e.message);
    }

    const zonaSheets = esZonaCopacabana(municipioFinal, barrioFinal);

    return {
      lat, lng, tieneCoords,
      confianzaGeo:      confianza,
      fuenteGeo:         geo.fuenteGeo,
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
        ? `Verificado (${geo.fuenteGeo}): ${(geo.direccionFormateada||'').substring(0, 60)}`
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