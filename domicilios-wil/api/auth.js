import { dbConnect } from '../lib/db.js'
import Admin         from '../lib/Admin.js'
import Domiciliario  from '../lib/Domiciliario.js'
import mongoose      from 'mongoose'

export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Método no permitido' })

  try {
    const { idWil, password, rol } = req.body

    if (!idWil || !password || !rol)
      return res.status(400).json({ error: 'Faltan datos requeridos' })

    if (!['admin', 'domiciliario'].includes(rol))
      return res.status(400).json({ error: 'Rol inválido' })

    await dbConnect()

    console.log('[auth] BD conectada:', mongoose.connection.db.databaseName)
    console.log('[auth] idWil recibido:', idWil.toUpperCase().trim())
    console.log('[auth] rol recibido:', rol)

    const Modelo  = rol === 'admin' ? Admin : Domiciliario
    const usuario = await Modelo.findOne({ idWil: idWil.toUpperCase().trim() })

    console.log('[auth] usuario encontrado:', usuario ? usuario.idWil : 'NO ENCONTRADO')

    if (!usuario)
      return res.status(401).json({ error: 'ID o clave incorrectos.' })

    if (!usuario.activo)
      return res.status(403).json({ error: 'Cuenta inactiva. Contacta al administrador.' })

    const ok = await usuario.compararPassword(password)
    console.log('[auth] password ok:', ok)

    if (!ok)
      return res.status(401).json({ error: 'ID o clave incorrectos.' })

    await Modelo.findByIdAndUpdate(usuario._id, { ultimoAcceso: new Date() })

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