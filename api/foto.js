import { dbConnect } from '../lib/db.js';
import mongoose from 'mongoose';

/* ══════════════════════════════════════════════════════════════
   MODELOS
══════════════════════════════════════════════════════════════ */

/* ── Item (sub-documento) ── */
const ItemSchema = new mongoose.Schema({
  producto: String, laboratorio: String,
  cantidad: Number, precioUnit: Number, subtotal: Number,
}, { _id: false });

/* ── Pedido ── colección: pedidos ── */
const Pedido = mongoose.models.Pedido || mongoose.model('Pedido',
  new mongoose.Schema({
    creadoEn:           { type: Date, default: Date.now },
    idPedido:           String,
    estado:             { type: String, default: 'Pendiente' },
    sede:               String,
    comercio:           String,
    nombre:             String,
    telefono:           String,
    direccion:          String,
    coords:             mongoose.Schema.Types.Mixed,
    modoEntrega:        String,
    zona:               String,
    domicilio:          Number,
    metodoPago:         String,
    comprobanteId:      String,
    items:              [ItemSchema],
    subtotal:           Number,
    total:              Number,
    fecha:              String,
    hora:               String,
    destinatario:       mongoose.Schema.Types.Mixed,
    domiciliarioId:     String,
    domiciliarioNombre: String,
  }), 'pedidos'
);

/* ── Domiciliario ── colección: Domiciliarios (D mayúscula) ── */
const Domiciliario = mongoose.models.Domiciliario || mongoose.model('Domiciliario',
  new mongoose.Schema({
    idWil:        { type: String, uppercase: true, trim: true },
    nombre:       String,
    password:     String,
    rol:          { type: String, default: 'domiciliario' },
    tel:          { type: String, default: '' },
    foto:         { type: String, default: '' },
    zona:         { type: String, default: '' },
    activo:       { type: Boolean, default: true },
    ultimoAcceso: Date,
  }, { timestamps: true }),
  'Domiciliarios'
);

/* ── Foto ── colección: Fotos ── */
// El _id de la foto parece ser el mismo _id del domiciliario
// también guardamos idWil por si acaso
const Foto = mongoose.models.Foto || mongoose.model('Foto',
  new mongoose.Schema({
    data: mongoose.Schema.Types.Mixed,  // Binary / base64
    mime: String,
    ts:   Date,
  }),
  'Fotos'
);

