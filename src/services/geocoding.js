const axios = require('axios');

const LOCATIONIQ_KEY = process.env.LOCATIONIQ_API_KEY;
const SEDE_LAT = parseFloat(process.env.SEDE_LAT || '6.3538');
const SEDE_LNG = parseFloat(process.env.SEDE_LNG || '-75.4932');

/**
 * Geocodifica una dirección usando LocationIQ
 * @param {string} direccion - Dirección a geocodificar
 * @returns {Promise<{lat: number, lng: number, display_name: string, address: object}>}
 */
async function geocodificar(direccion) {
  try {
    const url = 'https://us1.locationiq.com/v1/search.php';
    const response = await axios.get(url, {
      params: {
        key: LOCATIONIQ_KEY,
        q: direccion + ', Copacabana, Antioquia, Colombia',
        format: 'json',
        limit: 1,
        'accept-language': 'es'
      }
    });

    if (response.data && response.data.length > 0) {
      const result = response.data[0];
      return {
        lat: parseFloat(result.lat),
        lng: parseFloat(result.lon),
        display_name: result.display_name,
        address: result.address
      };
    }
    return null;
  } catch (error) {
    console.error('❌ Error en geocodificar:', error.message);
    return null;
  }
}

/**
 * Geocodificación inversa (coordenadas → dirección)
 */
async function geocodificarInversa(lat, lng) {
  try {
    const url = 'https://us1.locationiq.com/v1/reverse.php';
    const response = await axios.get(url, {
      params: {
        key: LOCATIONIQ_KEY,
        lat: lat,
        lon: lng,
        format: 'json',
        'accept-language': 'es'
      }
    });

    if (response.data) {
      return {
        display_name: response.data.display_name,
        address: response.data.address
      };
    }
    return null;
  } catch (error) {
    console.error('❌ Error en geocodificarInversa:', error.message);
    return null;
  }
}

/**
 * Calcula distancia real por carretera entre dos puntos usando LocationIQ Matrix
 */
async function calcularDistanciaReal(origenLat, origenLng, destLat, destLng) {
  try {
    const url = 'https://us1.locationiq.com/v1/matrix/driving/json';
    const response = await axios.get(url, {
      params: {
        key: LOCATIONIQ_KEY,
        sources: `0`,
        destinations: `1`,
        coordinates: `${origenLng},${origenLat};${destLng},${destLat}`,
        annotations: 'distance,duration'
      }
    });

    if (response.data && response.data.distances && response.data.distances[0]) {
      const distanciaMetros = response.data.distances[0][0];
      const distanciaKm = distanciaMetros / 1000;
      
      // Calcular tarifa base según distancia (ejemplo: $3000 + $1500 por km)
      const tarifaBase = 3000;
      const tarifaPorKm = 1500;
      const tarifa = Math.round(tarifaBase + (distanciaKm * tarifaPorKm));
      
      return {
        distanciaKm: Math.round(distanciaKm * 10) / 10,
        duracionMin: Math.round(response.data.durations[0][0] / 60),
        tarifaRecomendada: tarifa
      };
    }
    return null;
  } catch (error) {
    console.error('❌ Error en calcularDistanciaReal:', error.message);
    return null;
  }
}

/**
 * Obtiene barrio y municipio exactos desde LocationIQ
 */
async function obtenerBarrioExacto(direccion) {
  const geo = await geocodificar(direccion);
  if (!geo) return null;

  const address = geo.address || {};
  
  // Extraer información relevante
  return {
    barrio: address.suburb || address.neighbourhood || address.hamlet || '',
    municipio: address.city || address.town || address.municipality || '',
    departamento: address.state || '',
    lat: geo.lat,
    lng: geo.lng,
    direccionCompleta: geo.display_name,
    codigoPostal: address.postcode || ''
  };
}

/**
 * Autocompletado de direcciones (para mientras el usuario escribe)
 */
async function autocompletarDireccion(termino) {
  try {
    const url = 'https://us1.locationiq.com/v1/autocomplete.php';
    const response = await axios.get(url, {
      params: {
        key: LOCATIONIQ_KEY,
        q: termino,
        limit: 5,
        'accept-language': 'es'
      }
    });

    return (response.data || []).map(item => ({
      direccion: item.display_name,
      lat: parseFloat(item.lat),
      lng: parseFloat(item.lon)
    }));
  } catch (error) {
    console.error('❌ Error en autocompletar:', error.message);
    return [];
  }
}

module.exports = {
  geocodificar,
  geocodificarInversa,
  calcularDistanciaReal,
  obtenerBarrioExacto,
  autocompletarDireccion
};