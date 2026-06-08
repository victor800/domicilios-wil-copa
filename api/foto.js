import { dbConnect } from '../lib/db.js';
import mongoose from 'mongoose';

/* ══════════════════════════════════════════════════════════════
   MODELOS
══════════════════════════════════════════════════════════════ */

const ItemSchema = new mongoose.Schema({
  producto: String, laboratorio: String,
  cantidad: Number, precioUnit: Number, subtotal: Number,
}, { _id: false });

const Pedido = mongoose.models.Pedido || mongoose.model('Pedido',
  new mongoose.Schema({
    creadoEn:           { type: Date, default: Date.now },
    idPedido:           String,
    estado:             { type: String, default: 'Pendiente' },
    sede:               String,
    notas:              { type: String, default: '' },
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
    domiCoords: {
      lat:           { type: Number, default: null },
      lng:           { type: Number, default: null },
      actualizadoEn: { type: Date,   default: null },
    },

   
   /* ── FÓRMULA MÉDICA ── */
    formulaMedica: {
      url:       { type: String, default: null },
      mime:      { type: String, default: null },
      data:      { type: Buffer, default: null },
    },
    /* ── COMPROBANTE DE PAGO ── */
    comprobanteImg: {
      url:       { type: String, default: null },
      mime:      { type: String, default: null },
      data:      { type: Buffer, default: null },
    },
  }), 'pedidos'
);

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
    ubicacion: {
      lat:           { type: Number, default: null },
      lng:           { type: Number, default: null },
      actualizadoEn: { type: Date,   default: null },
    },
  }, { timestamps: true }),
  'Domiciliarios'
);

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

/* ══ Sanitizar string ══ */
function sanitizeStr(val) {
  if (val == null) return null;
  return String(val).replace(/[${}()|[\]\\^*+?./]/g, '').trim().slice(0, 100);
}

/* ══ Token comprobante ══ */
import crypto from 'crypto';

function tokenComprobante(id) {
  const secret = process.env.COMPROBANTE_SECRET || 'wil-secret-fallback';
  return crypto.createHmac('sha256', secret).update(String(id)).digest('hex').slice(0, 32);
}

function verificarTokenComprobante(id, t) {
  return t && t === tokenComprobante(id);
}

/* ══ Resolver idWil ══ */
async function resolverIdWil(valor) {
  if (!valor) return null;
  if (/^[a-f\d]{24}$/i.test(valor)) {
    const doc = await Domiciliario.findById(valor, { idWil: 1 }).lean();
    return doc?.idWil ?? null;
  }
  return valor.toUpperCase().trim();
}

const Contador = mongoose.models.Contador || mongoose.model('Contador',
  new mongoose.Schema({
    _id: String,
    seq: { type: Number, default: 0 }
  }),
  'contadores'
);

