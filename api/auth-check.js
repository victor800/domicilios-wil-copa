// api/auth-check.js
// POST /api/auth-check  — verifica token Google, valida que el email esté en ADMIN_EMAILS

const { OAuth2Client } = require('google-auth-library');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ ok: false, error: 'Sin token' });

    const client  = new OAuth2Client(process.env.GOOGLE_OAUTH_CLIENT_ID);
    const ticket  = await client.verifyIdToken({
      idToken:  credential,
      audience: process.env.GOOGLE_OAUTH_CLIENT_ID
    });
    const payload = ticket.getPayload();
    const email   = payload.email;

    // Lista de admins en variable de entorno, separados por coma
    console.log('ADMIN_EMAILS:', process.env.ADMIN_EMAILS);
    const admins = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase());
    if (!admins.includes(email.toLowerCase())) {
      return res.status(403).json({ ok: false, error: `${email} no está autorizado` });
    }

    res.status(200).json({ ok: true, email, name: payload.name });
  } catch (e) {
    console.error('auth-check error:', e.message);
    res.status(401).json({ ok: false, error: 'Token inválido' });
  }
};