// services/direcciones.js
const axios = require('axios');
const https = require('https');

// Caché de direcciones validadas
const direccionesValidadas = new Map();

// Google Maps API (opcional, si tienes clave)
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;

/**
 * Valida una dirección contra Google Maps (más preciso)
 */
async function validarConGoogleMaps(direccion) {
  if (!GOOGLE_MAPS_KEY) return null;
  
  try {
    const url = 'https://maps.googleapis.com/maps/api/geocode/json';
    const response = await axios.get(url, {
      params: {
        address: direccion + ', Medellín, Antioquia, Colombia',
        key: GOOGLE_MAPS_KEY,
        region: 'co',
        components: 'country:CO'
      },
      timeout: 5000
    });

    if (response.data.status === 'OK' && response.data.results.length > 0) {
      const result = response.data.results[0];
      const location = result.geometry.location;
      
      // Extraer componentes de dirección
      let barrio = '', municipio = '';
      for (const comp of result.address_components) {
        if (comp.types.includes('sublocality') || comp.types.includes('neighborhood')) {
          barrio = comp.long_name;
        }
        if (comp.types.includes('locality')) {
          municipio = comp.long_name;
        }
      }
      
      return {
        lat: location.lat,
        lng: location.lng,
        direccion_completa: result.formatted_address,
        barrio,
        municipio,
        fuente: 'Google Maps',
        precision: 'alta'
      };
    }
  } catch (error) {
    console.log('Google Maps error:', error.message);
  }
  return null;
}

/**
 * Formato estricto de direcciones colombianas
 */
function parsearDireccionColombiana(texto) {
  const dir = texto.toLowerCase().trim();
  
  // Patrones de direcciones colombianas
  const patrones = [
    // Calle 101 #50C-20
    /(calle|cl|cal)\s*(\d+)\s*#\s*(\d+[a-z]?)\s*-\s*(\d+)/i,
    // Carrera 50C #101-20
    /(carrera|cr|cra)\s*(\d+[a-z]?)\s*#\s*(\d+)\s*-\s*(\d+)/i,
    // Calle 101 No. 50C-20
    /(calle|cl|cal)\s*(\d+)\s*(?:no|n\.?|numero)\s*(\d+[a-z]?)\s*-\s*(\d+)/i,
    // Calle 101 50C-20
    /(calle|cl|cal)\s*(\d+)\s+(\d+[a-z]?)\s*-\s*(\d+)/i
  ];

  for (const patron of patrones) {
    const match = dir.match(patron);
    if (match) {
      const tipo = match[1].toLowerCase();
      const esCalle = tipo.includes('calle') || tipo === 'cl' || tipo === 'cal';
      const esCarrera = tipo.includes('carrera') || tipo === 'cr' || tipo === 'cra';
      
      return {
        valido: true,
        tipo: esCalle ? 'calle' : 'carrera',
        principal: match[2],
        secundario: match[3],
        complemento: match[4],
        texto_completo: texto
      };
    }
  }
  
  return { valido: false };
}

/**
 * Construye query optimizada para LocationIQ
 */
function construirQueryLocationIQ(parseado, direccion) {
  if (parseado.valido) {
    if (parseado.tipo === 'calle') {
      return `Calle ${parseado.principal} #${parseado.secundario}-${parseado.complemento}, Medellín, Antioquia, Colombia`;
    } else {
      return `Carrera ${parseado.principal} #${parseado.secundario}-${parseado.complemento}, Medellín, Antioquia, Colombia`;
    }
  }
  return `${direccion}, Antioquia, Colombia`;
}

/**
 * Geocodificación con LocationIQ MEJORADA
 */
async function geocodificarLocationIQ(direccion) {
  if (!process.env.LOCATIONIQ_API_KEY) return null;
  
  try {
    const parseado = parsearDireccionColombiana(direccion);
    const query = construirQueryLocationIQ(parseado, direccion);
    
    console.log(`📍 LocationIQ query: "${query}"`);

    const url = 'https://us1.locationiq.com/v1/search.php';
    const response = await axios.get(url, {
      params: {
        key: process.env.LOCATIONIQ_API_KEY,
        q: query,
        format: 'json',
        limit: 5,
        'accept-language': 'es',
        addressdetails: 1,
        countrycodes: 'co',
        dedupe: 1
      },
      timeout: 8000,
      httpsAgent: new https.Agent({ keepAlive: true })
    });

    if (!response.data || response.data.length === 0) {
      return null;
    }

    // Filtrar y puntuar resultados
    const resultados = response.data
      .filter(r => {
        const display = r.display_name?.toLowerCase() || '';
        return display.includes('colombia') || 
               r.address?.country_code === 'co' ||
               r.address?.state?.toLowerCase().includes('antioquia');
      })
      .map(r => {
        let score = 0;
        const address = r.address || {};
        
        // Puntos base por estar en Colombia/Antioquia
        if (address.country_code === 'co') score += 100;
        if (address.state?.toLowerCase().includes('antioquia')) score += 50;
        
        // Para direcciones específicas
        if (parseado.valido) {
          // Coincidencia con el número principal
          if (address.road?.includes(parseado.principal)) score += 30;
          if (address.house_number === parseado.secundario || 
              address.house_number === parseado.complemento) score += 40;
          
          // Precisión de la dirección
          if (address.road && address.house_number) score += 50;
        }
        
        // Importancia
        if (r.importance) score += r.importance * 100;
        
        return { ...r, score };
      })
      .sort((a, b) => b.score - a.score);

    if (resultados.length === 0) return null;

    const mejor = resultados[0];
    console.log(`   ✅ Mejor resultado (score: ${mejor.score}): ${mejor.display_name}`);

    return {
      lat: parseFloat(mejor.lat),
      lng: parseFloat(mejor.lon),
      display_name: mejor.display_name,
      barrio: mejor.address?.suburb || mejor.address?.neighbourhood || mejor.address?.hamlet || mejor.address?.road || '',
      municipio: mejor.address?.city || mejor.address?.town || mejor.address?.municipality || '',
      fuente: 'LocationIQ',
      precision: mejor.score > 150 ? 'alta' : 'media',
      score: mejor.score
    };
    
  } catch (error) {
    console.log('LocationIQ error:', error.message);
    return null;
  }
}

/**
 * Función principal de geocodificación
 */
async function geocodificar(direccion) {
  // 1. Intentar con Google Maps (si hay clave)
  const google = await validarConGoogleMaps(direccion);
  if (google) {
    console.log(`✅ Google Maps: ${google.lat},${google.lng}`);
    return google;
  }
  
  // 2. Intentar con LocationIQ mejorado
  const locationIQ = await geocodificarLocationIQ(direccion);
  if (locationIQ) {
    console.log(`✅ LocationIQ: ${locationIQ.lat},${locationIQ.lng}`);
    return locationIQ;
  }
  
  return null;
}

module.exports = { geocodificar, parsearDireccionColombiana };