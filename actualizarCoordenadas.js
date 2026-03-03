

// --- 1. CONFIGURACIÓN ---
const SPREADSHEET_ID = '1-pX8D71WTt9e8SYPHt_gVxBRvbjBUyDqb5XWRRPGUUU';
const CREDENTIALS_PATH = './credentials.json';
const SHEET_NAME = 'coordenadas';

// --- 2. IMPORTACIONES ---
const { google } = require('googleapis');
const axios = require('axios');

// --- 3. DATOS DE LOS BARRIOS Y TARIFAS ---
const TARIFAS = {
  5000:  ['ASUNCION','FÁTIMA','MIRADOR AZUL','AZULITA PARTE BAJA','CRISTO REY ABAJO DE LA PISCINA','HORIZONTES','MIRAFLORES','MISERICORDIA HASTA PRINCESS','MOJÓN','OBRERO','PEDREGAL PARTE BAJA','PEDRERA','SAN FRANCISCO','SHANGAY','SIMÓN BOLÍVAR','TOBÓN QUINTERO','VEGAS PARTE BAJA','MONTE VERDE','REMANSO','DE LA ASUNCIÓN A LA ASUNCIÓN','YARUMITO PARTE BAJA','CANOAS HASTA LA TIENDA DEL CUSCO','PIEDRAS BLANCAS','PORVENIR','RECREO','DE LA PEDRERA A LA PEDRERA'],
  6000:  ['CALORCOL','AZULITA PARTE ALTA','VILLAS DE COPACABANA','TABLAZO','CANOAS DESPUÉS DE LA TIENDA DEL CUSCO','CRISTO REY DE LA PISCINA HACIA ARRIBA','PEDREGAL PARTE ALTA','COLINAS DEL PEDREGAL','VEGAS INTERIORES IGLESIA MANANTIALES','YARUMITO DESPUÉS DEL EMPEDRADO','YARUMITO INTERIOR CANCHA NUEVA','VEGAS PARTE ALTA','EDIFICIOS AMARILLOS','MONTESION','JARDÍN DE LA MARGARITA','RESERVAS DE SAN JUAN 1','POSADA DEL VIENTO','ROSA DE LOS VIENTOS','VICENZA','RESERVAS DE SAN JUAN 2'],
  7000:  ['BARRIO MARIA','PORTERIA PARCELACIÓN EL PARAISO','TORRE DEL BOSQUE','EDIFICIO POBLADO NORTE','SAN JUAN CAMPESTRE'],
  8000:  ['VIA MACHADO','CANTERAS','VILLANUEVA PARTE BAJA Y ALTA','VILLA ROCA','SAN JUAN'],
  10000: ['GUASIMALITO','MACHADO'],
  11000: ['UNIDADES DE MACHADO','ARBOLEDA DEL CAMPO'],
  13000: ['FONTIDUEÑO'],
  14000: ['NAVARRA','NIQUIA PARTE BAJA','UNIDADES DE NAVARRA'],
  17000: ['PARQUE DE GIRARDOTA','TOLEDO CAMPESTRE'],
  18000: ['PARQUE DE BELLO'],
  19000: ['FABRICATO'],
  20000: ['UNIDADES DE MADERA']
};

// --- 4. FUNCIÓN PARA SIMPLIFICAR NOMBRES DE BARRIOS ---
function simplificarNombreBarrio(nombreOriginal) {
    // Convertir a minúsculas para comparar
    const nombre = nombreOriginal.toLowerCase();
    
    // Reglas de simplificación
    if (nombre.includes('cristo rey')) {
        return 'Cristo Rey Copacabana';
    }
    if (nombre.includes('azulita')) {
        return 'Azulita Copacabana';
    }
    if (nombre.includes('misericordia')) {
        return 'Misericordia Copacabana';
    }
    if (nombre.includes('pedregal')) {
        return 'Pedregal Copacabana';
    }
    if (nombre.includes('vegas')) {
        return 'Vegas Copacabana';
    }
    if (nombre.includes('yarumito')) {
        return 'Yarumito Copacabana';
    }
    if (nombre.includes('canoas')) {
        return 'Canoas Copacabana';
    }
    if (nombre.includes('san juan')) {
        return 'San Juan Copacabana';
    }
    if (nombre.includes('unidades de machado')) {
        return 'Unidades Machado Copacabana';
    }
    if (nombre.includes('navarra')) {
        return 'Navarra Copacabana';
    }
    if (nombre.includes('niquia')) {
        return 'Niquia Copacabana';
    }
    if (nombre.includes('parque de girardota')) {
        return 'Parque Girardota';
    }
    if (nombre.includes('parque de bello')) {
        return 'Parque Bello';
    }
    
    // Si no hay regla especial, devolver el nombre original + Copacabana
    return `${nombreOriginal} Copacabana`;
}

