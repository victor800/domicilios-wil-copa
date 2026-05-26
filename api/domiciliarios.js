// api/domiciliarios.js
import { dbConnect } from '../lib/db.js'
import Domiciliario  from '../lib/Domiciliario.js'

function getFotoUrl(foto) {
  if (!foto || !foto.trim()) return ''
  const f = foto.trim()
  if (f.startsWith('http') || f.startsWith('data:') || f.startsWith('/')) return f
  return `/icons/${f}`
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()

  await dbConnect()

  /* ── GET /api/domiciliarios ── */
  if (req.method === 'GET') {
    try {
      const domis = await Domiciliario
        .find({}, '-password -__v')
        .sort({ nombre: 1 })
        .lean()

      return res.status(200).json({
        ok: true,
        data: domis.map(d => ({
          id:     d.idWil,
          nombre: d.nombre,
          tel:    d.tel  || '',
          foto:   getFotoUrl(d.foto),
          activo: d.activo !== false,
          rol:    d.rol  || 'domiciliario',
        }))
      })
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message })
    }
  }

  /* ── POST /api/domiciliarios ── */
  if (req.method === 'POST') {
    try {
      const { idWil, nombre, password, tel, zona, rol, activo, foto } = req.body

      if (!idWil || !nombre || !password)
        return res.status(400).json({ ok: false, error: 'Faltan campos obligatorios' })

      if (password.length < 6)
        return res.status(400).json({ ok: false, error: 'Clave mínimo 6 caracteres' })

      const existe = await Domiciliario.findOne({ idWil: idWil.toUpperCase().trim() })
      if (existe)
        return res.status(409).json({ ok: false, error: `${idWil} ya está registrado` })

      // ⚠️ NO hashear aquí — el hook pre('save') en Domiciliario.js lo hace solo
      // foto llega como '/api/foto?id=<objectId>' — URL corta, nunca base64
      const nuevo = new Domiciliario({
        idWil:    idWil.toUpperCase().trim(),
        nombre:   nombre.trim(),
        password,                              // sin hashear — el hook lo hace
        tel:      tel  || '',
        zona:     zona || '',
        rol:      rol  || 'domiciliario',
        foto:     foto ? foto.trim() : '',     // URL corta o ''
        activo:   activo === 'true' || activo === true,
      })

      await nuevo.save()                       // dispara el hook pre('save')

      return res.status(201).json({
        ok: true,
        data: {
          id:     nuevo.idWil,
          nombre: nuevo.nombre,
          tel:    nuevo.tel,
          foto:   getFotoUrl(nuevo.foto),
          activo: nuevo.activo,
          rol:    nuevo.rol,
        }
      })
    } catch (err) {
      console.error('[POST /api/domiciliarios]', err.message, err.stack)
      return res.status(500).json({ ok: false, error: err.message })
    }
  }

  return res.status(405).json({ ok: false, error: 'Método no permitido' })
}