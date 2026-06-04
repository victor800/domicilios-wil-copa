import mongoose from 'mongoose'
import bcrypt   from 'bcryptjs'

const ClienteSchema = new mongoose.Schema(
  {
    nombre:       { type: String, required: true, trim: true },
    email:        { type: String, required: true, unique: true, lowercase: true, trim: true },
    tel:          { type: String, default: '' },
    password:     { type: String, required: true },
    rol:          { type: String, default: 'cliente' },
    activo:       { type: Boolean, default: true },
    ultimoAcceso: { type: Date },
  },
  { timestamps: true }
)

/* Sin pre-save hook — el hash se hace en el handler */
ClienteSchema.methods.compararPassword = function (plain) {
  return bcrypt.compare(plain, this.password)
}

export default mongoose.models.Cliente
  || mongoose.model('Cliente', ClienteSchema, 'clientes')