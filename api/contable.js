import { dbConnect } from '../lib/db.js';
import mongoose from 'mongoose';

/* ══════════════════════════════════════════════════════════════
   MODELOS
══════════════════════════════════════════════════════════════ */

/* ── Base ── colección: Bases ── */
const Base = mongoose.models.Base || mongoose.model('Base',
  new mongoose.Schema({
    domi:   { type: String, required: true, trim: true },
    monto:  { type: Number, required: true },
    nota:   { type: String, default: '' },
    fecha:  { type: String, default: '' },
  }, { timestamps: true }),
  'Bases'
);

/* ── Multa ── colección: Multas ── */
const Multa = mongoose.models.Multa || mongoose.model('Multa',
  new mongoose.Schema({
    domi:   { type: String, required: true, trim: true },
    monto:  { type: Number, default: 0 },
    tipo:   { type: String, default: 'multa' },   // 'multa' | 'pyp' | 'otro'
    nota:   { type: String, default: '' },
    fecha:  { type: String, default: '' },
  }, { timestamps: true }),
  'Multas'
);

/* ── CierreCaja ── colección: CierresCaja ── */
const CierreCaja = mongoose.models.CierreCaja || mongoose.model('CierreCaja',
  new mongoose.Schema({
    idCierre:   { type: String, default: () => 'CAJA-' + Date.now() },
    turno:      String,
    fecha:      String,
    hora:       String,
    entrega:    String,
    recibe:     String,
    efectivo:   { type: Number, default: 0 },
    bases:      { type: Number, default: 0 },
    diferencia: { type: Number, default: 0 },
    pedidos:    { type: Number, default: 0 },
    totalEf:    { type: Number, default: 0 },
    totalTf:    { type: Number, default: 0 },
    totalT:     { type: Number, default: 0 },
    estado:     { type: String, default: 'ok' },  // 'ok' | 'faltante' | 'sobrante'
    novedades:  { type: String, default: '' },
    ts:         { type: String, default: '' },
  }, { timestamps: true }),
  'CierresCaja'
);

