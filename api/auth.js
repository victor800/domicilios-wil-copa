import { dbConnect } from '../lib/db.js'
import Admin         from '../lib/Admin.js'
import Domiciliario  from '../lib/Domiciliario.js'
import Cliente       from '../lib/Cliente.js'
import mongoose      from 'mongoose'
import bcrypt        from 'bcryptjs'
import jwt           from 'jsonwebtoken'

/* ══ CORS ══ */
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
}

/* ══════════════════════════════════════════════════════════
   Registro de cliente
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

  /* Hash explícito — sin depender del pre-save hook */
  const hash  = await bcrypt.hash(password, 12)
  const nuevo = await Cliente.create({
    nombre:   nombre.trim(),
    email:    email.toLowerCase().trim(),
    tel:      tel.trim(),
    password: hash,
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
   Login de cliente por email
   POST /api/auth?recurso=login-cliente
══════════════════════════════════════════════════════════ */
async function loginCliente(req, res) {
  const { email, password } = req.body || {}

  if (!email || !password)
    return res.status(400).json({ error: 'Correo y contraseña son obligatorios.' })

  const cliente = await Cliente.findOne({ email: email.toLowerCase().trim() })

  if (!cliente)
    return res.status(401).json({ error: 'Correo o contraseña incorrectos.' })

  if (!cliente.activo)
    return res.status(403).json({ error: 'Cuenta inactiva. Contacta al administrador.' })

  const ok = await cliente.compararPassword(password)

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
   Eliminar cuenta de cliente
   POST /api/auth?recurso=eliminar-cliente
══════════════════════════════════════════════════════════ */
async function eliminarCliente(req, res) {
  const { email, password } = req.body || {}

  if (!email || !password)
    return res.status(400).json({ error: 'Correo y contraseña son obligatorios.' })

  const cliente = await Cliente.findOne({ email: email.toLowerCase().trim() })

  if (!cliente)
    return res.status(401).json({ error: 'Correo o contraseña incorrectos.' })

  const ok = await cliente.compararPassword(password)
  if (!ok)
    return res.status(401).json({ error: 'Correo o contraseña incorrectos.' })

  await Cliente.deleteOne({ _id: cliente._id })

  return res.status(200).json({ ok: true })
}

/* ══════════════════════════════════════════════════════════
   Verificar token de admin (la firma SÍ se valida aquí)
   POST /api/auth?recurso=verificar
   Header: Authorization: Bearer <token>
══════════════════════════════════════════════════════════ */
function verificarToken(req, res) {
  const header = req.headers.authorization || ''
  const token  = header.startsWith('Bearer ') ? header.slice(7) : ''

  if (!token || !process.env.JWT_SECRET)
    return res.status(401).json({ ok: false, error: 'Sin sesión.' })

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET)
    if (payload.rol !== 'admin')
      return res.status(403).json({ ok: false, error: 'Sin permisos de administrador.' })
    return res.status(200).json({ ok: true, id: payload.id, rol: payload.rol })
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'Sesión inválida o expirada.' })
  }
}

/* ══════════════════════════════════════════════════════════
   HANDLER PRINCIPAL
══════════════════════════════════════════════════════════ */
export default async function handler(req, res) {
  setCors(res)

  if (req.method === 'OPTIONS') return res.status(200).end()

  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Método no permitido' })

  try {
    /* No necesita base de datos: solo valida la firma del token */
    if (req.query.recurso === 'verificar')
      return verificarToken(req, res)

    await dbConnect()

    if (req.query.recurso === 'register')
      return await registerCliente(req, res)

    if (req.query.recurso === 'login-cliente')
      return await loginCliente(req, res)

    if (req.query.recurso === 'eliminar-cliente')
      return await eliminarCliente(req, res)

    /* ── Login admin / domiciliario ── */
    const { idWil, password, rol } = req.body || {}

    if (!idWil || !password || !rol)
      return res.status(400).json({ error: 'Faltan datos requeridos' })

    if (!['admin', 'domiciliario'].includes(rol))
      return res.status(400).json({ error: 'Rol inválido' })

    if (!process.env.JWT_SECRET) {
      console.error('[auth] Falta la variable de entorno JWT_SECRET')
      return res.status(500).json({ error: 'Servidor mal configurado (JWT_SECRET).' })
    }

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

    /* El rol del token sale del modelo que autenticó (admin/domiciliario),
       aunque el documento no tenga el campo "rol" guardado. */
    const rolFinal = rol === 'admin' ? 'admin' : (usuario.rol || 'domiciliario')

    return res.status(200).json({
      ok:     true,
      id:     usuario.idWil,
      nombre: usuario.nombre,
      rol:    rolFinal,
      tel:    usuario.tel  || '',
      foto:   usuario.foto || '',
      token:  jwt.sign(
        { id: usuario.idWil, rol: rolFinal },
        process.env.JWT_SECRET,
        { expiresIn: '12h' }
      ),
    })

  } catch (err) {
    console.error('[POST /api/auth]', err.message)
    return res.status(500).json({ error: 'Error interno del servidor' })
  }
}