// --- 5. FUNCIÓN PARA PREPARAR LISTA DE BARRIOS ---
function prepararListaDeBarrios() {
    const barrios = [];
    for (const [tarifa, lista] of Object.entries(TARIFAS)) {
        lista.forEach(nombre => {
            barrios.push({ 
                nombreOriginal: nombre.trim(), 
                nombreBusqueda: simplificarNombreBarrio(nombre),
                tarifa: parseInt(tarifa) 
            });
        });
    }
    console.log(`📊 Total de barrios encontrados: ${barrios.length}`);
    return barrios;
}

// --- 6. FUNCIÓN PARA OBTENER COORDENADAS (con intentos múltiples) ---
async function obtenerCoordenadas(nombreOriginal, nombreBusqueda) {
    const municipio = 'Copacabana, Antioquia, Colombia';
    
    // Intentar con el nombre simplificado primero
    const busquedas = [
        `${nombreBusqueda}, ${municipio}`,  // Versión simplificada
        `${nombreOriginal}, ${municipio}`,  // Versión original
        `${nombreOriginal} Copacabana`       // Solo con Copacabana
    ];
    
    for (let i = 0; i < busquedas.length; i++) {
        const query = busquedas[i];
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`;
        
        console.log(`   🔍 Intento ${i+1}: ${query}`);

        try {
            const response = await axios.get(url, {
                headers: {
                    'User-Agent': 'MiAppDeBarrios/1.0 (tu-email@ejemplo.com)'
                }
            });
            
            const data = response.data;

            if (data && data.length > 0) {
                const { lat, lon } = data[0];
                console.log(`   ✅ Encontrado en intento ${i+1}: (${lat}, ${lon})`);
                return { lat: parseFloat(lat), lon: parseFloat(lon) };
            }
        } catch (error) {
            console.log(`   ⚠️  Error en intento ${i+1}: ${error.message}`);
        }
        
        // Pequeña pausa entre intentos
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log(`   ❌ No encontrado después de 3 intentos`);
    return { lat: 'NO_ENCONTRADO', lon: 'NO_ENCONTRADO' };
}

// --- 7. FUNCIÓN PARA ESCRIBIR EN GOOGLE SHEETS ---
async function escribirEnGoogleSheets(auth, filas) {
    const sheets = google.sheets({ version: 'v4', auth });
    
    try {
        // Limpiar la hoja
        try {
            await sheets.spreadsheets.values.clear({
                spreadsheetId: SPREADSHEET_ID,
                range: `${SHEET_NAME}!A:D`,
            });
            console.log('🧹 Hoja limpiada');
        } catch (clearError) {
            console.log('⚠️ No se pudo limpiar la hoja, continuando...');
        }

        // Escribir los nuevos datos
        const response = await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME}!A1`,
            valueInputOption: 'USER_ENTERED',
            resource: { values: filas },
        });
        console.log(`✅ ${response.data.updatedCells} celdas actualizadas en Google Sheets.`);
    } catch (err) {
        console.error('❌ Error al escribir en Google Sheets:', err.message);
    }
}

// --- 8. FUNCIÓN PRINCIPAL ---
async function main() {
    console.log('🚀 Iniciando proceso de actualización de coordenadas...');

    const barrios = prepararListaDeBarrios();
    console.log(`📋 Se procesarán ${barrios.length} barrios.\n`);

    const filasParaSheets = [['BARRIO', 'LAT', 'LONG', 'TARIFA', 'NOTAS']];

    for (let i = 0; i < barrios.length; i++) {
        const barrio = barrios[i];
        console.log(`\nProcesando (${i + 1}/${barrios.length}): ${barrio.nombreOriginal}`);
        
        const { lat, lon } = await obtenerCoordenadas(barrio.nombreOriginal, barrio.nombreBusqueda);
        
        let notas = '';
        if (lat === 'NO_ENCONTRADO') {
            notas = 'No encontrado en mapa, verificar nombre';
        } else if (lat === 'ERROR') {
            notas = 'Error en la búsqueda';
        }
        
        filasParaSheets.push([barrio.nombreOriginal, lat, lon, barrio.tarifa, notas]);

        // Pausa entre barrios
        await new Promise(resolve => setTimeout(resolve, 1500));
    }

    console.log(`\n📦 Lista de ${filasParaSheets.length - 1} barrios preparada.`);

    // Enviar a Google Sheets
    try {
        const auth = new google.auth.GoogleAuth({
            keyFile: CREDENTIALS_PATH,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        const client = await auth.getClient();
        console.log('🔑 Autenticación con Google exitosa.');

        await escribirEnGoogleSheets(client, filasParaSheets);
        
        // Mostrar resumen
        const encontrados = filasParaSheets.filter(fila => fila[1] !== 'NO_ENCONTRADO' && fila[1] !== 'ERROR').length - 1;
        console.log(`\n📊 RESUMEN:`);
        console.log(`✅ Barrios encontrados: ${encontrados}`);
        console.log(`❌ Barrios no encontrados: ${barrios.length - encontrados}`);
        
    } catch (error) {
        console.error('❌ Error en la autenticación con Google:', error.message);
    }

    console.log('\n🏁 Proceso finalizado.');
}

// --- 9. EJECUCIÓN ---
main();