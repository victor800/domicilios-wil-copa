// api/domi-login.js
// POST { idWil, password }
// Responde: { ok: true, domi: { id, nombre, tel, foto, activo, rol } }
//           { ok: false, error: "..." }

import { MongoClient } from 'mongodb';
import bcrypt from 'bcrypt';

const client = new MongoClient(process.env.MONGODB_URI);

export default async function handler(req, res) {
  // ── CORS ──────────────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Método no permitido' });
  }

  const { idWil, password } = req.body;

  // ── Validar campos requeridos ─────────────────────────────────────────────
  if (!idWil || !password) {
    return res.status(400).json({ ok: false, error: 'ID y contraseña son requeridos' });
  }

  try {
    await client.connect();
    const db = client.db('AppWill');
    const col = db.collection('Domiciliarios');

    // Buscar por idWil (case-insensitive)
    const domi = await col.findOne({ idWil: idWil.toUpperCase().trim() });

    if (!domi) {
      return res.status(401).json({ ok: false, error: 'ID o clave incorrectos' });
    }

    if (!domi.activo) {
      return res.status(403).json({ ok: false, error: 'Tu cuenta está desactivada. Contacta a WIL.' });
    }

    // Comparar contraseña con bcrypt
    const match = await bcrypt.compare(password, domi.password);
    if (!match) {
      return res.status(401).json({ ok: false, error: 'ID o clave incorrectos' });
    }

    // ── Login exitoso ─────────────────────────────────────────────────────
    return res.status(200).json({
      ok: true,
      domi: {
        id:     domi.idWil,
        nombre: domi.nombre,
        tel:    domi.tel    || '',
        foto:   domi.foto   || '',
        activo: domi.activo,
        rol:    domi.rol    || 'domiciliario',
      }
    });

  } catch (err) {
    console.error('[domi-login] Error:', err);
    return res.status(500).json({ ok: false, error: 'Error interno del servidor' });
  } finally {
    await client.close();
  }
}