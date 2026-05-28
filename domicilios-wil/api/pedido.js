// api/pedido.js — Vercel Serverless Function
// Guarda pedidos de Farmacias WIL en MongoDB Atlas
// Variables de entorno requeridas: MONGODB_URI, DB_NAME

import { MongoClient } from 'mongodb';

const uri    = process.env.MONGODB_URI;
const dbName = process.env.DB_NAME;

// Reutilizar conexión entre invocaciones (cold-start optimization)
let cachedClient = null;

async function getDb() {
  if (!cachedClient) {
    cachedClient = new MongoClient(uri);
    await cachedClient.connect();
  }
  return cachedClient.db(dbName);
}

export default async function handler(req, res) {
  // CORS — permite llamadas desde tu dominio en Vercel y localhost
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ ok: false, error: 'Método no permitido' });

  try {
    const body = req.body;

    // Validación mínima
    if (!body || !body.nombre || !body.telefono) {
      return res.status(400).json({ ok: false, error: 'Faltan datos obligatorios (nombre, telefono)' });
    }

    const db  = await getDb();
    const col = db.collection('pedidos');

    // Documento que se guarda en MongoDB
    const doc = {
      // Metadata
      creadoEn:   new Date(),
      idPedido:   body.id          || String(Math.floor(100 + Math.random() * 900)),
      estado:     'Pendiente',

      // Farmacia
      sede:       body.sede        || 'expertos',
      comercio:   body.comercio    || 'Farma Expertos',

      // Cliente
      nombre:     body.nombre,
      telefono:   body.telefono,
      direccion:  body.direccion   || '',
      coords:     body.coords      || null,

      // Entrega
      modoEntrega:   body.metodoPago ? body.modoEntrega || 'DOMICILIO' : 'DOMICILIO',
      zona:          body.zona        || '',
      domicilio:     body.domicilio   || 0,

      // Pago
      metodoPago:    body.metodoPago  || '',
      // El comprobante base64 se guarda solo si existe (transferencia)
      ...(body.comprobanteBase64
        ? { comprobanteBase64: body.comprobanteBase64 }
        : {}),

      // Productos
      items: (body.rows || [])
        .filter(r => r[6])          // solo filas con nombre de producto
        .map(r => ({
          producto: r[6]  || '',
          laboratorio: r[7] || '',
          cantidad: r[8]  || 1,
          precioUnit: r[9] || 0,
          subtotal: r[10] || 0,
        })),

      // Totales
      subtotal:   body.total - (body.domicilio || 0),
      total:      body.total || 0,

      // Envío a tercero (opcional)
      destinatario: body.destinatario || null,
    };

    const result = await col.insertOne(doc);

    return res.status(200).json({
      ok:      true,
      id:      doc.idPedido,
      mongoId: result.insertedId,
    });

  } catch (err) {
    console.error('[/api/pedido] Error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}