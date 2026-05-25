import mongoose     from 'mongoose'
import bcrypt       from 'bcryptjs'
import Domiciliario from '../lib/Domiciliario.js'

let cached = global._mongoose || null

async function conectar() {
  if (cached && mongoose.connection.readyState === 1) return
  cached = await mongoose.connect(process.env.MONGODB_URI)
  global._mongoose = cached
}

/**
 * Devuelve la URL correcta de la foto sin importar cómo esté guardada:
 *  - ''                          → ''              (sin foto)
 *  - 'data:image/...'            → igual            (base64 legacy)
 *  - 'http://...' / 'https://…'  → igual            (URL externa)
 *  - '/api/foto?id=...'          → igual            (URL interna ya absoluta)
 *  - 'Robinson.jpeg'             → '/icons/Robinson.jpeg' (nombre de archivo)
 */
function getFotoUrl(foto) {
  if (!foto || !foto.trim()) return ''
  const f = foto.trim()
  // Ya es una URL absoluta o ruta interna — no tocar
  if (
    f.startsWith('http')  ||
    f.startsWith('data:') ||
    f.startsWith('/')
  ) return f
  // Solo nombre de archivo → añadir prefijo icons/
  return `/icons/${f}`
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()

  try {
    await conectar()
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Error de conexión: ' + err.message })
  }

  /* ════ GET — listar domiciliarios ════ */
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
          foto:   getFotoUrl(d.foto),   // ← URL limpia para el frontend
          activo: d.activo !== false,
          rol:    d.rol  || 'domiciliario',
        }))
      })
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message })
    }
  }

  /* ════ POST — crear domiciliario ════ */
  if (req.method === 'POST') {
    try {
      const { idWil, nombre, password, tel, zona, rol, activo, foto } = req.body

      if (!idWil || !nombre || !password)
        return res.status(400).json({ ok: false, error: 'Faltan campos obligatorios' })

      if (password.length < 6)
        return res.status(400).json({ ok: false, error: 'La clave debe tener al menos 6 caracteres' })

      const existe = await Domiciliario.findOne({ idWil: idWil.toUpperCase().trim() })
      if (existe)
        return res.status(409).json({ ok: false, error: `El ID ${idWil} ya está registrado` })

      // Hashear manualmente para evitar doble-hash si el pre-save hook también existe
      const passwordHash = await bcrypt.hash(password, 12)

      // Guardar foto tal cual llega del frontend:
      //   - Si viene de /api/foto → ya es '/api/foto?id=...'  (URL corta)
      //   - Si viene vacío       → ''
      const fotoGuardar = foto ? foto.trim() : ''

      const nuevo = await Domiciliario.create({
        idWil:    idWil.toUpperCase().trim(),
        nombre:   nombre.trim(),
        password: passwordHash,
        tel:      tel  || '',
        zona:     zona || '',
        rol:      rol  || 'domiciliario',
        foto:     fotoGuardar,           // URL corta o ''
        activo:   activo === 'true' || activo === true,
      })

      return res.status(201).json({
        ok: true,
        data: {
          id:     nuevo.idWil,
          nombre: nuevo.nombre,
          tel:    nuevo.tel,
          foto:   getFotoUrl(nuevo.foto), // URL lista para el frontend
          activo: nuevo.activo,
          rol:    nuevo.rol,
        }
      })
    } catch (err) {
      console.error('[POST /api/domiciliarios]', err.message)
      return res.status(500).json({ ok: false, error: err.message })
    }
  }

  return res.status(405).json({ ok: false, error: 'Método no permitido' })
}