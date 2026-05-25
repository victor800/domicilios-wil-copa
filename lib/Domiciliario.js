import mongoose from 'mongoose'
import bcrypt   from 'bcryptjs'          // ← asegúrate de tener bcryptjs instalado

const DomiciliarioSchema = new mongoose.Schema(
  {
    idWil:        { type: String, required: true, unique: true, uppercase: true, trim: true },
    nombre:       { type: String, required: true, trim: true },
    password:     { type: String, required: true },
    rol:          { type: String, default: 'domiciliario' },
    tel:          { type: String, default: '' },
    foto:         { type: String, default: '' },
    zona:         { type: String, default: '' },
    activo:       { type: Boolean, default: true },
    ultimoAcceso: { type: Date },
  },
  { timestamps: true }
)

// ── Hash automático antes de guardar ─────────────────────────────────────────
DomiciliarioSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next()
  this.password = await bcrypt.hash(this.password, 12)
  next()
})

// ── Método de instancia para comparar contraseña ──────────────────────────────
DomiciliarioSchema.methods.compararPassword = async function (candidato) {
  return bcrypt.compare(candidato, this.password)
}

export default mongoose.models.Domiciliario
  || mongoose.model('Domiciliario', DomiciliarioSchema, 'Domiciliarios')