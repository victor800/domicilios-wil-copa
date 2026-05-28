// api/foto.js
import { dbConnect } from '../lib/db.js';
import mongoose      from 'mongoose';

/* ══ SCHEMA: Fotos ══ */
const FotoSchema = new mongoose.Schema({
  data: Buffer,
  mime: { type: String, default: 'image/jpeg' },
  ts:   { type: Date,   default: Date.now }
});
const Foto = mongoose.models.Foto || mongoose.model('Foto', FotoSchema, 'Fotos');

/* ══ SCHEMA: Pedidos ══ */
const ItemSchema = new mongoose.Schema({
  producto:    String,
  laboratorio: String,
  cantidad:    Number,
  precioUnit:  Number,
  subtotal:    Number,
}, { _id: false });

const PedidoSchema = new mongoose.Schema({
  creadoEn:      { type: Date,   default: Date.now },
  idPedido:      String,
  estado:        { type: String, default: 'Pendiente' },
  sede:          String,
  comercio:      String,
  nombre:        String,
  telefono:      String,
  direccion:     String,
  coords:        mongoose.Schema.Types.Mixed,
  modoEntrega:   String,
  zona:          String,
  domicilio:     Number,
  metodoPago:    String,
  comprobanteId: String,   // ObjectId de Foto (si pagó con transferencia)
  items:         [ItemSchema],
  subtotal:      Number,
  total:         Number,
  fecha:         String,
  hora:          String,
  destinatario:  mongoose.Schema.Types.Mixed,
});
const Pedido = mongoose.models.Pedido || mongoose.model('Pedido', PedidoSchema, 'pedidos');

/* ══ CONFIG ══ */
export const config = {
  api: { bodyParser: { sizeLimit: '5mb' } }
};

/* ══ CORS helper ══ */
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

/* ══ HANDLER ══ */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  await dbConnect();

  const { tipo } = req.query;   // ?tipo=pedido  →  lógica de pedido
                                 // sin tipo      →  lógica de foto (original)

  /* ────────────────────────────────────────────────────────────
     PEDIDO  →  POST /api/foto?tipo=pedido
  ──────────────────────────────────────────────────────────── */
  if (tipo === 'pedido') {
    if (req.method !== 'POST')
      return res.status(405).json({ ok: false, error: 'Método no permitido' });

    try {
      const body = req.body;

      if (!body?.nombre || !body?.telefono)
        return res.status(400).json({ ok: false, error: 'Faltan nombre o telefono' });

      // Si viene comprobante base64 → guardarlo como Foto y guardar solo el id
      let comprobanteId = null;
      if (body.comprobanteBase64) {
        const b64   = body.comprobanteBase64.split(',').pop(); // quitar prefijo data:...
        const mime  = (body.comprobanteBase64.match(/data:(image\/\w+);/) || [])[1] || 'image/jpeg';
        const buf   = Buffer.from(b64, 'base64');
        const foto  = await Foto.create({ data: buf, mime });
        comprobanteId = String(foto._id);
      }

      const doc = await Pedido.create({
        idPedido:    body.id       || String(Math.floor(100 + Math.random() * 900)),
        sede:        body.sede     || 'expertos',
        comercio:    body.comercio || 'Farma Expertos',
        nombre:      body.nombre,
        telefono:    body.telefono,
        direccion:   body.direccion   || '',
        coords:      body.coords      || null,
        modoEntrega: body.modoEntrega || 'DOMICILIO',
        zona:        body.zona        || '',
        domicilio:   body.domicilio   || 0,
        metodoPago:  body.metodoPago  || '',
        comprobanteId,
        items: (body.rows || [])
          .filter(r => r[6])
          .map(r => ({
            producto:    r[6]  || '',
            laboratorio: r[7]  || '',
            cantidad:    r[8]  || 1,
            precioUnit:  r[9]  || 0,
            subtotal:    r[10] || 0,
          })),
        subtotal:    (body.total || 0) - (body.domicilio || 0),
        total:       body.total    || 0,
        fecha:       body.fecha    || '',
        hora:        body.hora     || '',
        destinatario: body.destinatario || null,
      });

      return res.status(200).json({ ok: true, id: doc.idPedido, mongoId: doc._id });

    } catch(e) {
      console.error('[pedido]', e);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  /* ────────────────────────────────────────────────────────────
     FOTO ORIGINAL  →  GET /api/foto?id=<objectId>
                        POST /api/foto  { base64, mime }
  ──────────────────────────────────────────────────────────── */
  if (req.method === 'GET') {
    const { id } = req.query;
    if (!id) return res.status(400).end('Missing id');
    try {
      const foto = await Foto.findById(id);
      if (!foto) return res.status(404).end('Not found');
      res.setHeader('Content-Type',  foto.mime || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.status(200).send(foto.data);
    } catch(e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  if (req.method === 'POST') {
    const { base64, mime = 'image/jpeg' } = req.body;
    if (!base64) return res.status(400).json({ ok: false, error: 'No image data' });
    try {
      const buffer = Buffer.from(base64, 'base64');
      if (buffer.length > 5 * 1024 * 1024)
        return res.status(400).json({ ok: false, error: 'Imagen demasiado grande (máx 5MB)' });
      const doc = await Foto.create({ data: buffer, mime });
      return res.status(200).json({ ok: true, url: `/api/foto?id=${doc._id}` });
    } catch(e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  res.status(405).end();
}