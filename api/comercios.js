// api/comercios.js  — Vercel Serverless Function
// Ruta pública: GET https://tu-dominio.vercel.app/api/comercios
// Devuelve solo los campos necesarios de comercios con status "activo"

import mongoose from 'mongoose'

// ── Conexión reutilizable (Vercel reutiliza instancias calientes) ──
let cached = global._mongoConn

async function connectDB() {
  if (cached?.conn) return cached.conn

  if (!cached) {
    cached = global._mongoConn = { conn: null, promise: null }
  }

  if (!cached.promise) {
    cached.promise = mongoose
      .connect(process.env.MONGODB_URI, {
        dbName: process.env.MONGODB_DB || undefined,
        bufferCommands: false,
      })
      .then(m => m)
  }

  cached.conn = await cached.promise
  return cached.conn
}

// ── Schema mínimo (solo los campos que necesita el HTML) ──
const ComercioSchema = new mongoose.Schema({
  nombre:   String,
  telefono: String,
  status:   String,
  config: {
    image:   String,
    phone:   String,
    address: String,
  },
}, { strict: false })

const Comercio =
  mongoose.models.Comercio || mongoose.model('Comercio', ComercioSchema)

// ── Handler ──
export default async function handler(req, res) {
  // CORS: permite que tu HTML (cualquier origen) consuma este endpoint
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' })

  try {
    await connectDB()

    const comercios = await Comercio
      .find({ status: 'activo' })
      .select('nombre telefono config.image config.phone config.address')
      .lean()

    return res.status(200).json(comercios)

  } catch (err) {
    console.error('[/api/comercios]', err)
    return res.status(500).json({ error: 'Error al consultar la base de datos' })
  }
}