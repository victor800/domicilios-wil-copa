// scripts/crearAdmins.mjs
import dotenv from 'dotenv'
dotenv.config()

process.env.MONGODB_URI = process.env.MONGODB_URI?.replace('/test?', '/AppWill?').replace('/?', '/AppWill?')
console.log('BD detectada:', process.env.MONGODB_URI?.split('/').pop()?.split('?')[0])

import mongoose from 'mongoose'
import bcrypt from 'bcryptjs'

const URI = process.env.MONGODB_URI
console.log('🔗 URI:', URI) // ← verificamos que tenga AppWill

await mongoose.connect(URI)
console.log('✅ Conectado a:', mongoose.connection.db.databaseName)

const AdminSchema = new mongoose.Schema({
  idWil:        { type: String, required: true, unique: true, uppercase: true, trim: true },
  nombre:       { type: String, required: true, trim: true },
  password:     { type: String, required: true },
  rol:          { type: String, default: 'admin' },
  activo:       { type: Boolean, default: true },
  ultimoAcceso: { type: Date },
}, { timestamps: true })

const Admin = mongoose.models.Admin
  || mongoose.model('Admin', AdminSchema, 'Administrador')

const admins = [
  { idWil: 'WIL-001',    nombre: 'Wil',    password: 'Wil2026'    },
  { idWil: 'RHM', nombre: 'Hernán', password: 'RHM2021' },
]

for (const a of admins) {
  const hash = await bcrypt.hash(a.password, 12)
  const doc = await Admin.findOneAndUpdate(
    { idWil: a.idWil },
    { ...a, password: hash, rol: 'admin', activo: true },
    { upsert: true, new: true }
  )
  console.log(`✅ ${a.nombre} → ${doc.idWil} en BD: ${mongoose.connection.db.databaseName}`)
}

await mongoose.disconnect()
console.log('🔌 Listo.')