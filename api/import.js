const { google } = require('googleapis');
const mongoose = require('mongoose');

/* ══════════════════════════════════════════════════════════════
   DB CONNECT
══════════════════════════════════════════════════════════════ */
let isConnected = false;
async function dbConnect() {
  if (isConnected) return;
  await mongoose.connect(process.env.MONGODB_URI);
  isConnected = true;
}

/* ══════════════════════════════════════════════════════════════
   MODELOS
══════════════════════════════════════════════════════════════ */
const Base = mongoose.models.Base || mongoose.model('Base',
  new mongoose.Schema({
    domi:  { type: String, required: true, trim: true },
    monto: { type: Number, required: true },
    nota:  { type: String, default: '' },
    fecha: { type: String, default: '' },
  }, { timestamps: true }),
  'Bases'
);

const Multa = mongoose.models.Multa || mongoose.model('Multa',
  new mongoose.Schema({
    domi:  { type: String, required: true, trim: true },
    monto: { type: Number, default: 0 },
    tipo:  { type: String, default: 'multa' },
    nota:  { type: String, default: '' },
    fecha: { type: String, default: '' },
  }, { timestamps: true }),
  'Multas'
);

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
    estado:     { type: String, default: 'ok' },
    novedades:  { type: String, default: '' },
    ts:         { type: String, default: '' },
  }, { timestamps: true }),
  'CierresCaja'
);

/* ══════════════════════════════════════════════════════════════
   HANDLER CONTABLE
══════════════════════════════════════════════════════════════ */
async function handleContable(req, res) {
  try {
    await dbConnect();
  } catch (e) {
    console.error('[contable] dbConnect falló:', e.message);
    return res.status(500).json({ ok: false, error: 'DB connection failed: ' + e.message });
  }

  const { recurso, id } = req.query;

  /* ── BASES ── */
  if (recurso === 'bases') {
    if (req.method === 'GET') {
      const docs = await Base.find({}).sort({ createdAt: -1 }).limit(500).lean();
      return res.status(200).json({ ok: true, data: docs.map(d => ({
        _id: String(d._id), domi: d.domi, monto: d.monto, nota: d.nota || '', fecha: d.fecha || '',
      }))});
    }
    if (req.method === 'POST') {
      const { domi, monto, nota = '', fecha = '' } = req.body || {};
      if (!domi)  return res.status(400).json({ ok: false, error: 'Falta domi' });
      if (!monto) return res.status(400).json({ ok: false, error: 'Falta monto' });
      const doc = await Base.create({ domi, monto: Number(monto), nota, fecha });
      return res.status(201).json({ ok: true, data: { _id: String(doc._id), domi: doc.domi, monto: doc.monto, nota: doc.nota, fecha: doc.fecha }});
    }
    if (req.method === 'DELETE') {
      if (!id) return res.status(400).json({ ok: false, error: 'Falta id' });
      const result = await Base.findByIdAndDelete(id);
      if (!result) return res.status(404).json({ ok: false, error: 'Base no encontrada' });
      return res.status(200).json({ ok: true });
    }
  }

  /* ── MULTAS ── */
  if (recurso === 'multas') {
    if (req.method === 'GET') {
      const docs = await Multa.find({}).sort({ createdAt: -1 }).limit(500).lean();
      return res.status(200).json({ ok: true, data: docs.map(d => ({
        _id: String(d._id), domi: d.domi, monto: d.monto, tipo: d.tipo || 'multa', nota: d.nota || '', fecha: d.fecha || '',
      }))});
    }
    if (req.method === 'POST') {
      const { domi, monto = 0, tipo = 'multa', nota = '', fecha = '' } = req.body || {};
      if (!domi) return res.status(400).json({ ok: false, error: 'Falta domi' });
      const doc = await Multa.create({ domi, monto: Number(monto), tipo, nota, fecha });
      return res.status(201).json({ ok: true, data: { _id: String(doc._id), domi: doc.domi, monto: doc.monto, tipo: doc.tipo, nota: doc.nota, fecha: doc.fecha }});
    }
    if (req.method === 'DELETE') {
      if (!id) return res.status(400).json({ ok: false, error: 'Falta id' });
      const result = await Multa.findByIdAndDelete(id);
      if (!result) return res.status(404).json({ ok: false, error: 'Multa no encontrada' });
      return res.status(200).json({ ok: true });
    }
  }

  /* ── CIERRES ── */
  if (recurso === 'cierres') {
    if (req.method === 'GET') {
      const docs = await CierreCaja.find({}).sort({ createdAt: -1 }).limit(200).lean();
      return res.status(200).json({ ok: true, data: docs.map(d => ({
        _id: String(d._id), id: d.idCierre || String(d._id),
        turno: d.turno || '', fecha: d.fecha || '', hora: d.hora || '',
        entrega: d.entrega || '', recibe: d.recibe || '',
        efectivo: d.efectivo ?? 0, bases: d.bases ?? 0, diferencia: d.diferencia ?? 0,
        pedidos: d.pedidos ?? 0, totalEf: d.totalEf ?? 0, totalTf: d.totalTf ?? 0, totalT: d.totalT ?? 0,
        estado: d.estado || 'ok', novedades: d.novedades || '', ts: d.ts || '',
      }))});
    }
    if (req.method === 'POST') {
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
      return res.status(201).json({ ok: true, data: { _id: String(doc._id), id: doc.idCierre, ...doc.toObject() }});
    }
    if (req.method === 'DELETE') {
      if (!id) return res.status(400).json({ ok: false, error: 'Falta id' });
      const result = await CierreCaja.findByIdAndDelete(id);
      if (!result) return res.status(404).json({ ok: false, error: 'Cierre no encontrado' });
      return res.status(200).json({ ok: true });
    }
  }

  return res.status(400).json({ ok: false, error: `Recurso no válido: "${recurso}". Usa: bases | multas | cierres` });
}

/* ══════════════════════════════════════════════════════════════
   HANDLER PRINCIPAL
══════════════════════════════════════════════════════════════ */
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { recurso } = req.query;

  /* ── Ruta contable ── */
  if (['bases', 'multas', 'cierres'].includes(recurso)) {
    return handleContable(req, res);
  }

  /* ── Ruta sheets (import) ── sin tocar nada ── */
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const { productos, lote, total, tienda: t } = body;

    const tienda = (t || 'EXPERTOS').toUpperCase();
    const hoja = tienda === 'CENTRAL' ? 'STOCK_DROGUERIA_CENTRAL' : 'STOCK_DROGUERIA_EXPERTOS';

    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
    const sid = process.env.GOOGLE_SHEETS_ID;

    if (lote === 0) {
      await sheets.spreadsheets.values.clear({ spreadsheetId: sid, range: `${hoja}!A:E` });
      await sheets.spreadsheets.values.update({
        spreadsheetId: sid, range: `${hoja}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [['Descripción','Laboratorio','Unidad','Precio','Precio Unitario'], ...productos] },
      });
    } else {
      const startRow = lote * 500 + 2;
      await sheets.spreadsheets.values.update({
        spreadsheetId: sid, range: `${hoja}!A${startRow}`,
        valueInputOption: 'RAW',
        requestBody: { values: productos },
      });
    }

    res.status(200).json({ ok: true, lote, count: productos.length });
  } catch (e) {
    console.error('import API error:', e.message);
    res.status(500).json({ error: e.message });
  }
};