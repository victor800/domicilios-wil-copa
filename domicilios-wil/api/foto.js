// pages/api/foto.js
import { dbConnect } from '../lib/db.js';
import mongoose      from 'mongoose';

// Modelo liviano solo para guardar la imagen como Buffer
const FotoSchema = new mongoose.Schema({
  data: Buffer,
  mime: { type: String, default: 'image/jpeg' },
  ts:   { type: Date,   default: Date.now }
});
const Foto = mongoose.models.Foto || mongoose.model('Foto', FotoSchema, 'Fotos');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  await dbConnect();

  /* ── GET /api/foto?id=<objectId> → devuelve la imagen ── */
  if (req.method === 'GET') {
    const { id } = req.query;
    if (!id) return res.status(400).end('Missing id');
    try {
      const foto = await Foto.findById(id).lean();
      if (!foto) return res.status(404).end('Not found');
      res.setHeader('Content-Type',  foto.mime || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.status(200).send(foto.data);
    } catch(e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  /* ── POST /api/foto { base64, mime } → guarda y devuelve URL corta ── */
  if (req.method === 'POST') {
    const { base64, mime = 'image/jpeg' } = req.body;
    if (!base64) return res.status(400).json({ ok: false, error: 'No image data' });
    try {
      const buffer = Buffer.from(base64, 'base64');
      if (buffer.length > 5 * 1024 * 1024)   // límite 5 MB
        return res.status(400).json({ ok: false, error: 'Imagen demasiado grande (máx 5MB)' });
      const doc = await Foto.create({ data: buffer, mime });
      return res.status(200).json({ ok: true, url: `/api/foto?id=${doc._id}` });
    } catch(e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  res.status(405).end();
}