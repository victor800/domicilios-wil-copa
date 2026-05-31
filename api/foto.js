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
    horaToma:           { type: String, default: '' },
    /* ── Tracker GPS del domiciliario ── */
    domiCoords: {
      lat:           { type: Number, default: null },
      lng:           { type: Number, default: null },
      actualizadoEn: { type: Date,   default: null },
    },
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
    /* ── Ubicación en tiempo real ── */
    ubicacion: {
      lat:           { type: Number, default: null },
      lng:           { type: Number, default: null },
      actualizadoEn: { type: Date,   default: null },
    },
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
   HELPER — resuelve idWil a partir de un valor que puede ser
   idWil ("WIL-001") o _id de Mongo ("6a1482a7…").
   Siempre devuelve el idWil en mayúsculas, o null si no existe.
══════════════════════════════════════════════════════════════ */
async function resolverIdWil(valor) {
  if (!valor) return null;

  if (/^[a-f\d]{24}$/i.test(valor)) {
    const doc = await Domiciliario.findById(valor, { idWil: 1 }).lean();
    return doc?.idWil ?? null;
  }

  return valor.toUpperCase().trim();
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
     POST /api/foto?recurso=pedidos
     ⚠️ Debe ir ANTES del GET para que no lo intercepte
  ════════════════════════════════════════ */
  if (recurso === 'pedidos' && req.method === 'POST') {
    try {
      const body = req.body || {};

      if (!body.idPedido)
        return res.status(400).json({ ok: false, error: 'Falta idPedido en el body' });

      const nuevo = await Pedido.create(body);
      return res.status(201).json({ ok: true, data: nuevo });

    } catch (e) {
      if (e.code === 11000)
        return res.status(409).json({ ok: false, error: 'Pedido duplicado: ' + e.message });
      console.error('[POST pedidos]', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  /* ════════════════════════════════════════
     GET /api/foto?recurso=pedidos
  ════════════════════════════════════════ */
  if (recurso === 'pedidos' && req.method === 'GET') {
    try {
      const { estado, domi, domiId, tipo, limit = 300 } = req.query;

      const filtro = {};
      if (estado && estado !== 'todos') {
        const estadoList = estado.split(',').map(s => s.trim()).filter(Boolean);
        filtro.estado = estadoList.length === 1
          ? { $regex: new RegExp(`^${estadoList[0]}$`, 'i') }
          : { $in: estadoList.map(s => new RegExp(`^${s}$`, 'i')) };
      }
      if (domi)
        filtro.domiciliarioNombre = { $regex: new RegExp(domi, 'i') };
      if (domiId) {
        const idWilResuelto = await resolverIdWil(domiId);
        filtro.domiciliarioId = idWilResuelto ?? domiId;
      }
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
          ubicacion:    d.ubicacion    || null,
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
  ════════════════════════════════════════ */
  if (recurso === 'asignar' && req.method === 'PATCH') {
    try {
      const { pedidoId, domiciliarioId, domiciliarioNombre } = req.body || {};

      if (!pedidoId || !domiciliarioId)
        return res.status(400).json({ ok: false, error: 'Faltan pedidoId o domiciliarioId' });

      const idWilResuelto = await resolverIdWil(domiciliarioId);
      if (!idWilResuelto)
        return res.status(404).json({ ok: false, error: 'Domiciliario no encontrado: ' + domiciliarioId });

      let nombreFinal = domiciliarioNombre || '';
      if (!nombreFinal) {
        const doc = await Domiciliario.findOne({ idWil: idWilResuelto }, { nombre: 1 }).lean();
        nombreFinal = doc?.nombre ?? '';
      }

      const pedido = await Pedido.findOneAndUpdate(
        { idPedido: pedidoId },
        {
          estado:             'Asignado',
          domiciliarioId:     idWilResuelto,
          domiciliarioNombre: nombreFinal,
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
  ════════════════════════════════════════ */
  if (recurso === 'estado' && req.method === 'PATCH') {
    try {
      const { pedidoId, estado, domiciliarioId, domiciliarioNombre, horaToma } = req.body || {};

      if (!pedidoId || !estado)
        return res.status(400).json({ ok: false, error: 'Faltan pedidoId o estado' });

      const update = { estado };

      if (horaToma) update.horaToma = horaToma;

      if (domiciliarioId) {
        const idWilResuelto = await resolverIdWil(domiciliarioId);
        update.domiciliarioId = idWilResuelto ?? domiciliarioId;

        if (domiciliarioNombre) {
          update.domiciliarioNombre = domiciliarioNombre;
        } else if (idWilResuelto) {
          const doc = await Domiciliario.findOne({ idWil: idWilResuelto }, { nombre: 1 }).lean();
          if (doc?.nombre) update.domiciliarioNombre = doc.nombre;
        }
      }

      const pedido = await Pedido.findOneAndUpdate(
        { idPedido: pedidoId },
        update,
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
     PATCH /api/foto?recurso=ubicacion-domi
  ════════════════════════════════════════ */
  if (recurso === 'ubicacion-domi' && req.method === 'PATCH') {
    try {
      const { domiId, lat, lng } = req.body || {};

      if (!domiId || lat == null || lng == null)
        return res.status(400).json({ ok: false, error: 'Faltan domiId, lat o lng' });

      const ahora  = new Date();
      const coords = { lat: Number(lat), lng: Number(lng), actualizadoEn: ahora };
      const idWil  = domiId.toUpperCase().trim();

      await Domiciliario.findOneAndUpdate(
        { idWil },
        { ubicacion: coords }
      );

      await Pedido.findOneAndUpdate(
        { domiciliarioId: idWil, estado: { $in: [/^en ruta$/i, /^en camino$/i] } },
        { domiCoords: coords }
      );

      return res.status(200).json({ ok: true, coords });
    } catch (e) {
      console.error('[PATCH ubicacion-domi]', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  /* ════════════════════════════════════════
     Recurso no reconocido
  ════════════════════════════════════════ */
  return res.status(400).json({
    ok: false,
    error: `Recurso no válido: "${recurso}". Usa: pedidos | domiciliarios | asignar | estado | foto | ubicacion-domi`,
  });
}