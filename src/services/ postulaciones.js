// ─────────────────────────────────────────────────────────────────────────────
// postulaciones.js  — endpoint para guardar postulaciones de domiciliarios
//
// AGREGAR en index.js:
//   const postulaciones = require('./routes/postulaciones');
//   app.use(postulaciones);
//
// O si no tienes Express, agrega estas líneas en index.js donde inicias el servidor.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const path    = require('path');
const { google } = require('googleapis');

const router = express.Router();

// ── Nombre de la hoja destino ────────────────────────────────────────────────
const HOJA_POSTULACIONES = 'domiciliarios_nuevos';

// ── Columnas de la hoja (en ese orden) ──────────────────────────────────────
// A: Timestamp  B: Fecha postulación  C: Nombre  D: Cédula  E: Teléfono
// F: URL Licencia  G: URL Tecnomecánica  H: URL SOAT  I: Estado

// ── Auth con Google Sheets (igual que el resto del proyecto) ─────────────────
async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS || './credentials.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

// ── Servir el HTML del formulario ────────────────────────────────────────────
router.get('/postulacion', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/postulacion_domiciliario.html'));
});

// ── Recibir y guardar la postulación ────────────────────────────────────────
router.post('/postulacion', async (req, res) => {
  try {
    const {
      fecha, nombre, cedula, telefono,
      url_pase, url_tecno, url_soat, timestamp
    } = req.body;

    // Validación mínima
    if (!nombre || !cedula || !telefono || !url_pase || !url_tecno || !url_soat) {
      return res.status(400).json({ ok: false, error: 'Faltan campos requeridos' });
    }

    const sheets = await getSheetsClient();
    const spreadsheetId = process.env.SPREADSHEET_ID;

    // ── Verificar si la hoja existe; si no, crearla con cabeceras ────────────
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const hojaExiste = meta.data.sheets.some(
      s => s.properties.title === HOJA_POSTULACIONES
    );

    if (!hojaExiste) {
      // Crear la hoja
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{
            addSheet: {
              properties: {
                title: HOJA_POSTULACIONES,
                gridProperties: { rowCount: 1000, columnCount: 9 }
              }
            }
          }]
        }
      });

      // Poner cabeceras
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${HOJA_POSTULACIONES}!A1:I1`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [[
            'TIMESTAMP', 'FECHA', 'NOMBRE', 'CÉDULA', 'TELÉFONO',
            'LICENCIA (URL)', 'TECNOMECÁNICA (URL)', 'SOAT (URL)', 'ESTADO'
          ]]
        }
      });

      // Formato cabecera: fondo naranja, texto blanco, negrita
      const sheetId = (await sheets.spreadsheets.get({ spreadsheetId }))
        .data.sheets.find(s => s.properties.title === HOJA_POSTULACIONES)
        ?.properties.sheetId;

      if (sheetId !== undefined) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [{
              repeatCell: {
                range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 9 },
                cell: {
                  userEnteredFormat: {
                    backgroundColor: { red: 1, green: 0.36, blue: 0 },
                    textFormat: { foregroundColor: { red:1,green:1,blue:1 }, bold: true },
                    horizontalAlignment: 'CENTER'
                  }
                },
                fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)'
              }
            }]
          }
        });
      }

      console.log(`✅ Hoja "${HOJA_POSTULACIONES}" creada con cabeceras`);
    }

    // ── Insertar fila ────────────────────────────────────────────────────────
    const ahora     = new Date();
    const tsStr     = ahora.toLocaleString('es-CO', { timeZone: 'America/Bogota' });
    const fechaStr  = fecha || ahora.toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });

    // Las URLs se insertan como fórmulas IMAGE() para que se vean en Sheets
    // =IMAGE("url") muestra la imagen directamente en la celda
    const imgFormula = url => `=IMAGE("${url}")`;

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${HOJA_POSTULACIONES}!A:I`,
      valueInputOption: 'USER_ENTERED',  // necesario para fórmulas IMAGE()
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[
          tsStr,
          fechaStr,
          nombre.toUpperCase(),
          cedula,
          telefono,
          imgFormula(url_pase),
          imgFormula(url_tecno),
          imgFormula(url_soat),
          'PENDIENTE'
        ]]
      }
    });

    console.log(`📋 Nueva postulación: ${nombre} | ${cedula} | ${telefono}`);
    console.log(`   Pase: ${url_pase}`);
    console.log(`   Tecno: ${url_tecno}`);
    console.log(`   SOAT: ${url_soat}`);

    return res.json({ ok: true, mensaje: 'Postulación registrada correctamente' });

  } catch (err) {
    console.error('❌ Error en /postulacion:', err.message);
    return res.status(500).json({ ok: false, error: 'Error interno del servidor' });
  }
});

module.exports = router;