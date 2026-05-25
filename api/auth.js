// api/auth.js  — Vercel Serverless Function
// POST /api/auth
// Body: { idWil, password, rol }   rol = 'admin' | 'domiciliario'

import { dbConnect } from '../lib/db.js'
import Usuario       from '../lib/Usuario.js'

export default async function handler(req, res) {
  // Solo POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' })
  }

  try {
    const { idWil, password, rol } = req.body

    // ── Validaciones básicas ────────────────────────────────────────────────
    if (!idWil || !password || !rol) {
      return res.status(400).json({ error: 'Faltan datos requeridos' })
    }

    if (!['admin', 'domiciliario'].includes(rol)) {
      return res.status(400).json({ error: 'Rol inválido' })
    }

    await dbConnect()

    // ── Buscar usuario por idWil + rol ──────────────────────────────────────
    const usuario = await Usuario.findOne({
      idWil: idWil.toUpperCase().trim(),
      rol,
    })

    if (!usuario) {
      return res.status(401).json({ error: 'ID o clave incorrectos.' })
    }

    if (!usuario.activo) {
      return res.status(403).json({ error: 'Cuenta inactiva. Contacta al administrador.' })
    }

    // ── Verificar contraseña ────────────────────────────────────────────────
    const ok = await usuario.compararPassword(password)
    if (!ok) {
      return res.status(401).json({ error: 'ID o clave incorrectos.' })
    }

    // ── Actualizar último acceso ────────────────────────────────────────────
    await Usuario.findByIdAndUpdate(usuario._id, { ultimoAcceso: new Date() })

    // ── Respuesta exitosa (sin datos sensibles) ─────────────────────────────
    return res.status(200).json({
      ok:     true,
      id:     usuario.idWil,
      nombre: usuario.nombre,
      rol:    usuario.rol,
      tel:    usuario.tel  || '',
      foto:   usuario.foto || '',
    })

  } catch (err) {
    console.error('[POST /api/auth]', err.message)
    return res.status(500).json({ error: 'Error interno del servidor' })
  }
}