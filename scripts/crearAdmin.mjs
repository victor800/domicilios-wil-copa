// scripts/crearAdmin.mjs
// Ejecutar: node scripts/crearAdmin.mjs
import dotenv from 'dotenv'
dotenv.config()

import mongoose from 'mongoose'
import bcrypt   from 'bcryptjs'

const URI = process.env.MONGODB_URI

if (!URI) {
  console.error('❌ MONGODB_URI no definida en .env')
  process.exit(1)
}

await mongoose.connect(URI)
console.log('✅ Conectado a MongoDB')

const UsuarioSchema = new mongoose.Schema({
  idWil:        { type: String, required: true, unique: true, uppercase: true, trim: true },
  nombre:       { type: String, required: true },
  password:     { type: String, required: true },
  rol:          { type: String, enum: ['admin', 'domiciliario'] },
  tel:          String,
  foto:         String,
  activo:       { type: Boolean, default: true },
  ultimoAcceso: Date,
}, { timestamps: true })

const Usuario = mongoose.models.Usuario
  || mongoose.model('Usuario', UsuarioSchema, 'users')

const hash = await bcrypt.hash('Admin2026', 12)

await Usuario.findOneAndUpdate(
  { idWil: 'WIL-ADMIN' },
  { idWil: 'WIL-ADMIN', nombre: 'Administrador WIL', password: hash, rol: 'admin', activo: true },
  { upsert: true, new: true }
)

console.log('✅ Admin creado:')
console.log('   ID:       WIL-ADMIN')
console.log('   Password: Admin2026')
console.log('   Rol:      admin')

await mongoose.disconnect()
console.log('🔌 Listo.')