/* ══ CORS ══ */
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
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
    console.error('[contable] dbConnect falló:', e.message);
    return res.status(500).json({ ok: false, error: 'DB connection failed: ' + e.message });
  }

  const { recurso } = req.query;

  /* ════════════════════════════════════════
     GET /api/contable?recurso=bases
     Lista todas las bases (más recientes primero)
  ════════════════════════════════════════ */
  if (recurso === 'bases' && req.method === 'GET') {
    try {
      const docs = await Base.find({}).sort({ createdAt: -1 }).limit(500).lean();
      const data = docs.map(d => ({
        _id:   String(d._id),
        domi:  d.domi,
        monto: d.monto,
        nota:  d.nota  || '',
        fecha: d.fecha || '',
      }));
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      console.error('[GET bases]', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  /* ════════════════════════════════════════
     POST /api/contable?recurso=bases
     Body: { domi, monto, nota?, fecha? }
  ════════════════════════════════════════ */
  if (recurso === 'bases' && req.method === 'POST') {
    try {
      const { domi, monto, nota = '', fecha = '' } = req.body || {};
      if (!domi)  return res.status(400).json({ ok: false, error: 'Falta domi' });
      if (!monto) return res.status(400).json({ ok: false, error: 'Falta monto' });

      const doc = await Base.create({ domi, monto: Number(monto), nota, fecha });
      return res.status(201).json({
        ok: true,
        data: { _id: String(doc._id), domi: doc.domi, monto: doc.monto, nota: doc.nota, fecha: doc.fecha },
      });
    } catch (e) {
      console.error('[POST bases]', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  /* ════════════════════════════════════════
     DELETE /api/contable?recurso=bases&id=<_id>
  ════════════════════════════════════════ */
  if (recurso === 'bases' && req.method === 'DELETE') {
    try {
      const { id } = req.query;
      if (!id) return res.status(400).json({ ok: false, error: 'Falta id' });
      const result = await Base.findByIdAndDelete(id);
      if (!result) return res.status(404).json({ ok: false, error: 'Base no encontrada' });
      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error('[DELETE bases]', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  /* ════════════════════════════════════════
     GET /api/contable?recurso=multas
  ════════════════════════════════════════ */
  if (recurso === 'multas' && req.method === 'GET') {
    try {
      const docs = await Multa.find({}).sort({ createdAt: -1 }).limit(500).lean();
      const data = docs.map(d => ({
        _id:   String(d._id),
        domi:  d.domi,
        monto: d.monto,
        tipo:  d.tipo  || 'multa',
        nota:  d.nota  || '',
        fecha: d.fecha || '',
      }));
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      console.error('[GET multas]', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  /* ════════════════════════════════════════
     POST /api/contable?recurso=multas
     Body: { domi, monto, tipo, nota?, fecha? }
  ════════════════════════════════════════ */
  if (recurso === 'multas' && req.method === 'POST') {
    try {
      const { domi, monto = 0, tipo = 'multa', nota = '', fecha = '' } = req.body || {};
      if (!domi) return res.status(400).json({ ok: false, error: 'Falta domi' });

      const doc = await Multa.create({ domi, monto: Number(monto), tipo, nota, fecha });
      return res.status(201).json({
        ok: true,
        data: { _id: String(doc._id), domi: doc.domi, monto: doc.monto, tipo: doc.tipo, nota: doc.nota, fecha: doc.fecha },
      });
    } catch (e) {
      console.error('[POST multas]', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  /* ════════════════════════════════════════
     DELETE /api/contable?recurso=multas&id=<_id>
  ════════════════════════════════════════ */
  if (recurso === 'multas' && req.method === 'DELETE') {
    try {
      const { id } = req.query;
      if (!id) return res.status(400).json({ ok: false, error: 'Falta id' });
      const result = await Multa.findByIdAndDelete(id);
      if (!result) return res.status(404).json({ ok: false, error: 'Multa no encontrada' });
      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error('[DELETE multas]', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  /* ════════════════════════════════════════
     GET /api/contable?recurso=cierres
  ════════════════════════════════════════ */
  if (recurso === 'cierres' && req.method === 'GET') {
    try {
      const docs = await CierreCaja.find({}).sort({ createdAt: -1 }).limit(200).lean();
      const data = docs.map(d => ({
        _id:        String(d._id),
        id:         d.idCierre || String(d._id),
        turno:      d.turno      || '',
        fecha:      d.fecha      || '',
        hora:       d.hora       || '',
        entrega:    d.entrega    || '',
        recibe:     d.recibe     || '',
        efectivo:   d.efectivo   ?? 0,
        bases:      d.bases      ?? 0,
        diferencia: d.diferencia ?? 0,
        pedidos:    d.pedidos    ?? 0,
        totalEf:    d.totalEf    ?? 0,
        totalTf:    d.totalTf    ?? 0,
        totalT:     d.totalT     ?? 0,
        estado:     d.estado     || 'ok',
        novedades:  d.novedades  || '',
        ts:         d.ts         || '',
      }));
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      console.error('[GET cierres]', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  /* ════════════════════════════════════════
     POST /api/contable?recurso=cierres
     Body: { turno, fecha, hora, entrega, recibe,
             efectivo, bases, diferencia,
             pedidos, totalEf, totalTf, totalT,
             estado, novedades, ts }
  ════════════════════════════════════════ */
  if (recurso === 'cierres' && req.method === 'POST') {
    try {
      const body = req.body || {};
      if (!body.entrega) return res.status(400).json({ ok: false, error: 'Falta entrega' });
      if (!body.recibe)  return res.status(400).json({ ok: false, error: 'Falta recibe' });

      const doc = await CierreCaja.create({
        idCierre:   body.id || ('CAJA-' + Date.now()),
        turno:      body.turno      || '',
        fecha:      body.fecha      || '',
        hora:       body.hora       || '',
        entrega:    body.entrega,
        recibe:     body.recibe,
        efectivo:   Number(body.efectivo)   || 0,
        bases:      Number(body.bases)      || 0,
        diferencia: Number(body.diferencia) || 0,
        pedidos:    Number(body.pedidos)    || 0,
        totalEf:    Number(body.totalEf)    || 0,
        totalTf:    Number(body.totalTf)    || 0,
        totalT:     Number(body.totalT)     || 0,
        estado:     body.estado     || 'ok',
        novedades:  body.novedades  || '',
        ts:         body.ts         || new Date().toLocaleString('es-CO'),
      });

      return res.status(201).json({
        ok: true,
        data: { _id: String(doc._id), id: doc.idCierre, ...doc.toObject() },
      });
    } catch (e) {
      console.error('[POST cierres]', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  /* ════════════════════════════════════════
     DELETE /api/contable?recurso=cierres&id=<_id>
  ════════════════════════════════════════ */
  if (recurso === 'cierres' && req.method === 'DELETE') {
    try {
      const { id } = req.query;
      if (!id) return res.status(400).json({ ok: false, error: 'Falta id' });
      const result = await CierreCaja.findByIdAndDelete(id);
      if (!result) return res.status(404).json({ ok: false, error: 'Cierre no encontrado' });
      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error('[DELETE cierres]', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  /* ════════════════════════════════════════
     Recurso no reconocido
  ════════════════════════════════════════ */
  return res.status(400).json({
    ok: false,
    error: `Recurso no válido: "${recurso}". Usa: bases | multas | cierres`,
  });
}