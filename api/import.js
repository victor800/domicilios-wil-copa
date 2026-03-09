// api/import.js  — Procesa el Excel y escribe en Google Sheets directamente
// Columnas del Excel de origen:
//   A: Código (ignorar)
//   B: Descripción ✅
//   C: Código2 (ignorar)
//   D: Laboratorio ✅
//   E: IVA% (ignorar)
//   F: Venta (ignorar)
//   G: Unidad ✅
//   H: Precio ✅
//   I: Precio Unitario ✅

const { google } = require('googleapis');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Método no permitido' });

  try {
    // ── 1. Recibir el body como buffer binario puro ────────────────────────
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const raw = Buffer.concat(chunks);

    // Detectar si viene como base64 string o como binario directo
    let buf;
    const rawStr = raw.toString('utf8').trim();
    if (rawStr.startsWith('data:') || /^[A-Za-z0-9+/]+=*$/.test(rawStr.substring(0, 100))) {
      // Viene como base64
      const b64 = rawStr.replace(/^data:[^;]+;base64,/, '');
      buf = Buffer.from(b64, 'base64');
    } else {
      // Viene como binario directo
      buf = raw;
    }

    // ── 2. Parsear el Excel con xlsx ───────────────────────────────────────
    console.log("buf size:", buf.length, "first4:", buf.slice(0,4).toString("hex"));
    const wb   = XLSX.read(buf, { type: "buffer" });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    // ── 3. Mapear columnas correctas e ignorar encabezado ─────────────────
    //   Fila 0  = encabezados → skip
    //   Col B=1  Descripción
    //   Col D=3  Laboratorio
    //   Col G=6  Unidad
    //   Col H=7  Precio
    //   Col I=8  Precio Unitario
    console.log("fila 0:", JSON.stringify(rows[0]));
    console.log("fila 1:", JSON.stringify(rows[1]));
    console.log("fila 2:", JSON.stringify(rows[2]));
    const productos = [];
    for (let i = 1; i < rows.length; i++) {
      const row  = rows[i];
      const desc = (row[1] || '').toString().trim();
      if (!desc) continue;                          // omite filas sin descripción

      const lab  = (row[3]  || '').toString().trim();
      const und  = (row[6]  || '').toString().trim();
      const prec = (row[7]  || '').toString().trim();
      const pu   = (row[8]  || '').toString().trim();

      productos.push([desc, lab, und, prec, pu]);
    }

    if (!productos.length)
      return res.status(400).json({ error: 'El Excel no tiene productos válidos' });

    // ── 4. Determinar hoja destino ─────────────────────────────────────────
    const tienda = ((req.query.tienda || 'EXPERTOS')).toUpperCase();
    const hoja   = tienda === 'CENTRAL'
      ? 'STOCK_DROGUERIA_CENTRAL'
      : 'STOCK_DROGUERIA_EXPERTOS';

    // ── 5. Autenticar con Google Sheets ───────────────────────────────────
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key:  (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
    const sid    = process.env.GOOGLE_SHEETS_ID;

    // ── 6. Limpiar hoja y escribir datos ──────────────────────────────────
    // Encabezados fijos en fila 1
    const header = [['Descripción', 'Laboratorio', 'Unidad', 'Precio', 'Precio Unitario']];
    const values = header.concat(productos);

    await sheets.spreadsheets.values.clear({
      spreadsheetId: sid,
      range: `${hoja}!A:E`,
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: sid,
      range: `${hoja}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values },
    });

    res.status(200).json({
      ok:    true,
      count: productos.length,
      hoja,
    });

  } catch (e) {
    console.error('import API error:', e.message);
    res.status(500).json({ error: e.message });
  }
};