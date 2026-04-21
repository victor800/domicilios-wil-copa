// api/pedidos.js
// GET /api/pedidos?estado=PENDIENTE
// Lee directamente desde Google Sheets — sin memoria
// Columnas hoja "Pedidos":
// A=ID  B=NOMBRE_CLI  C=TELEFONO  D=METODO_PAGO  E=ESTADO
// F=NEGOCIO  G=TIENDA  H=PRODUCTOS  I=DIRECCION
// J=PRECIO_DOMICILIO  K=TOTAL  L=DOMICILIARIO  M=HORA
// N=FECHA  O=PRESUPUESTO  P=BARRIO_DETECTADO

const { google } = require('googleapis');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function getSheets() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

function parsearFila(r) {
  return {
    id:              (r[0]  || '').trim(),
    cliente:         (r[1]  || '').trim(),
    telefono:        (r[2]  || '').trim(),
    metodoPago:      (r[3]  || '').trim(),
    estado:          (r[4]  || '').trim().toUpperCase(),
    negocioNombre:   (r[5]  || '').trim(),
    tienda:          (r[6]  || '').trim() || null,
    productos:       (r[7]  || '').trim(),
    direccion:       (r[8]  || '').trim(),
    precioDomicilio: parseFloat((r[9]  || '0').replace(/[^0-9.]/g, '')) || 0,
    total:           parseFloat((r[10] || '0').replace(/[^0-9.]/g, '')) || 0,
    domiciliario:    (r[11] || '').trim(),
    hora:            (r[12] || '').trim(),
    fecha:           (r[13] || '').trim(),
    presupuesto:     (r[14] || '').trim(),
    barrioDetectado: (r[15] || '').trim(),
    fila:            null, // se asigna al leer
  };
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { estado, id, fecha } = req.query;

  try {
    const sheets = await getSheets();
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: 'Pedidos!A2:P',
    });

    const rows = resp.data.values || [];
    let pedidos = rows
      .map((r, idx) => ({ ...parsearFila(r), fila: idx + 2 }))
      .filter(p => p.id); // ignorar filas vacías

    // Filtrar por estado si se pide
    if (estado && estado !== 'ALL') {
      pedidos = pedidos.filter(p => p.estado === estado.toUpperCase());
    }

    // Filtrar por ID específico
    if (id) {
      pedidos = pedidos.filter(p => p.id === id);
    }

    // Filtrar por fecha (DD/MM/YYYY)
    if (fecha) {
      pedidos = pedidos.filter(p => p.fecha === fecha);
    }

    // Ordenar: más recientes primero
    pedidos.reverse();

    return res.status(200).json({ ok: true, pedidos, total: pedidos.length });

  } catch (e) {
    console.error('api/pedidos ERROR:', e.message);
    return res.status(500).json({ error: 'Error leyendo pedidos', detail: e.message });
  }
};