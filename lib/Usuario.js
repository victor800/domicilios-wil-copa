// lib/Usuario.js
import mongoose from 'mongoose'
import bcrypt   from 'bcryptjs'

const UsuarioSchema = new mongoose.Schema(
  {
    // Identificador visible (ej: WIL-009 para domi, o email para admin)
    idWil:    { type: String, required: true, unique: true, uppercase: true, trim: true },

    nombre:   { type: String, required: true, trim: true },
    password: { type: String, required: true },

    // 'admin' | 'domiciliario'
    rol:      { type: String, enum: ['admin', 'domiciliario'], required: true },

    // Solo domiciliarios
    tel:      { type: String, default: '' },
    foto:     { type: String, default: '' },   // URL foto de perfil

    activo:   { type: Boolean, default: true },
    ultimoAcceso: { type: Date },
  },
  { timestamps: true }
)

// Hash automático al guardar / modificar password
UsuarioSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next()
  this.password = await bcrypt.hash(this.password, 12)
  next()
})

// Comparar contraseña
UsuarioSchema.methods.compararPassword = function (plain) {
  return bcrypt.compare(plain, this.password)
}

export default mongoose.models.Usuario
  || mongoose.model('Usuario', UsuarioSchema, 'users')