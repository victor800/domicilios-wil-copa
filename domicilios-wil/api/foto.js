// api/foto.js
import { MongoClient, ObjectId } from 'mongodb'

const client = new MongoClient(process.env.MONGODB_URI)

async function getDb() {
  if (!client.topology?.isConnected()) await client.connect()
  return client.db().collection('fotos')
}

export default async function handler(req, res) {

  /* ── GET /api/foto?id=abc  →  sirve la imagen ── */
  if (req.method === 'GET') {
    const { id } = req.query
    if (!id) return res.status(400).end('Falta id')

    try {
      const col  = await getDb()
      const doc  = await col.findOne({ _id: new ObjectId(id) })
      if (!doc) return res.status(404).end('No encontrada')

      res.setHeader('Content-Type', doc.mime)
      res.setHeader('Cache-Control', 'public, max-age=31536000')
      return res.send(Buffer.from(doc.data, 'base64'))
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message })
    }
  }

  /* ── POST /api/foto  { base64, mime }  →  { ok, url } ── */
  if (req.method === 'POST') {
    const { base64, mime } = req.body ?? {}
    if (!base64 || !mime) return res.status(400).json({ ok: false, error: 'Faltan campos' })

    try {
      const col    = await getDb()
      const result = await col.insertOne({ data: base64, mime, ts: new Date() })
      return res.json({ ok: true, url: `/api/foto?id=${result.insertedId}` })
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message })
    }
  }

  res.status(405).end()
}