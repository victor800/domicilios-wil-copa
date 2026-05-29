import { dbConnect } from '../lib/db.js';
import mongoose from 'mongoose';

/* ══ SCHEMA: Pedidos (ya existe en api/foto.js — reusar) ══ */
const ItemSchema = new mongoose.Schema({
  producto: String, laboratorio: String,
  cantidad: Number, precioUnit: Number, subtotal: Number,
}, { _id: false });

const PedidoSchema = new mongoose.Schema({
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
});
const Pedido = mongoose.models.Pedido
  || mongoose.model('Pedido', PedidoSchema, 'pedidos');

/* ══ SCHEMA: Usuarios — tu colección real ══ */
const UsuarioSchema = new mongoose.Schema({
  idWil:        String,
  nombre:       String,
  password:     String,
  rol:          String,           // "domiciliario" | "admin" | etc.
  tel:          String,
  foto:         String,
  activo:       { type: Boolean, default: true },
  createdAt:    Date,
  updatedAt:    Date,
  ultimoAcceso: Date,
});
const Usuario = mongoose.models.Usuario
  || mongoose.model('Usuario', UsuarioSchema, 'usuarios');

/* ══ CORS ══ */
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

/* ══ HANDLER ══ */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  await dbConnect();

  const { recurso } = req.query;

  /* ──────────────────────────────────────────
     GET /api/pedidos?recurso=pedidos
     Params opcionales:
       estado=pendiente|asignado|proceso|encamino|entregado|cancelado
       domi=<nombre>
       tipo=domicilio|recogida
       limit=100
  ────────────────────────────────────────── */
  if (recurso === 'pedidos' && req.method === 'GET') {
    try {
      const { estado, domi, tipo, limit = 100 } = req.query;

      const filtro = {};
      if (estado && estado !== 'todos')
        filtro.estado = { $regex: new RegExp(`^${estado}$`, 'i') };
      if (domi)  filtro.domiciliarioNombre = { $regex: new RegExp(domi, 'i') };
      if (tipo)  filtro.modoEntrega        = { $regex: new RegExp(tipo, 'i') };

      const pedidos = await Pedido
        .find(filtro)
        .sort({ creadoEn: -1 })
        .limit(Number(limit))
        .lean();

      return res.status(200).json({ ok: true, data: pedidos });
    } catch (e) {
      console.error('[GET pedidos]', e);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  /* ──────────────────────────────────────────
     GET /api/pedidos?recurso=domiciliarios
     Lee de la colección "usuarios" filtrando
     rol = "domiciliario"
     Param opcional: activo=true|false
  ────────────────────────────────────────── */
  if (recurso === 'domiciliarios' && req.method === 'GET') {
    try {
      const soloActivos = req.query.activo !== 'false'; // default: solo activos

      const filtro = { rol: 'domiciliario' };
      if (soloActivos) filtro.activo = true;

      const domis = await Usuario
        .find(filtro, {
          password: 0,   // nunca exponer el hash
          __v:      0
        })
        .sort({ nombre: 1 })
        .lean();

      // Normalizar para el dashboard
      const data = domis.map(d => ({
        _id:          String(d._id),
        idWil:        d.idWil  || '',
        nombre:       d.nombre || '',
        tel:          d.tel    || '',
        activo:       d.activo,
        foto:         d.foto   || '',
        ultimoAcceso: d.ultimoAcceso || null,
      }));

      return res.status(200).json({ ok: true, data });
    } catch (e) {
      console.error('[GET domiciliarios]', e);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  /* ──────────────────────────────────────────
     PATCH /api/pedidos?recurso=asignar
     Body: { pedidoId, domiciliarioId, domiciliarioNombre }
  ────────────────────────────────────────── */
  if (recurso === 'asignar' && req.method === 'PATCH') {
    try {
      const { pedidoId, domiciliarioId, domiciliarioNombre } = req.body;

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
        return res.status(404).json({ ok: false, error: 'Pedido no encontrado' });

      return res.status(200).json({ ok: true, data: pedido });
    } catch (e) {
      console.error('[PATCH asignar]', e);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  /* ──────────────────────────────────────────
     PATCH /api/pedidos?recurso=estado
     Body: { pedidoId, estado }
  ────────────────────────────────────────── */
  if (recurso === 'estado' && req.method === 'PATCH') {
    try {
      const { pedidoId, estado } = req.body;

      if (!pedidoId || !estado)
        return res.status(400).json({ ok: false, error: 'Faltan pedidoId o estado' });

      const pedido = await Pedido.findOneAndUpdate(
        { idPedido: pedidoId },
        { estado },
        { new: true }
      );

      if (!pedido)
        return res.status(404).json({ ok: false, error: 'Pedido no encontrado' });

      return res.status(200).json({ ok: true, data: pedido });
    } catch (e) {
      console.error('[PATCH estado]', e);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  return res.status(400).json({ ok: false, error: 'Recurso no válido' });
}