// api/import-stock.js — usa busboy para multipart/form-data (sin multer)
const { google }      = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
const XLSX            = require('xlsx');
const busboy          = require('busboy');

async function verificarAdmin(token) {
  const client = new OAuth2Client(process.env.GOOGLE_OAUTH_CLIENT_ID);
  const ticket = await client.verifyIdToken({
    idToken: token,
    audience: process.env.GOOGLE_OAUTH_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  const admins = (process.env.ADMIN_EMAILS || '')
    .split(',').map(e => e.trim().toLowerCase());
  if (!admins.includes(payload.email.toLowerCase()))
    throw new Error('No autorizado');
  return payload;
}

function getAuth() {
  const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
    ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY)
    : {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      };
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

// Leer el archivo del stream multipart con busboy
function leerArchivo(req) {
  return new Promise((resolve, reject) => {
    const bb = busboy({ headers: req.headers, limits: { fileSize: 20 * 1024 * 1024 } });
    const chunks = [];
    let encontrado = false;

    bb.on('file', (_fieldname, stream) => {
      encontrado = true;
      stream.on('data', d => chunks.push(d));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });

    bb.on('finish', () => {
      if (!encontrado) reject(new Error('No se recibió ningún archivo'));
    });
    bb.on('error', reject);

    req.pipe(bb);
  });
}

function norm(t) {
  if (!t) return '';
  return t.toString().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ').trim();
}

// Solo coincidencia exacta para evitar confusión entre "Precio" y "Precio Unitario"
function findCol(headers, name) {
  const n = norm(name);
  for (let i = 0; i < headers.length; i++)
    if (norm(headers[i]) === n) return i;
  return -1;
}

function procesarExcel(buffer) {
  const wb   = XLSX.read(buffer, { type: 'buffer' });
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  if (rows.length < 2) throw new Error('El archivo está vacío');

  // Buscar fila de encabezados
  let headerIdx = -1, headers = [];
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    if (rows[i].some(c => norm(c) === 'descripcion')) {
      headerIdx = i;
      headers = rows[i].map(c => c.toString().trim());
      break;
    }
  }
  if (headerIdx === -1) throw new Error('No se encontró columna "Descripción" en el Excel');

  console.log('Encabezados:', headers);

  const cD  = findCol(headers, 'Descripción');
  const cL  = findCol(headers, 'Laboratorio');
  const cU  = findCol(headers, 'Unidad');
  const cP  = findCol(headers, 'Precio');
  const cPU = findCol(headers, 'Precio Unitario');

  console.log('Columnas:', { cD, cL, cU, cP, cPU });

  const faltantes = [];
  if (cD  === -1) faltantes.push('Descripción');
  if (cL  === -1) faltantes.push('Laboratorio');
  if (cU  === -1) faltantes.push('Unidad');
  if (cP  === -1) faltantes.push('Precio');
  if (cPU === -1) faltantes.push('Precio Unitario');
  if (faltantes.length) throw new Error(`Columnas no encontradas: ${faltantes.join(', ')}`);
  if (cP === cPU) throw new Error('Precio y Precio Unitario apuntan a la misma columna');

  const productos = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row  = rows[i];
    const desc = row[cD] ? row[cD].toString().trim() : '';
    if (!desc) continue;

    const precio = row[cP].toString().replace(/[^0-9]/g, '') || '';
    let   pu     = row[cPU].toString().replace(/[^0-9]/g, '') || '';
    if (!pu && precio) pu = precio;
    if (!precio && !pu) continue;

    productos.push([
      desc,
      (row[cL] || '').toString().trim(),
      (row[cU] || '').toString().trim(),
      precio,
      pu,
    ]);
  }

  return productos;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Método no permitido' });

  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'Token no proporcionado' });
    await verificarAdmin(token);

    const tienda = (req.query.tienda || 'EXPERTOS').toUpperCase();

    // Leer archivo via stream (rápido, sin cargar todo en memoria)
    const buffer = await leerArchivo(req);
    console.log(`Archivo recibido: ${buffer.length} bytes`);

    const filas = procesarExcel(buffer);
    if (!filas.length) return res.status(400).json({ error: 'No se encontraron productos válidos' });

    const hoja = tienda === 'CENTRAL'
      ? 'STOCK_DROGUERIA_CENTRAL'
      : 'STOCK_DROGUERIA_EXPERTOS';

    const auth   = getAuth();
    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
    if (!spreadsheetId) throw new Error('GOOGLE_SHEETS_ID no configurado');

    // Limpiar y escribir de una sola vez
    await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${hoja}!A2:E` });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${hoja}!A2`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: filas },
    });

    console.log(`✅ ${tienda}: ${filas.length} productos → ${hoja}`);
    res.status(200).json({ ok: true, count: filas.length });

  } catch (e) {
    console.error('import-stock error:', e.message);
    if (e.message === 'No autorizado') return res.status(403).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
};

module.exports.config = {
  api: { bodyParser: false }, // necesario para que busboy lea el stream
};