async function siguienteId() {
  const doc = await Contador.findByIdAndUpdate(
    'pedido',
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  const n      = doc.seq - 1;
  const numero = String((n % 99) + 1).padStart(2, '0');
  const vuelta = Math.floor(n / 99);
  const letra1 = String.fromCharCode(65 + Math.floor(vuelta / 26) % 26);
  const letra2 = String.fromCharCode(65 + (vuelta % 26));
  return numero + letra1 + letra2;
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
    return res.status(500).json({ ok: false, error: 'DB connection failed' });
  }

  const { recurso } = req.query;

  /* ════════════════════════════════════════
     POST /api/foto?recurso=pedidos
     ─────────────────────────────────────
     Si el body trae `formulaMedica` (string base64 "data:<mime>;base64,<bytes>"):
       1. Se extrae mime + buffer.
       2. Se crea el pedido SIN el base64 en texto (se guarda como Buffer).
       3. Se construye la URL pública con el _id del pedido recién creado.
       4. Se escribe esa URL en pedido.formulaMedica.url con findByIdAndUpdate.
       5. Se retorna el pedido con la URL ya incluida.
  ════════════════════════════════════════ */
  if (recurso === 'pedidos' && req.method === 'POST') {
    try {
      const body = { ...(req.body || {}) };
      if (!body.idPedido)
        body.idPedido = await siguienteId();

     /* ── Procesar fórmula médica si viene en el payload ── */
      let formulaBuffer = null;
      let formulaMime   = null;

      if (body.formulaMedica && typeof body.formulaMedica === 'string') {
        const match = body.formulaMedica.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          formulaMime   = match[1];
          formulaBuffer = Buffer.from(match[2], 'base64');
        }
        delete body.formulaMedica;
      }

      if (formulaBuffer) {
        body.formulaMedica = { data: formulaBuffer, mime: formulaMime, url: null };
      }

      /* ── Procesar comprobante de pago si viene en el payload ── */
      let compBuffer = null;
      let compMime   = null;

      if (body.comprobanteImg && typeof body.comprobanteImg === 'string') {
        const match = body.comprobanteImg.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          compMime   = match[1];
          compBuffer = Buffer.from(match[2], 'base64');
        }
        delete body.comprobanteImg;
      }

      if (compBuffer) {
        body.comprobanteImg = { data: compBuffer, mime: compMime, url: null };
      }

      /* Crear el pedido */
      const nuevo = await Pedido.create(body);

      /* ── Construir URLs y escribirlas en el documento ── */
      const urlUpdate = {};

      if (formulaBuffer) {
        const formulaUrl = `/api/foto?recurso=formula&id=${nuevo._id}`;
        urlUpdate['formulaMedica.url'] = formulaUrl;
        nuevo.formulaMedica = { url: formulaUrl, mime: formulaMime };
      }

      if (compBuffer) {
        const compUrl = `/api/foto?recurso=comprobante&id=${nuevo._id}&t=${tokenComprobante(nuevo._id)}`;
        urlUpdate['comprobanteImg.url'] = compUrl;
        nuevo.comprobanteImg = { url: compUrl, mime: compMime };
      }

      if (Object.keys(urlUpdate).length) {
        await Pedido.findByIdAndUpdate(nuevo._id, urlUpdate);
      }

      /* Respuesta: omitir buffers binarios */
      const respuesta = nuevo.toObject();
      if (respuesta.formulaMedica?.data)  delete respuesta.formulaMedica.data;
      if (respuesta.comprobanteImg?.data) delete respuesta.comprobanteImg.data;

      return res.status(201).json({ ok: true, data: respuesta });
    } catch (e) {
      if (e.code === 11000)
        return res.status(409).json({ ok: false, error: 'Pedido duplicado' });
      console.error('[POST pedidos]', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  /* ════════════════════════════════════════
     GET /api/foto?recurso=comprobante&id=<_id>
     Sirve la imagen del comprobante de pago
  ════════════════════════════════════════ */
  if (recurso === 'comprobante' && req.method === 'GET') {
    try {
      const { id } = req.query;
      if (!id || !/^[a-f\d]{24}$/i.test(id))
        return res.status(400).json({ ok: false, error: 'id inválido' });

      const { t } = req.query;
      if (!verificarTokenComprobante(id, t))
        return res.status(403).json({ ok: false, error: 'Token inválido' });

      const pedido = await Pedido.findById(id, { comprobanteImg: 1 }).lean();
      if (!pedido?.comprobanteImg?.data)
        return res.status(404).json({ ok: false, error: 'Comprobante no encontrado' });

      const mime = pedido.comprobanteImg.mime || 'image/jpeg';
      let buf;
      if (Buffer.isBuffer(pedido.comprobanteImg.data)) {
        buf = pedido.comprobanteImg.data;
      } else if (pedido.comprobanteImg.data?.buffer) {
        buf = Buffer.from(pedido.comprobanteImg.data.buffer);
      } else {
        buf = Buffer.from(Object.values(pedido.comprobanteImg.data));
      }

      res.setHeader('Content-Type', mime);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.status(200).send(buf);
    } catch (e) {
      console.error('[GET comprobante]', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  /* ════════════════════════════════════════
     GET /api/foto?recurso=formula&id=<_id>
     Sirve el archivo (imagen o PDF) de la fórmula médica
     almacenada dentro del documento del pedido.
  ════════════════════════════════════════ */
  if (recurso === 'formula' && req.method === 'GET') {
    try {
      const { id } = req.query;
      if (!id || !/^[a-f\d]{24}$/i.test(id))
        return res.status(400).json({ ok: false, error: 'id inválido' });

      const pedido = await Pedido.findById(id, { formulaMedica: 1 }).lean();
      if (!pedido?.formulaMedica?.data)
        return res.status(404).json({ ok: false, error: 'Fórmula no encontrada' });

      const mime = pedido.formulaMedica.mime || 'image/jpeg';
      let buf;
      if (Buffer.isBuffer(pedido.formulaMedica.data)) {
        buf = pedido.formulaMedica.data;
      } else if (pedido.formulaMedica.data?.buffer) {
        buf = Buffer.from(pedido.formulaMedica.data.buffer);
      } else {
        buf = Buffer.from(Object.values(pedido.formulaMedica.data));
      }

      res.setHeader('Content-Type', mime);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.status(200).send(buf);
    } catch (e) {
      console.error('[GET formula]', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  /* ════════════════════════════════════════
     GET /api/foto?recurso=pedidos
  ════════════════════════════════════════ */
  if (recurso === 'pedidos' && req.method === 'GET') {
    try {
      const {
        estado, domi, domiId, tipo,
        limit = 300, idPedido,
      } = req.query;

      const filtro = {};

      if (idPedido) {
        const idLimpio = sanitizeStr(idPedido);
        if (!idLimpio)
          return res.status(400).json({ ok: false, error: 'idPedido inválido' });
        filtro.idPedido = { $regex: new RegExp(`^${idLimpio}$`, 'i') };
      }

      if (estado && estado !== 'todos') {
        const estadoList = estado.split(',').map(s => sanitizeStr(s)).filter(Boolean);
        filtro.estado = estadoList.length === 1
          ? { $regex: new RegExp(`^${estadoList[0]}$`, 'i') }
          : { $in: estadoList.map(s => new RegExp(`^${s}$`, 'i')) };
      }

      if (domi) {
        const domiLimpio = sanitizeStr(domi);
        if (domiLimpio)
          filtro.domiciliarioNombre = { $regex: new RegExp(domiLimpio, 'i') };
      }

      if (domiId) {
        const idWilResuelto = await resolverIdWil(domiId);
        filtro.domiciliarioId = idWilResuelto ?? domiId;
      }

      if (tipo) {
        const tipoLimpio = sanitizeStr(tipo);
        if (tipoLimpio)
          filtro.modoEntrega = { $regex: new RegExp(tipoLimpio, 'i') };
      }

      if (req.query.sede) {
        const sedeLimpia = sanitizeStr(req.query.sede);
        if (sedeLimpia)
          filtro.sede = { $regex: new RegExp(`^${sedeLimpia}$`, 'i') };
      }

      const limitSeguro = Math.min(Math.max(Number(limit) || 300, 1), 500);

      // Excluir el buffer binario de la fórmula en los listados
      const pedidos = await Pedido
        .find(filtro, { 'formulaMedica.data': 0, 'comprobanteImg.data': 0 })
        .sort({ creadoEn: -1 })
        .limit(limitSeguro)
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
        ok: true,
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
        { new: true, projection: { 'formulaMedica.data': 0, 'comprobanteImg.data': 0 } }
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
        { new: true, projection: { 'formulaMedica.data': 0, 'comprobanteImg.data': 0 } }
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
     Actualiza la ubicación del domiciliario y sus pedidos activos
  ═══════════════════════════════════════ */
  if (recurso === 'ubicacion-domi' && req.method === 'PATCH') {
    try {
      const { domiId, lat, lng } = req.body || {};

      // Validaciones mejoradas
      if (!domiId) {
        return res.status(400).json({ ok: false, error: 'Falta domiId' });
      }
      
      if (lat === undefined || lat === null || lng === undefined || lng === null) {
        return res.status(400).json({ ok: false, error: 'Faltan lat o lng' });
      }

      const latNum = Number(lat);
      const lngNum = Number(lng);
      
      if (isNaN(latNum) || isNaN(lngNum)) {
        return res.status(400).json({ ok: false, error: 'lat y lng deben ser números válidos' });
      }

      const ahora  = new Date();
      const coords = { 
        lat: latNum, 
        lng: lngNum, 
        actualizadoEn: ahora 
      };
      
      const idWil = domiId.toUpperCase().trim();

      // 1. Actualizar ubicación del domiciliario
      const domiActualizado = await Domiciliario.findOneAndUpdate(
        { idWil }, 
        { ubicacion: coords },
        { new: true }
      );

      if (!domiActualizado) {
        return res.status(404).json({ ok: false, error: 'Domiciliario no encontrado' });
      }

      // 2. Actualizar coordenadas en pedidos activos (no entregados ni cancelados)
      const pedidosActualizados = await Pedido.updateMany(
        { 
          domiciliarioId: idWil,
          estado: { $nin: ['Entregado', 'Cancelado', 'Completado'] }
        },
        { domiCoords: coords }
      );

      console.log(`[UBICACIÓN] ${idWil} -> lat:${latNum}, lng:${lngNum} | Pedidos actualizados: ${pedidosActualizados.modifiedCount}`);

      return res.status(200).json({ 
        ok: true, 
        coords,
        pedidosActualizados: pedidosActualizados.modifiedCount
      });
    } catch (e) {
      console.error('[PATCH ubicacion-domi]', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  /* ════════════════════════════════════════
     GET /api/foto?recurso=ubicacion
     Consulta la ubicación actual de un pedido o domiciliario
     Uso: 
       - ?pedidoId=XXX  (devuelve ubicación del pedido o su domiciliario)
       - ?domiId=XXX    (devuelve ubicación actual del domiciliario)
  ═══════════════════════════════════════ */
  if (recurso === 'ubicacion' && req.method === 'GET') {
    try {
      const { pedidoId, domiId } = req.query;
      
      if (pedidoId) {
        // Buscar por pedido
        const pedido = await Pedido.findOne(
          { idPedido: pedidoId },
          { domiciliarioId: 1, domiCoords: 1, estado: 1 }
        ).lean();
        
        if (!pedido) {
          return res.status(404).json({ ok: false, error: 'Pedido no encontrado' });
        }
        
        // Si el pedido tiene coordenadas recientes (menos de 30 segundos), devolverlas
        if (pedido.domiCoords?.lat && pedido.domiCoords?.lng) {
          const actualizadoHace = pedido.domiCoords.actualizadoEn 
            ? Math.floor((Date.now() - new Date(pedido.domiCoords.actualizadoEn)) / 1000)
            : null;
            
          // Si la ubicación tiene menos de 60 segundos, es confiable
          const esReciente = actualizadoHace !== null && actualizadoHace < 60;
            
          return res.status(200).json({ 
            ok: true, 
            ubicacion: pedido.domiCoords,
            estado: pedido.estado,
            actualizadoHaceSegundos: actualizadoHace,
                esReciente
          });
        }
        
        // Si no tiene coordenadas en el pedido, buscar ubicación actual del domiciliario
        if (pedido.domiciliarioId) {
          const domi = await Domiciliario.findOne(
            { idWil: pedido.domiciliarioId },
            { ubicacion: 1, nombre: 1 }
          ).lean();
          
          if (domi?.ubicacion?.lat) {
            const actualizadoHace = domi.ubicacion.actualizadoEn 
              ? Math.floor((Date.now() - new Date(domi.ubicacion.actualizadoEn)) / 1000)
              : null;
              
            return res.status(200).json({ 
              ok: true, 
              ubicacion: domi.ubicacion,
              domiciliarioNombre: domi.nombre,
              fuente: 'domiciliario',
              actualizadoHaceSegundos: actualizadoHace
            });
          }
        }
        
        return res.status(200).json({ 
          ok: true, 
          ubicacion: null,
          mensaje: 'No hay ubicación disponible para este pedido'
        });
      }
      
      if (domiId) {
        // Buscar directamente por domiciliario
        const domi = await Domiciliario.findOne(
          { idWil: domiId.toUpperCase().trim() },
          { ubicacion: 1, nombre: 1, activo: 1 }
        ).lean();
        
        if (!domi) {
          return res.status(404).json({ ok: false, error: 'Domiciliario no encontrado' });
        }
        
        if (!domi.activo) {
          return res.status(200).json({ 
            ok: true, 
            ubicacion: null,
            mensaje: 'Domiciliario inactivo'
          });
        }
        
        const actualizadoHace = domi.ubicacion?.actualizadoEn 
          ? Math.floor((Date.now() - new Date(domi.ubicacion.actualizadoEn)) / 1000)
          : null;
        
        return res.status(200).json({ 
          ok: true, 
          ubicacion: domi.ubicacion || null,
          nombre: domi.nombre,
          actualizadoHaceSegundos: actualizadoHace
        });
      }
      
      return res.status(400).json({ 
        ok: false, 
        error: 'Se requiere pedidoId o domiId' 
      });
    } catch (e) {
      console.error('[GET ubicacion]', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  /* ════════════════════════════════════════
     POST /api/foto?recurso=debug-ubicacion
     SOLO PARA DEPURACIÓN - Actualiza ubicación manualmente
     Uso: { "pedidoId": "01AB", "lat": 4.7110, "lng": -74.0721 }
  ═══════════════════════════════════════ */
  if (recurso === 'debug-ubicacion' && req.method === 'POST') {
    try {
      const { pedidoId, lat, lng } = req.body;
      
      if (!pedidoId || lat === undefined || lng === undefined) {
        return res.status(400).json({ ok: false, error: 'Faltan pedidoId, lat o lng' });
      }
      
      const pedido = await Pedido.findOneAndUpdate(
        { idPedido: pedidoId },
        { 
          domiCoords: { 
            lat: Number(lat), 
            lng: Number(lng), 
            actualizadoEn: new Date() 
          } 
        },
        { new: true, projection: { 'formulaMedica.data': 0, 'comprobanteImg.data': 0 } }
      );
      
      if (!pedido) {
        return res.status(404).json({ ok: false, error: 'Pedido no encontrado' });
      }
      
      return res.status(200).json({ 
        ok: true, 
        mensaje: 'Ubicación actualizada manualmente (debug)',
        data: pedido 
      });
    } catch (e) {
      console.error('[POST debug-ubicacion]', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  return res.status(400).json({
    ok: false,
    error: `Recurso no válido: "${recurso}". Usa: pedidos | domiciliarios | asignar | estado | foto | formula | ubicacion-domi | ubicacion | debug-ubicacion`,
  });
}