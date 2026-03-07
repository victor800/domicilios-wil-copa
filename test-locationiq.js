// test-locationiq.js
require('dotenv').config();
const axios = require('axios');

async function testLocationIQ() {
  const apiKey = process.env.LOCATIONIQ_API_KEY;
  
  try {
    // Probar geocodificación de Copacabana
    const response = await axios.get('https://us1.locationiq.com/v1/search.php', {
      params: {
        key: apiKey,
        q: 'Copacabana, Antioquia',
        format: 'json',
        limit: 1
      }
    });
    
    if (response.data && response.data.length > 0) {
      console.log('✅ LocationIQ funciona correctamente!');
      console.log('📍 Coordenadas de Copacabana:', response.data[0].lat, response.data[0].lon);
      return true;
    }
  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
    return false;
  }
}

testLocationIQ();