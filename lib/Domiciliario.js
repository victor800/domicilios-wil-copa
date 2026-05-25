import mongoose from 'mongoose'
import bcrypt   from 'bcryptjs'

const DomiciliarioSchema = new mongoose.Schema(
  {
    idWil:    { type: String, required: true, unique: true, uppercase: true, trim: true },
    nombre:   { type: String, required: true, trim: true },
    password: { type: String, required: true },
    rol:      { type: String, default: 'domiciliario' },
    tel:      { type: String, default: '' },
    foto:     { type: String, default: '' },
    zona:     { type: String, default: '' },      // ← extra útil para domi
    activo:   { type: Boolean, default: true },
    ultimoAcceso: { type: Date },
  },
  { timestamps: true }
)

DomiciliarioSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next()
  this.password = await bcrypt.hash(this.password, 12)
  next()
})

DomiciliarioSchema.methods.compararPassword = function (plain) {
  return bcrypt.compare(plain, this.password)
}

export default mongoose.models.Domiciliario
  || mongoose.model('Domiciliario', DomiciliarioSchema, 'Domiciliarios')