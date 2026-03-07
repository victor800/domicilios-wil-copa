
// ─── AÑADIR ESTAS FUNCIONES A services/sheets.js ─────────────────────────────
// Hoja "coordenadas": A=BARRIO  B=LAT  C=LONG  D=TARIFA  E=NOTAS

/**
 * Busca un barrio en la hoja "coordenadas" (búsqueda insensible a mayúsculas/tildes)
 * @param {string} texto  — lo que escribió el cliente
 * @returns {{ barrio, lat, lng, tarifa } | null}
 */
async function buscarBarrioEnSheet(texto) {
  try {
    const sheets = await getSheetsClient();  // usa tu función existente
    const res    = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'coordenadas!A2:E'
    });
    const filas = res.data.values || [];
    const norm  = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    const query = norm(texto);

    for (const fila of filas) {
      const barrio = (fila[0] || '').trim();
      if (!barrio) continue;
      // Match exacto o si el barrio está contenido en el texto del cliente
      if (norm(barrio) === query || query.includes(norm(barrio)) || norm(barrio).includes(query)) {
        const tarifa = parseFloat((fila[3] || '').toString().replace(/[^0-9.]/g, '')) || null;
        return {
          barrio,
          lat:    parseFloat(fila[1]) || null,
          lng:    parseFloat(fila[2]) || null,
          tarifa
        };
      }
    }
    return null;
  } catch(e) {
    console.error('buscarBarrioEnSheet:', e.message);
    return null;
  }
}

/**
 * Obtiene el cliente de Google Sheets
 * (Si ya tienes una función getSheetsClient, úsala; si no, agrega esta)
 */
async function getSheetsClient() {
  const { google } = require('googleapis');
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const authClient = await auth.getClient();
  return google.sheets({ version: 'v4', auth: authClient });
}

/**
 * Busca un barrio en la hoja "coordenadas"
 * @param {string} texto - Barrio o dirección a buscar
 * @returns {Object|null} { barrio, lat, lng, tarifa, zona }
 */
async function buscarBarrioEnSheet(texto) {
  try {
    const sheets = await getSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'coordenadas!A:E' // A=barrio, B=lat, C=lng, D=tarifa, E=zona/notas
    });
    
    const filas = res.data.values || [];
    if (filas.length < 2) return null;
    
    // Normalizar texto de búsqueda (quitar tildes, mayúsculas)
    const norm = s => (s || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\w\s]/g, '').trim();
    
    const query = norm(texto);
    let mejorMatch = null;
    let mejorScore = 0;
    
    // Recorrer desde la fila 2 (saltar encabezado)
    for (let i = 1; i < filas.length; i++) {
      const fila = filas[i];
      if (!fila || fila.length < 4) continue;
      
      const barrio = (fila[0] || '').trim();
      if (!barrio) continue;
      
      const barrioNorm = norm(barrio);
      
      // Calcular puntaje de coincidencia
      let score = 0;
      if (barrioNorm === query) {
        score = 100; // Coincidencia exacta
      } else if (query.includes(barrioNorm) || barrioNorm.includes(query)) {
        score = 50; // Uno contiene al otro
      }
      
      if (score > mejorScore) {
        mejorScore = score;
        
        // Parsear tarifa (columna D)
        let tarifa = 0;
        if (fila[3]) {
          const tarifaStr = fila[3].toString().replace(/[^0-9]/g, '');
          tarifa = parseInt(tarifaStr) || 0;
        }
        
        mejorMatch = {
          barrio: barrio,
          lat: parseFloat(fila[1]) || null,
          lng: parseFloat(fila[2]) || null,
          tarifa: tarifa,
          zona: fila[4] || 'Medellín'
        };
      }
    }
    
    return mejorMatch;
  } catch(e) {
    console.error('❌ buscarBarrioEnSheet error:', e.message);
    return null;
  }
}

/**
 * Guarda un barrio nuevo en la hoja "coordenadas"
 * @param {Object} datos - { barrio, lat, lng, tarifa, notas }
 */
async function guardarBarrioEnSheet(datos) {
  try {
    const sheets = await getSheetsClient();
    
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'coordenadas!A:E',
      valueInputOption: 'RAW',
      resource: {
        values: [[
          datos.barrio || '',
          datos.lat || '',
          datos.lng || '',
          datos.tarifa || '',
          datos.notas || 'Auto-detectado'
        ]]
      }
    });
    console.log(`✅ Barrio guardado: ${datos.barrio}`);
  } catch(e) {
    console.error('guardarBarrioEnSheet:', e.message);
  }
}

// Si tu archivo ya tiene un module.exports, AGREGA estas funciones:
// module.exports = {
//   ...lo que ya tienes...,
//   buscarBarrioEnSheet,
//   guardarBarrioEnSheet
// };



/**
 * Guarda un barrio nuevo en la hoja "coordenadas" (solo si no existe ya)
 * @param {{ barrio, lat, lng, tarifa, notas }} datos
 */
async function guardarBarrioEnSheet(datos) {
  try {
    // Verificar si ya existe
    const existe = await buscarBarrioEnSheet(datos.barrio);
    if (existe) return;  // ya está, no duplicar

    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'coordenadas!A:E',
      valueInputOption: 'RAW',
      resource: {
        values: [[
          datos.barrio || '',
          datos.lat    || '',
          datos.lng    || '',
          datos.tarifa || '',
          datos.notas  || 'Auto-detectado'
        ]]
      }
    });
    console.log(`📍 Barrio nuevo guardado en hoja coordenadas: ${datos.barrio}`);
  } catch(e) {
    console.error('guardarBarrioEnSheet:', e.message);
  }
}

// Agregar al module.exports de sheets.js:
// buscarBarrioEnSheet, guardarBarrioEnSheet