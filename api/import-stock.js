// api/import-stock.js
const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
const XLSX = require('xlsx');

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

// Normaliza texto: minúsculas, sin tildes, sin espacios extra
function norm(t) {
  if (!t) return '';
  return t.toString().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ').trim();
}

// SOLO coincidencia exacta — evita que "Precio" matchee "IVA%" o "Precio Unitario"
function findColExact(headers, name) {
  const n = norm(name);
  for (let i = 0; i < headers.length; i++) {
    if (norm(headers[i]) === n) return i;
  }
  return -1;
}

function procesarExcel(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  if (rows.length < 2) return [];

  // Encontrar fila de encabezados (busca "descripcion" exacto)
  let headerIdx = -1;
  let headers = [];
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    if (row.some(c => norm(c) === 'descripcion')) {
      headerIdx = i;
      headers = row.map(c => c !== undefined && c !== null ? c.toString().trim() : '');
      break;
    }
  }

  if (headerIdx === -1) {
    throw new Error('No se encontró columna con encabezado exacto "Descripción"');
  }

  console.log('Encabezados detectados:', headers);

  // Buscar columnas por coincidencia EXACTA únicamente
  const cD  = findColExact(headers, 'Descripción');
  const cL  = findColExact(headers, 'Laboratorio');
  const cU  = findColExact(headers, 'Unidad');
  const cP  = findColExact(headers, 'Precio');
  const cPU = findColExact(headers, 'Precio Unitario');

  console.log('Índices:', { Descripción: cD, Laboratorio: cL, Unidad: cU, Precio: cP, 'Precio Unitario': cPU });

  const faltantes = [];
  if (cD  === -1) faltantes.push('Descripción');
  if (cL  === -1) faltantes.push('Laboratorio');
  if (cU  === -1) faltantes.push('Unidad');
  if (cP  === -1) faltantes.push('Precio');
  if (cPU === -1) faltantes.push('Precio Unitario');

  if (faltantes.length) {
    throw new Error(
      `Columnas no encontradas: ${faltantes.join(', ')}. ` +
      `Encabezados leídos: [${headers.filter(Boolean).join(' | ')}]`
    );
  }

  if (cP === cPU) {
    throw new Error('Error interno: "Precio" y "Precio Unitario" apuntan a la misma columna');
  }

  const productos = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;

    const desc = row[cD] !== undefined ? row[cD].toString().trim() : '';
    if (!desc) continue; // omitir filas sin descripción

    // Extraer solo dígitos del precio
    const precioRaw = row[cP] !== undefined ? row[cP].toString() : '';
    const puRaw     = row[cPU] !== undefined ? row[cPU].toString() : '';

    const precio = precioRaw.replace(/[^0-9]/g, '') || '';
    let pu       = puRaw.replace(/[^0-9]/g, '') || '';

    // Si precio unitario está vacío, usar precio de caja
    if (!pu && precio) pu = precio;

    // Omitir si ambos precios son 0 o vacíos (filas basura)
    if (!precio && !pu) continue;

    productos.push({
      descripcion: desc,
      laboratorio: (row[cL] || '').toString().trim(),
      unidad:      (row[cU] || '').toString().trim(),
      precio,
      precioUnitario: pu,
    });
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
    const { fileBase64, fileName } = req.body || {};

    if (!fileBase64) return res.status(400).json({ error: 'No se recibió archivo (fileBase64 vacío)' });

    console.log(`Archivo: ${fileName} | b64: ${fileBase64.length} chars`);

    const buffer    = Buffer.from(fileBase64, 'base64');
    const productos = procesarExcel(buffer);

    if (!productos.length)
      return res.status(400).json({ error: 'No se encontraron productos válidos en el archivo' });

    const hoja = tienda === 'CENTRAL'
      ? 'STOCK_DROGUERIA_CENTRAL'
      : 'STOCK_DROGUERIA_EXPERTOS';

    const auth   = getAuth();
    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
    if (!spreadsheetId) throw new Error('GOOGLE_SHEETS_ID no configurado');

    // Limpiar hoja existente
    await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${hoja}!A2:E` });

    // Escribir todos los productos de una sola vez
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${hoja}!A2`,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: productos.map(p => [
          p.descripcion,
          p.laboratorio,
          p.unidad,
          p.precio,
          p.precioUnitario,
        ]),
      },
    });

    console.log(`✅ ${tienda}: ${productos.length} productos → ${hoja}`);
    res.status(200).json({ ok: true, count: productos.length });

  } catch (e) {
    console.error('import-stock error:', e.message);
    if (e.message === 'No autorizado') return res.status(403).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
module.exports.config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};


};
// Sin multer — bodyParser JSON activo por defecto en Vercel