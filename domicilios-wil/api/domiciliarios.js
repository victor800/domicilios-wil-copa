import { dbConnect }  from '../lib/db.js'
import Domiciliario   from '../lib/Domiciliario.js'

function getFotoUrl(foto) {
  if (!foto || !foto.trim()) return ''
  if (foto.startsWith('http') || foto.startsWith('data:')) return foto
  return `/icons/${foto.trim()}`
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()

  await dbConnect()

  /* ── GET /api/domiciliarios ─────────────────── */
  if (req.method === 'GET') {
    try {
      const domis = await Domiciliario
        .find({}, '-password -__v')
        .sort({ nombre: 1 })
        .lean()

      return res.status(200).json({
        ok:   true,
        data: domis.map(d => ({
          id:     d.idWil,
          nombre: d.nombre,
          tel:    d.tel    || '',
          foto:   getFotoUrl(d.foto),  // URL lista para el <img src>
          activo: d.activo !== false,
          rol:    d.rol    || 'domiciliario'
        }))
      })
    } catch (err) {
      console.error('[GET /api/domiciliarios]', err.message)
      return res.status(500).json({ ok: false, error: err.message })
    }
  }

  /* ── POST /api/domiciliarios ────────────────── */
  if (req.method === 'POST') {
    try {
      const { idWil, nombre, password, tel, zona, rol, activo, foto } = req.body

      if (!idWil || !nombre || !password)
        return res.status(400).json({ ok: false, error: 'Faltan campos obligatorios' })

      const existe = await Domiciliario.findOne({
        idWil: idWil.toUpperCase().trim()
      })
      if (existe)
        return res.status(409).json({ ok: false, error: `El ID ${idWil} ya está registrado` })

      const nuevo = await Domiciliario.create({
        idWil:    idWil.toUpperCase().trim(),
        nombre:   nombre.trim(),
        password,                          // el model debe hashear en pre-save
        tel:      tel   || '',
        zona:     zona  || '',
        rol:      rol   || 'domiciliario',
        foto:     foto  || '',             // nombre de archivo o URL
        activo:   activo === 'true' || activo === true
      })

      return res.status(201).json({
        ok:   true,
        data: {
          id:     nuevo.idWil,
          nombre: nuevo.nombre,
          foto:   getFotoUrl(nuevo.foto)
        }
      })
    } catch (err) {
      console.error('[POST /api/domiciliarios]', err.message)
      return res.status(500).json({ ok: false, error: err.message })
    }
  }

  return res.status(405).json({ ok: false, error: 'Método no permitido' })
}