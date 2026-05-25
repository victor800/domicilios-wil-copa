import mongoose from 'mongoose'
import bcrypt   from 'bcryptjs'

const AdminSchema = new mongoose.Schema(
  {
    idWil:    { type: String, required: true, unique: true, uppercase: true, trim: true },
    nombre:   { type: String, required: true, trim: true },
    password: { type: String, required: true },
    rol:      { type: String, default: 'admin' },
    activo:   { type: Boolean, default: true },
    ultimoAcceso: { type: Date },
  },
  { timestamps: true }
)

AdminSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next()
  this.password = await bcrypt.hash(this.password, 12)
  next()
})

AdminSchema.methods.compararPassword = function (plain) {
  return bcrypt.compare(plain, this.password)
}

export default mongoose.models.Admin
  || mongoose.model('Admin', AdminSchema, 'Administrador')
