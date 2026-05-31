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
const Foto = mongoose.models.Foto || mongoose.model('Foto',
  new mongoose.Schema({
    data: mongoose.Schema.Types.Mixed,
    mime: String,
    ts:   Date,
  }),
  'Fotos'
);

/* ══ CORS ══ */
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
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

      const data = await Promise.all(domis.map(async d => {
        let fotoUrl = d.foto || '';

        if (!fotoUrl) {
          try {
            const fotoDoc = await Foto.findById(d._id).lean();
            if (fotoDoc?.data) {
              const b64 = fotoDoc.data?.buffer
                ? Buffer.from(fotoDoc.data.buffer).toString('base64')
                : (typeof fotoDoc.data === 'string'
                    ? fotoDoc.data
                    : Buffer.from(Object.values(fotoDoc.data)).toString('base64'));
              fotoUrl = `data:${fotoDoc.mime || 'image/jpeg'};base64,${b64}`;
            }
          } catch (_) {}
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
     POST /api/foto?recurso=domiciliarios
     Body: { idWil, nombre, password, tel, zona, foto, activo }
  ════════════════════════════════════════ */
  if (recurso === 'domiciliarios' && req.method === 'POST') {
    try {
      const { idWil, nombre, password, tel, zona, foto, activo } = req.body || {};

      if (!idWil || !nombre || !password)
        return res.status(400).json({ ok: false, error: 'Faltan campos requeridos: idWil, nombre, password' });

      const bcrypt = await import('bcryptjs');
      const hash   = await bcrypt.default.hash(password, 12);

      const nuevo = await Domiciliario.create({
        idWil:    idWil.toUpperCase().trim(),
        nombre:   nombre.trim(),
        password: hash,
        tel:      tel    || '',
        zona:     zona   || '',
        foto:     foto   || '',
        activo:   activo !== false,
        rol:      'domiciliario',
      });

      return res.status(201).json({
        ok:   true,
        data: {
          _id:    String(nuevo._id),
          idWil:  nuevo.idWil,
          nombre: nuevo.nombre,
          tel:    nuevo.tel,
          zona:   nuevo.zona,
          activo: nuevo.activo,
        }
      });
    } catch (e) {
      if (e.code === 11000)
        return res.status(409).json({ ok: false, error: 'Ya existe un domiciliario con ese ID.' });
      console.error('[POST domiciliarios]', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  /* ════════════════════════════════════════
     GET /api/foto?recurso=foto&id=<_id>
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