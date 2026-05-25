import mongoose from 'mongoose'

const FotoSchema = new mongoose.Schema({ data: String, mime: String })
const Foto = mongoose.models.Foto || mongoose.model('Foto', FotoSchema, 'Fotos')

let cached = global._mongoose || null
async function conectar() {
  if (cached && mongoose.connection.readyState === 1) return
  cached = await mongoose.connect(process.env.MONGODB_URI)
  global._mongoose = cached
}

export default async function handler(req, res) {
  await conectar()

  // POST → guarda foto, devuelve URL corta
  if (req.method === 'POST') {
    const { base64, mime } = req.body
    const doc = await Foto.create({ data: base64, mime: mime || 'image/jpeg' })
    return res.json({ ok: true, url: `/api/foto?id=${doc._id}` })
  }

  // GET → sirve la imagen
  if (req.method === 'GET') {
    const doc = await Foto.findById(req.query.id).lean()
    if (!doc) return res.status(404).end()
    const buf = Buffer.from(doc.data, 'base64')
    res.setHeader('Content-Type', doc.mime)
    res.setHeader('Cache-Control', 'public,max-age=31536000')
    return res.send(buf)
  }
}