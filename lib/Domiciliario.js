import mongoose from 'mongoose'

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

export default mongoose.models.Domiciliario
  || mongoose.model('Domiciliario', DomiciliarioSchema, 'Domiciliarios')