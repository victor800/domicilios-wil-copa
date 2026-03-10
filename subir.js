const { google } = require('googleapis');
const XLSX = require('xlsx');

const EXCEL_PATH = process.argv[2];
const TIENDA = (process.argv[3] || 'EXPERTOS').toUpperCase();

async function main() {
  if (!EXCEL_PATH) { console.error('Uso: node subir.js archivo.xlsx [EXPERTOS|CENTRAL]'); process.exit(1); }

  console.log(`📂 Leyendo: ${EXCEL_PATH}`);
  const wb = XLSX.readFile(EXCEL_PATH, {raw:false, sheetStubs:true});
  const ws = wb.Sheets[wb.SheetNames[0]];
  
  // Leer como objetos usando la fila 2 como encabezado real (fila 1 puede ser combinada)
  const allRows = XLSX.utils.sheet_to_json(ws, {header:1, defval:'', blankrows:false});
  
  // Encontrar la fila que tiene "Descripción"
  let headerIdx = -1;
  for (let i = 0; i < Math.min(5, allRows.length); i++) {
    const row = allRows[i];
    if (row.some(c => c.toString().toLowerCase().includes('descripci'))) {
      headerIdx = i;
      break;
    }
  }
  console.log(`📋 Encabezado en fila: ${headerIdx}`);
  console.log(`📋 Encabezados:`, allRows[headerIdx]);

  const headers = allRows[headerIdx] || [];
  const descIdx = headers.findIndex(h => h.toString().toLowerCase().includes('descripci'));
  const labIdx  = headers.findIndex(h => h.toString().toLowerCase().includes('laborator'));
  const undIdx  = headers.findIndex(h => h.toString().toLowerCase().includes('unidad'));
  const precIdx = headers.findIndex(h => h.toString().toLowerCase().includes('precio') && !h.toString().toLowerCase().includes('unitario'));
  const puIdx   = headers.findIndex(h => h.toString().toLowerCase().includes('unitario'));

  console.log(`📌 Columnas → Desc:${descIdx} Lab:${labIdx} Und:${undIdx} Precio:${precIdx} PU:${puIdx}`);

  const productos = [];
  for (let i = headerIdx + 1; i < allRows.length; i++) {
    const row = allRows[i];
    const desc = (row[descIdx] || '').toString().trim();
    if (!desc) continue;
    productos.push([
      desc,
      (row[labIdx]  || '').toString().trim(),
      (row[undIdx]  || '').toString().trim(),
      (row[precIdx] || '').toString().trim(),
      (row[puIdx]   || '').toString().trim(),
    ]);
  }
  console.log(`✅ ${productos.length} productos leídos`);

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
  const sid = process.env.GOOGLE_SHEETS_ID;
  const hoja = TIENDA === 'CENTRAL' ? 'STOCK_DROGUERIA_CENTRAL' : 'STOCK_DROGUERIA_EXPERTOS';

  const values = [['Descripción','Laboratorio','Unidad','Precio','Precio Unitario'], ...productos];
  await sheets.spreadsheets.values.clear({ spreadsheetId: sid, range: `${hoja}!A:E` });
  await sheets.spreadsheets.values.update({
    spreadsheetId: sid, range: `${hoja}!A1`,
    valueInputOption: 'RAW', requestBody: { values },
  });
  console.log(`🚀 ${productos.length} productos guardados en ${hoja}`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
