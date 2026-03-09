// api/pedidos.js
// Columnas A-R:
// A=ID_PEDIDO B=NOMBRE_CLI C=TELEFONO D=METODO_PAGO E=ESTADO F=IMAGEN_TRANSFERENCIA
// G=PRODUCTOS H=MARCA I=CANTIDAD J=V/U K=V/TOTAL L=DIRECCION M=HORA N=FECHA
// O=TOTAL P=NOMBRE_DOMI Q=HORA_TOMO_PEDIDO R=HORA_ENTREGO

const { google }       = require('googleapis');
const { OAuth2Client } = require('google-auth-library');

async function verificarAdmin(token) {
  const client  = new OAuth2Client(process.env.GOOGLE_OAUTH_CLIENT_ID);
  const ticket  = await client.verifyIdToken({ idToken: token, audience: process.env.GOOGLE_OAUTH_CLIENT_ID });
  const payload = ticket.getPayload();
  const admins  = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase());
  if (!admins.includes(payload.email.toLowerCase())) throw new Error('No autorizado');
  return payload;
}

function pn(v) { return parseInt((v||'0').toString().replace(/[^0-9]/g,'')) || 0; }
function cop(n) { return n ? '$' + n.toLocaleString('es-CO') : '—'; }

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    await verificarAdmin(token);

    const tienda = (req.query.tienda || 'EXPERTOS').toUpperCase();

    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key:  (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
    });
    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: 'Pedidos!A:R'
    });

    const rows = (r.data.values || []).slice(1)
      .filter(row => row[0]?.toString().trim())
      .filter(row => {
        const marca = (row[7] || '').toUpperCase();
        if (tienda === 'CENTRAL')  return marca.includes('CENTRAL');
        if (tienda === 'EXPERTOS') return marca.includes('EXPERTOS') || !marca.includes('CENTRAL');
        return true;
      })
      .map(row => ({
        id:           (row[0]  || '').toString().trim(),
        cliente:      (row[1]  || '').toString().trim(),
        telefono:     (row[2]  || '').toString().trim(),
        metodoPago:   (row[3]  || '').toString().trim(),
        estado:       (row[4]  || '').toString().trim(),
        productos:    (row[6]  || '').toString().trim(),
        marca:        (row[7]  || '').toString().trim(),
        direccion:    (row[11] || '').toString().trim(),
        hora:         (row[12] || '').toString().trim(),
        fecha:        (row[13] || '').toString().trim(),
        total:        pn(row[14]),
        domiciliario: (row[15] || '').toString().trim(),
        horaTomo:     (row[16] || '').toString().trim(),
        horaEntrego:  (row[17] || '').toString().trim(),
      }))
      .reverse();

    res.status(200).json(rows);
  } catch (e) {
    const status = e.message === 'No autorizado' ? 403 : 500;
    res.status(status).json({ error: e.message });
  }
};
 
