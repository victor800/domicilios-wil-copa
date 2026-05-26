// pages/api/domi-login.js
import { dbConnect }  from '../lib/db.js'
import Domiciliario   from '../lib/Domiciliario.js'

// ─── Construye la URL de la foto ─────────────────────────────────────────────
// Si el doc tiene foto en BD  →  /icons/Robinson.jpeg
// Si no tiene foto            →  '' (el frontend mostrará iniciales)
function getFotoUrl(domi) {
  return (domi.foto || '').trim()
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()

  if (req.method !== 'POST')
    return res.status(405).json({ ok: false, error: 'Método no permitido' })

  try {
    const { idWil, password } = req.body

    if (!idWil || !password)
      return res.status(400).json({ ok: false, error: 'ID y contraseña son requeridos' })

    await dbConnect()

    const domi = await Domiciliario.findOne({ idWil: idWil.toUpperCase().trim() })

    if (!domi)
      return res.status(401).json({ ok: false, error: 'ID o clave incorrectos.' })

    if (!domi.activo)
      return res.status(403).json({ ok: false, error: 'Cuenta inactiva. Contacta al administrador.' })

    const ok = await domi.compararPassword(password)

    if (!ok)
      return res.status(401).json({ ok: false, error: 'ID o clave incorrectos.' })

    await Domiciliario.findByIdAndUpdate(domi._id, { ultimoAcceso: new Date() })

    return res.status(200).json({
      ok:   true,
      domi: {
        id:     domi.idWil,
        nombre: domi.nombre,
        tel:    domi.tel    || '',
        foto:   getFotoUrl(domi),   // ← /icons/Robinson.jpeg  o  ''
        activo: domi.activo,
        rol:    domi.rol    || 'domiciliario',
      }
    })

  } catch (err) {
    console.error('[POST /api/domi-login]', err.message)
    return res.status(500).json({ ok: false, error: 'Error interno del servidor' })
  }
}