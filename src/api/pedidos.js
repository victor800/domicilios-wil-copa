// api/pedidos.js
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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    await verificarAdmin(token);

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
      range: 'Pedidos!A:S'
    });

    const tienda = (req.query.tienda || '').toUpperCase();
    const hoy = new Date().toLocaleDateString('es-CO', {
      day:'2-digit', month:'2-digit', year:'numeric', timeZone:'America/Bogota'
    });

    const rows = (r.data.values || []).slice(1)
      .filter(r => r[0] && r[13] === hoy)
      .filter(r => !tienda || (r[7]||'').toUpperCase().includes(tienda))
      .map(r => ({
        id:          (r[0]||'').trim(),
        cliente:     (r[1]||'').trim(),
        telefono:    (r[2]||'').trim(),
        metodoPago:  (r[3]||'').trim(),
        estado:      (r[4]||'').trim().toUpperCase(),
        productos:   (r[6]||'').trim(),
        negocio:     (r[7]||'').trim(),
        direccion:   (r[11]||'').trim(),
        hora:        (r[12]||'').trim(),
        fecha:       (r[13]||'').trim(),
        total:       pn(r[14]),
        domiciliario:(r[15]||'').trim(),
      }))
      .reverse();

    res.status(200).json(rows);
  } catch (e) {
    const status = e.message === 'No autorizado' ? 403 : 500;
    res.status(status).json({ error: e.message });
  }
};