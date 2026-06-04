import { dbConnect } from '../lib/db.js'
import Admin         from '../lib/Admin.js'
import Domiciliario  from '../lib/Domiciliario.js'
import Cliente       from '../lib/Cliente.js'       // ← NUEVO
import mongoose      from 'mongoose'

/* ══════════════════════════════════════════════════════════
   NUEVO — Registro de cliente
   POST /api/auth?recurso=register
══════════════════════════════════════════════════════════ */
async function registerCliente(req, res) {
  const { nombre, email, tel = '', password } = req.body || {}

  if (!nombre || !email || !password)
    return res.status(400).json({ error: 'Faltan campos: nombre, email, password.' })

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'El correo no es válido.' })

  if (password.length < 8)
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' })

  const existe = await Cliente.findOne({ email: email.toLowerCase().trim() }).lean()
  if (existe)
    return res.status(409).json({ error: 'Ya existe una cuenta con ese correo.' })

  // El pre-save hook hashea el password automáticamente
  const nuevo = await Cliente.create({
    nombre:   nombre.trim(),
    email:    email.toLowerCase().trim(),
    tel:      tel.trim(),
    password,
  })

  return res.status(201).json({
    ok:     true,
    nombre: nuevo.nombre,
    email:  nuevo.email,
    tel:    nuevo.tel,
    rol:    nuevo.rol,
  })
}

/* ══════════════════════════════════════════════════════════
   NUEVO — Login de cliente por email
   POST /api/auth?recurso=login-cliente
══════════════════════════════════════════════════════════ */
async function loginCliente(req, res) {
  const { email, password } = req.body || {}

  if (!email || !password)
    return res.status(400).json({ error: 'Correo y contraseña son obligatorios.' })

  console.log('[auth-cliente] email recibido:', email.toLowerCase().trim())

  const cliente = await Cliente.findOne({ email: email.toLowerCase().trim() })

  console.log('[auth-cliente] encontrado:', cliente ? cliente.email : 'NO ENCONTRADO')

  if (!cliente)
    return res.status(401).json({ error: 'Correo o contraseña incorrectos.' })

  if (!cliente.activo)
    return res.status(403).json({ error: 'Cuenta inactiva. Contacta al administrador.' })

  const ok = await cliente.compararPassword(password)
  console.log('[auth-cliente] password ok:', ok)

  if (!ok)
    return res.status(401).json({ error: 'Correo o contraseña incorrectos.' })

  await Cliente.findByIdAndUpdate(cliente._id, { ultimoAcceso: new Date() })

  return res.status(200).json({
    ok:     true,
    nombre: cliente.nombre,
    email:  cliente.email,
    rol:    cliente.rol,
    tel:    cliente.tel || '',
  })
}

/* ══════════════════════════════════════════════════════════
   HANDLER PRINCIPAL — lógica original intacta
══════════════════════════════════════════════════════════ */
export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Método no permitido' })

  try {
    await dbConnect()

    /* ── NUEVOS: registro y login de cliente ── */
    if (req.query.recurso === 'register')
      return await registerCliente(req, res)

    if (req.query.recurso === 'login-cliente')
      return await loginCliente(req, res)

    /* ── ORIGINAL: login admin / domiciliario (sin cambios) ── */
    const { idWil, password, rol } = req.body

    if (!idWil || !password || !rol)
      return res.status(400).json({ error: 'Faltan datos requeridos' })

    if (!['admin', 'domiciliario'].includes(rol))
      return res.status(400).json({ error: 'Rol inválido' })

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