/* ══ CORS ══ */
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    await dbConnect();
  } catch (e) {
    console.error('[foto] dbConnect falló:', e.message);
    return res.status(500).json({ ok: false, error: 'DB connection failed: ' + e.message });
  }

  const { recurso } = req.query;

  /* ════════════════════════════════════════
     GET /api/foto?recurso=pedidos
  ════════════════════════════════════════ */
  if (recurso === 'pedidos' && req.method === 'GET') {
    try {
      const { estado, domi, tipo, limit = 300 } = req.query;

      const filtro = {};
      if (estado && estado !== 'todos')
        filtro.estado = { $regex: new RegExp(`^${estado}$`, 'i') };
      if (domi)
        filtro.domiciliarioNombre = { $regex: new RegExp(domi, 'i') };
      if (tipo)
        filtro.modoEntrega = { $regex: new RegExp(tipo, 'i') };

      const pedidos = await Pedido
        .find(filtro)
        .sort({ creadoEn: -1 })
        .limit(Number(limit))
        .lean();

      return res.status(200).json({ ok: true, data: pedidos });
    } catch (e) {
      console.error('[GET pedidos]', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  /* ════════════════════════════════════════
     GET /api/foto?recurso=domiciliarios
     Trae los domiciliarios de la colección
     Domiciliarios e intenta adjuntar la foto
     de la colección Fotos buscando por _id
     del domiciliario.
     Param opcional: activo=false → todos
  ════════════════════════════════════════ */
  if (recurso === 'domiciliarios' && req.method === 'GET') {
    try {
      const soloActivos = req.query.activo !== 'false';

      const filtro = {};
      if (soloActivos) filtro.activo = true;

      const domis = await Domiciliario
        .find(filtro, { password: 0, __v: 0 })
        .sort({ nombre: 1 })
        .lean();

      // Para cada domi, intentar buscar su foto en colección Fotos
      // El _id de la foto coincide con el _id del domiciliario
      const data = await Promise.all(domis.map(async d => {
        let fotoUrl = d.foto || '';

        // Si no tiene foto en el campo directo, buscar en colección Fotos
        if (!fotoUrl) {
          try {
            const fotoDoc = await Foto.findById(d._id).lean();
            if (fotoDoc?.data) {
              // data viene como Buffer o como objeto con base64
              const b64 = fotoDoc.data?.buffer
                ? Buffer.from(fotoDoc.data.buffer).toString('base64')
                : (typeof fotoDoc.data === 'string'
                    ? fotoDoc.data
                    : Buffer.from(Object.values(fotoDoc.data)).toString('base64'));
              fotoUrl = `data:${fotoDoc.mime || 'image/jpeg'};base64,${b64}`;
            }
          } catch (_) {
            // sin foto, no pasa nada
          }
        }

        return {
          _id:          String(d._id),
          idWil:        d.idWil        || '',
          nombre:       d.nombre       || '',
          tel:          d.tel          || '',
          activo:       !!d.activo,
          foto:         fotoUrl,
          zona:         d.zona         || '',
          ultimoAcceso: d.ultimoAcceso || null,
        };
      }));

      return res.status(200).json({ ok: true, data });
    } catch (e) {
      console.error('[GET domiciliarios]', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  /* ════════════════════════════════════════
     GET /api/foto?recurso=foto&id=<_id>
     Sirve la foto de un domiciliario como
     imagen directa (para usar en <img src>)
  ════════════════════════════════════════ */
  if (recurso === 'foto' && req.method === 'GET') {
    try {
      const { id } = req.query;
      if (!id) return res.status(400).json({ ok: false, error: 'Falta id' });

      const fotoDoc = await Foto.findById(id).lean();
      if (!fotoDoc) return res.status(404).json({ ok: false, error: 'Foto no encontrada' });

      const mime = fotoDoc.mime || 'image/jpeg';
      let buf;
      if (Buffer.isBuffer(fotoDoc.data)) {
        buf = fotoDoc.data;
      } else if (fotoDoc.data?.buffer) {
        buf = Buffer.from(fotoDoc.data.buffer);
      } else {
        buf = Buffer.from(Object.values(fotoDoc.data));
      }

      res.setHeader('Content-Type', mime);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.status(200).send(buf);
    } catch (e) {
      console.error('[GET foto]', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  /* ════════════════════════════════════════
     PATCH /api/foto?recurso=asignar
     Body: { pedidoId, domiciliarioId, domiciliarioNombre }
  ════════════════════════════════════════ */
  if (recurso === 'asignar' && req.method === 'PATCH') {
    try {
      const { pedidoId, domiciliarioId, domiciliarioNombre } = req.body || {};

      if (!pedidoId || !domiciliarioId)
        return res.status(400).json({ ok: false, error: 'Faltan pedidoId o domiciliarioId' });

      const pedido = await Pedido.findOneAndUpdate(
        { idPedido: pedidoId },
        {
          estado:             'Asignado',
          domiciliarioId,
          domiciliarioNombre: domiciliarioNombre || '',
        },
        { new: true }
      );

      if (!pedido)
        return res.status(404).json({ ok: false, error: 'Pedido no encontrado: ' + pedidoId });

      return res.status(200).json({ ok: true, data: pedido });
    } catch (e) {
      console.error('[PATCH asignar]', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  /* ════════════════════════════════════════
     PATCH /api/foto?recurso=estado
     Body: { pedidoId, estado }
  ════════════════════════════════════════ */
  if (recurso === 'estado' && req.method === 'PATCH') {
    try {
      const { pedidoId, estado } = req.body || {};

      if (!pedidoId || !estado)
        return res.status(400).json({ ok: false, error: 'Faltan pedidoId o estado' });

      const pedido = await Pedido.findOneAndUpdate(
        { idPedido: pedidoId },
        { estado },
        { new: true }
      );

      if (!pedido)
        return res.status(404).json({ ok: false, error: 'Pedido no encontrado: ' + pedidoId });

      return res.status(200).json({ ok: true, data: pedido });
    } catch (e) {
      console.error('[PATCH estado]', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  /* ════════════════════════════════════════
     Recurso no reconocido
  ════════════════════════════════════════ */
  return res.status(400).json({
    ok: false,
    error: `Recurso no válido: "${recurso}". Usa: pedidos | domiciliarios | asignar | estado | foto`,
  });
}