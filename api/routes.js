// ══════════════════════════════════════════════════════════════════════════════
// api/routes.js — Domicilios WIL
// Auth de domiciliarios y admins leyendo DIRECTO del Google Sheet
// igual que lo hace el bot en Telegram — sin claves hardcodeadas
// ══════════════════════════════════════════════════════════════════════════════

const express  = require('express');
const router   = express.Router();
const moment   = require('moment-timezone');
const { google } = require('googleapis');

const {
  registrarPedido, getPedidos, contarPedidosPorEstado,
  asignarDomiciliario, marcarEntregado, actualizarTotalPedido,
  cancelarPedido, verificarClave,
  buscarBarrioEnSheet, guardarBarrioEnSheet,
  registrarPostulante, guardarCalificacion, resumenDia,
  buscarProductos,
} = require('../services/sheets');

const { calcularDistancia, calcularPrecioPorKm } = require('../services/distancia');

// ── Referencias al pool/drivers/bot del wilBot ────────────────────────────────
let _pool    = null;
let _drivers = null;
let _botRef  = null;

function setPoolRef(pool, drivers) { _pool = pool; _drivers = drivers; }
function setBotRef(bot)            { _botRef = bot; }
function pool()    { return _pool    || {}; }
function drivers() { return _drivers || {}; }

// ── Helpers ───────────────────────────────────────────────────────────────────
const COP = n => '$' + Math.round(n || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');

const parsearTotal = val => {
  if (!val && val !== 0) return null;
  if (typeof val === 'number') return Math.round(val);
  const n = parseInt(String(val).replace(/\./g, '').replace(/[^0-9]/g, ''));
  return isNaN(n) ? null : n;
};

// ── Google Sheets auth (igual que sheets.js) ──────────────────────────────────
async function getSheets() {
  const auth = new google.auth.GoogleAuth({
    keyFile: './credentials.json',
    scopes:  ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

const SID = () => process.env.GOOGLE_SHEETS_ID;

// ══════════════════════════════════════════════════════════════════════════════
// AUTENTICACIÓN DOMICILIARIO
// Lee hoja Domiciliarios!A:D — columna C = clave, columna D = activo
// Exactamente igual que verificarClave() en sheets.js
// ══════════════════════════════════════════════════════════════════════════════
router.post('/auth/domiciliario', async (req, res) => {
  try {
    const { clave } = req.body;
    if (!clave) return res.status(400).json({ ok: false, error: 'Falta la clave' });

    // Reutiliza la función ya existente en sheets.js
    const r = await verificarClave(clave.trim());
    if (!r.valida) {
      return res.json({ ok: false, error: 'Clave incorrecta. Pide una nueva al administrador.' });
    }

    // Crear sesión web en el objeto drivers en memoria
    const drvs      = drivers();
    const sessionId = `web_domi_${Date.now()}_${r.fila}`;
    drvs[sessionId] = {
      nombre:         r.nombre,
      pedidoActual:   null,
      pedidosActivos: [],
      loginTs:        Date.now(),
      lastActivity:   Date.now(),
      esWeb:          true,
    };

    console.log(`✅ Login web domi: ${r.nombre} — session: ${sessionId}`);
    res.json({ ok: true, nombre: r.nombre, sessionId });
  } catch (e) {
    console.error('POST /auth/domiciliario:', e.message);
    res.status(500).json({ ok: false, error: 'Error verificando clave' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// AUTENTICACIÓN ADMIN
// Lee hoja Admins!A:D — columna C = clave, columna D = ACTIVO (SI/NO)
// Exactamente igual que manejarAutenticacionAdmin() en wilBot.js
// Soporta múltiples admins — cualquiera con clave válida y ACTIVO=SI entra
// ══════════════════════════════════════════════════════════════════════════════
router.post('/auth/admin', async (req, res) => {
  try {
    const { clave } = req.body;
    if (!clave) return res.status(400).json({ ok: false, error: 'Falta la clave' });

    const sheets = await getSheets();
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SID(),
      range:         'Admins!A:D',
    });

    const rows = (result.data.values || []).slice(1); // saltar cabecera
    let adminNombre = null;

    for (const row of rows) {
      const claveSheet  = (row[2] || '').toString().trim();
      const activoSheet = (row[3] || '').toString().trim().toUpperCase();

      if (claveSheet === clave.trim() && activoSheet === 'SI') {
        adminNombre = (row[1] || 'Admin').toString().trim();
        break;
      }
    }

    if (!adminNombre) {
      return res.json({ ok: false, error: 'Clave incorrecta o admin inactivo.' });
    }

    // Sesión admin en memoria
    const drvs      = drivers();
    const sessionId = `web_admin_${Date.now()}`;
    drvs[sessionId] = {
      nombre:   adminNombre,
      esAdmin:  true,
      esWeb:    true,
      loginTs:  Date.now(),
    };

    console.log(`✅ Login web admin: ${adminNombre}`);
    res.json({ ok: true, nombre: adminNombre, sessionId });
  } catch (e) {
    console.error('POST /auth/admin:', e.message);
    res.status(500).json({ ok: false, error: 'Error verificando clave de administrador' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// MIDDLEWARES DE SESIÓN
// ══════════════════════════════════════════════════════════════════════════════

// Middleware: requiere sesión de domiciliario válida
function authDomi(req, res, next) {
  const sid = req.headers['x-session-id'];
  const d   = sid && drivers()[sid];
  if (!d || d.esAdmin) {
    return res.status(401).json({ ok: false, error: 'Sesión inválida. Inicia sesión de nuevo.' });
  }
  req.driverSession = sid;
  req.driver        = d;
  d.lastActivity    = Date.now();
  next();
}

// Middleware: requiere sesión de admin válida
function authAdmin(req, res, next) {
  const sid = req.headers['x-session-id'];
  const d   = sid && drivers()[sid];
  if (!d || !d.esAdmin) {
    return res.status(401).json({ ok: false, error: 'No autorizado. Acceso solo para administradores.' });
  }
  req.adminSession = sid;
  req.admin        = d;
  next();
}

// ══════════════════════════════════════════════════════════════════════════════
// SALUD
// ══════════════════════════════════════════════════════════════════════════════
router.get('/health', (req, res) => {
  const drvs = drivers();
  res.json({
    ok:                   true,
    hora:                 moment().tz('America/Bogota').format('DD/MM/YYYY hh:mm A'),
    pedidosEnMemoria:     Object.keys(pool()).length,
    sesionesActivas:      Object.keys(drvs).length,
    domiciliariosOnline:  Object.values(drvs).filter(d => !d.esAdmin).length,
    adminsOnline:         Object.values(drvs).filter(d => d.esAdmin).length,
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// CERRAR SESIÓN (sirve para domi y admin)
// ══════════════════════════════════════════════════════════════════════════════
router.post('/logout', (req, res) => {
  const sid  = req.headers['x-session-id'];
  const drvs = drivers();
  if (sid && drvs[sid]) {
    const nombre = drvs[sid].nombre;
    delete drvs[sid];
    console.log(`🚪 Logout web: ${nombre}`);
  }
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// TARIFAS
// ══════════════════════════════════════════════════════════════════════════════
router.post('/tarifa', async (req, res) => {
  try {
    const { texto } = req.body;
    if (!texto) return res.status(400).json({ ok: false, error: 'Falta el texto' });

    const enSheet = await buscarBarrioEnSheet(texto);
    if (enSheet && (enSheet.tarifa || enSheet.paqPeq)) {
      return res.json({
        ok: true,
        barrio:     enSheet.barrio,
        zona:       enSheet.zona || '',
        tarifa:     enSheet.tarifa,
        paqPeq:     enSheet.paqPeq,
        encontrado: true,
      });
    }

    try {
      const geo = await calcularDistancia(texto, null, null);
      if (geo?.esCobertura) {
        return res.json({
          ok:         true,
          barrio:     geo.barrio || texto,
          zona:       geo.zona   || '',
          municipio:  geo.municipio || '',
          tarifa:     geo.tarifa  || null,
          encontrado: false,
        });
      }
    } catch (_) {}

    res.json({ ok: true, barrio: texto, tarifa: null, encontrado: false });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// BUSCAR PRODUCTOS
// ══════════════════════════════════════════════════════════════════════════════
router.post('/buscar-productos', async (req, res) => {
  try {
    const { termino, tienda } = req.body;
    if (!termino) return res.status(400).json({ ok: false, error: 'Falta el término' });
    const resultados = await buscarProductos(termino, tienda || 'EXPERTOS');
    res.json({ ok: true, resultados });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// REGISTRAR PEDIDO
// ══════════════════════════════════════════════════════════════════════════════
router.post('/pedido', async (req, res) => {
  try {
    const {
      nombre, telefono, metodoPago,
      negocioNombre, tienda,
      direccion, referencia,
      productos,
      precioDomicilio,
      presupuesto,
      clienteSessionId,
    } = req.body;

    if (!nombre || !telefono || !direccion) {
      return res.status(400).json({ ok: false, error: 'Faltan: nombre, telefono, direccion' });
    }

    const carrito = Array.isArray(productos)
      ? productos
      : [{ descripcion: String(productos || ''), cantidad: 1, precioUnitario: 0, subtotal: 0 }];

    const sub   = carrito.reduce((a, i) => a + (i.subtotal || 0), 0);
    const dom   = parsearTotal(precioDomicilio) || 0;
    const total = tienda ? sub + dom : 0;

    const id = await registrarPedido({
      nombre, telefono,
      metodoPago:    metodoPago || 'EFECTIVO',
      imagenFileId:  '',
      carrito,
      negocioNombre: negocioNombre || '🏪 Domicilios WIL',
      tienda:        tienda || null,
      direccion,
      precioDomicilio: dom,
      totalFinal:    total,
      presupuesto:   presupuesto || null,
    });

    const p = pool();
    p[id] = {
      id,
      negocioNombre: negocioNombre || '🏪 Domicilios WIL',
      tienda:        tienda || null,
      tipo:          'pedido',
      cliente:       nombre,
      telefono,
      clienteId:     clienteSessionId || null,
      direccionCliente: direccion,
      direccion,
      barrio:        direccion,
      referencia:    referencia || '',
      presupuesto:   presupuesto || null,
      productos:     carrito.map(i => `${i.cantidad}× ${i.descripcion}`).join(', '),
      carrito,
      total:         total || null,
      precioDomicilio: dom,
      metodoPago:    metodoPago || 'EFECTIVO',
      estado:        'PENDIENTE',
      hora:          moment().tz('America/Bogota').format('hh:mm A'),
      createdAt:     Date.now(),
    };

    // Notificar domiciliarios activos en Telegram
    if (_botRef) {
      const pend = Object.values(p).filter(x => x.estado === 'PENDIENTE').length;
      Object.entries(drivers()).forEach(([did, d]) => {
        if (!d.esAdmin && !d.esWeb && (d.pedidosActivos || []).length < 2) {
          _botRef.telegram.sendMessage(did,
            `🔴 <b>Nuevo pedido Web — ${id}</b>\n🏪 ${negocioNombre}\n👤 ${nombre}\n📍 ${direccion}\n🛵 ${COP(dom)}\n\n📋 Pendientes (${pend})`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
        }
      });
    }

    res.json({ ok: true, id, precioDomicilio: dom, total, hora: moment().tz('America/Bogota').format('hh:mm A') });
  } catch (e) {
    console.error('POST /pedido:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// REGISTRAR PAQUETERÍA
// ══════════════════════════════════════════════════════════════════════════════
router.post('/paquete', async (req, res) => {
  try {
    const { nombre, telefono, origen, refOrigen, destino, refDestino, contactoDestino, tipoPaquete, peso, descripcion, clienteSessionId } = req.body;
    if (!nombre || !telefono || !origen || !destino) {
      return res.status(400).json({ ok: false, error: 'Faltan datos del paquete' });
    }

    let dom = 0;
    try {
      const gO = await calcularDistancia(origen, null, null);
      const gD = await calcularDistancia(destino, null, null);
      if (gO?.lat && gD?.lat && calcularPrecioPorKm) {
        dom = calcularPrecioPorKm(gO.lat, gO.lng, gD.lat, gD.lng).precioCOP || 0;
      } else if (gD?.tarifa) dom = gD.tarifa;
    } catch (_) {}

    const prodStr = `${tipoPaquete || 'Paquete'}${peso ? ' (~' + peso + ')' : ''}: ${descripcion || '—'} (${origen} → ${destino})`;

    const id = await registrarPedido({
      nombre, telefono, metodoPago: 'EFECTIVO', imagenFileId: '',
      carrito: [{ descripcion: prodStr, cantidad: 1, precioUnitario: 0, subtotal: 0 }],
      negocioNombre: '📦 Paquetería WIL', tienda: null, tipo: 'paqueteria',
      direccion: destino, precioDomicilio: dom, totalFinal: dom,
    });

    const p  = pool();
    p[id] = {
      id, negocioNombre: '📦 Paquetería WIL', tienda: null, tipo: 'paqueteria',
      cliente: nombre, telefono, clienteId: clienteSessionId || null,
      direccionCliente: destino, direccion: destino, barrio: destino, origen,
      productos: prodStr, total: null, precioDomicilio: dom,
      estado: 'PENDIENTE', hora: moment().tz('America/Bogota').format('hh:mm A'), createdAt: Date.now(),
    };

    if (_botRef) {
      const pend = Object.values(p).filter(x => x.estado === 'PENDIENTE').length;
      Object.entries(drivers()).forEach(([did, d]) => {
        if (!d.esAdmin && !d.esWeb && (d.pedidosActivos || []).length < 2) {
          _botRef.telegram.sendMessage(did,
            `📦 <b>Nuevo paquete Web — ${id}</b>\n👤 ${nombre}\n🔄 ${origen}\n📍 ${destino}\n🛵 ${COP(dom)}\n\n📋 Pendientes (${pend})`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
        }
      });
    }

    res.json({ ok: true, id, precioDomicilio: dom });
  } catch (e) {
    console.error('POST /paquete:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// PEDIDOS — listar
// ══════════════════════════════════════════════════════════════════════════════
router.get('/pedidos/:estado?', async (req, res) => {
  try {
    const estado   = (req.params.estado || 'ALL').toUpperCase();
    const enSheet  = await getPedidos(estado).catch(() => []);
    const enMem    = Object.values(pool()).filter(p => estado === 'ALL' || p.estado === estado);
    const ids      = new Set(enMem.map(p => p.id));
    const merged   = [...enMem, ...enSheet.filter(p => !ids.has(p.id))];
    res.json({ ok: true, pedidos: merged });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// CONTADORES
// ══════════════════════════════════════════════════════════════════════════════
router.get('/contadores', async (req, res) => {
  try {
    const s  = await contarPedidosPorEstado().catch(() => ({ pendientes:0, enProceso:0, finalizados:0 }));
    const p  = pool();
    res.json({
      ok:         true,
      pendientes: Math.max(s.pendientes, Object.values(p).filter(x => x.estado === 'PENDIENTE').length),
      enProceso:  Math.max(s.enProceso,  Object.values(p).filter(x => x.estado === 'EN_PROCESO').length),
      finalizados: s.finalizados,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// DOMICILIARIO — pendientes disponibles
// ══════════════════════════════════════════════════════════════════════════════
router.get('/domi/pendientes', authDomi, async (req, res) => {
  try {
    const enMem   = Object.values(pool()).filter(p => p.estado === 'PENDIENTE');
    const enSheet = await getPedidos('PENDIENTE').catch(() => []);
    const ids     = new Set(enMem.map(p => p.id));
    res.json({ ok: true, pedidos: [...enMem, ...enSheet.filter(p => !ids.has(p.id))] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// DOMICILIARIO — tomar pedido
// ══════════════════════════════════════════════════════════════════════════════
router.post('/domi/tomar/:id', authDomi, async (req, res) => {
  try {
    const { id } = req.params;
    const sid    = req.driverSession;
    const d      = req.driver;
    const p      = pool();

    if ((d.pedidosActivos || []).length >= 2)
      return res.json({ ok: false, error: 'Ya tienes 2 pedidos activos. Entrega uno primero.' });

    if (p[id] && p[id].estado !== 'PENDIENTE')
      return res.json({ ok: false, error: 'Ese pedido ya fue tomado.' });

    if (!p[id]) {
      const lista = await getPedidos('PENDIENTE').catch(() => []);
      const found = lista.find(x => x.id === id);
      if (!found) return res.json({ ok: false, error: 'Pedido no encontrado.' });
      p[id] = { ...found, estado: 'PENDIENTE' };
    }

    const hora         = moment().tz('America/Bogota').format('hh:mm A');
    p[id].estado       = 'EN_PROCESO';
    p[id].domiciliario = d.nombre;
    p[id].horaTomo     = hora;

    if (!d.pedidosActivos) d.pedidosActivos = [];
    d.pedidosActivos.push(id);
    d.pedidoActual = id;

    await asignarDomiciliario(id, d.nombre);
    res.json({ ok: true, id, hora, pedido: p[id] });
  } catch (e) {
    console.error('POST /domi/tomar:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// DOMICILIARIO — registrar total manual
// ══════════════════════════════════════════════════════════════════════════════
router.post('/domi/total/:id', authDomi, async (req, res) => {
  try {
    const { id }             = req.params;
    const { totalProductos } = req.body;
    const p                  = pool();
    if (!p[id]) return res.json({ ok: false, error: 'Pedido no encontrado.' });

    const prods = parsearTotal(totalProductos) || 0;
    const dom   = parsearTotal(p[id].precioDomicilio) || 0;
    const total = prods + dom;

    p[id].total          = total;
    p[id].totalProductos = prods;
    await actualizarTotalPedido(id, total);

    res.json({ ok: true, totalProductos: prods, dom, total });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// DOMICILIARIO — entregar
// ══════════════════════════════════════════════════════════════════════════════
router.post('/domi/entregar/:id', authDomi, async (req, res) => {
  try {
    const { id } = req.params;
    const d      = req.driver;
    const p      = pool();

    const hora = await marcarEntregado(id).catch(() => moment().tz('America/Bogota').format('hh:mm A'));
    if (p[id]) p[id].estado = 'FINALIZADO';
    if (d.pedidosActivos) d.pedidosActivos = d.pedidosActivos.filter(x => x !== id);
    d.pedidoActual = d.pedidosActivos?.[0] || null;

    res.json({ ok: true, id, hora });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// DOMICILIARIO — cancelar
// ══════════════════════════════════════════════════════════════════════════════
router.post('/domi/cancelar/:id', authDomi, async (req, res) => {
  try {
    const { id } = req.params;
    const d      = req.driver;
    const p      = pool();
    if (p[id]) p[id].estado = 'CANCELADO';
    if (d.pedidosActivos) d.pedidosActivos = d.pedidosActivos.filter(x => x !== id);
    if (typeof cancelarPedido === 'function') await cancelarPedido(id).catch(() => {});
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// DOMICILIARIO — mis pedidos activos
// ══════════════════════════════════════════════════════════════════════════════
router.get('/domi/mis-pedidos', authDomi, (req, res) => {
  const d      = req.driver;
  const p      = pool();
  const activos = (d.pedidosActivos || []).map(id => p[id]).filter(Boolean);
  res.json({ ok: true, nombre: d.nombre, activos });
});

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN — resumen del día (requiere sesión admin del sheet)
// ══════════════════════════════════════════════════════════════════════════════
router.get('/admin/resumen', authAdmin, async (req, res) => {
  try {
    const r    = await resumenDia();
    const drvs = drivers();
    res.json({
      ok: true,
      ...r,
      domiciliariosActivos: Object.values(drvs)
        .filter(d => !d.esAdmin)
        .map(d => ({
          nombre:  d.nombre,
          activos: (d.pedidosActivos || []).length,
          pedido:  d.pedidoActual,
        })),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN — todos los pedidos
// ══════════════════════════════════════════════════════════════════════════════
router.get('/admin/pedidos/:estado?', authAdmin, async (req, res) => {
  try {
    const estado  = (req.params.estado || 'ALL').toUpperCase();
    const enSheet = await getPedidos(estado).catch(() => []);
    const enMem   = Object.values(pool()).filter(p => estado === 'ALL' || p.estado === estado);
    const ids     = new Set(enMem.map(p => p.id));
    res.json({ ok: true, pedidos: [...enMem, ...enSheet.filter(p => !ids.has(p.id))] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// CALIFICACIÓN
// ══════════════════════════════════════════════════════════════════════════════
router.post('/calificacion', async (req, res) => {
  try {
    const { pedidoId, estrellas } = req.body;
    if (!pedidoId || !estrellas) return res.status(400).json({ ok: false, error: 'Faltan datos' });
    await guardarCalificacion(pedidoId, estrellas);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// POSTULACIÓN
// ══════════════════════════════════════════════════════════════════════════════
router.post('/postulante', async (req, res) => {
  try {
    const { nombre, cedula, telefono } = req.body;
    if (!nombre || !cedula || !telefono)
      return res.status(400).json({ ok: false, error: 'Faltan nombre, cedula o telefono' });

    await registrarPostulante({
      nombre, cedula, telefono,
      fotoLicencia:      'pendiente_web',
      fotoTecnomecanica: 'pendiente_web',
      fotoSeguro:        'pendiente_web',
      telegramId:        'web',
      botToken:          process.env.BOT_TOKEN || '',
    }).catch(e => console.warn('registrarPostulante:', e.message));

    if (_botRef && process.env.CANAL_DOMICILIARIOS_ID) {
      _botRef.telegram.sendMessage(
        process.env.CANAL_DOMICILIARIOS_ID,
        `🆕 <b>NUEVA POSTULACIÓN (Web)</b>\n👤 <b>${nombre}</b>\n🪪 ${cedula}\n📱 ${telefono}\n📅 ${moment().tz('America/Bogota').format('DD/MM/YYYY hh:mm A')}\n<i>⚠️ Docs pendientes — confirmar por WhatsApp</i>`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }

    res.json({ ok: true, mensaje: `Postulación registrada. Don Will te contactará pronto.` });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ══════════════════════════════════════════════════════════════════════════════
module.exports = { router, setPoolRef, setBotRef };

// ══════════════════════════════════════════════════════════════════════════════
// LEER FACTURA con Groq Vision
// Recibe imagen en base64 y devuelve el total y productos detectados
// ══════════════════════════════════════════════════════════════════════════════
router.post('/leer-factura', async (req, res) => {
  try {
    const { imagen, mimeType } = req.body;
    if (!imagen) return res.status(400).json({ ok: false, error: 'Falta la imagen' });

    const Groq = require('groq-sdk');
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    const response = await groq.chat.completions.create({
      model: 'llama-3.2-11b-vision-preview',
      max_tokens: 500,
      temperature: 0.1,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:${mimeType || 'image/jpeg'};base64,${imagen}` },
          },
          {
            type: 'text',
            text: `Eres un lector de facturas de Colombia. Extrae el TOTAL a pagar de esta factura.
Responde SOLO JSON sin markdown:
{"total": número en pesos sin puntos ni comas, "items": [{"nombre": "producto", "cantidad": 1, "precio": 0}]}
Si no encuentras el total responde: {"total": null, "items": []}`,
          },
        ],
      }],
    });

    const raw = (response.choices[0]?.message?.content || '').replace(/```json|```/g, '').trim();
    const data = JSON.parse(raw);

    res.json({
      ok: true,
      total: data.total || null,
      items: data.items || [],
    });
  } catch (e) {
    console.error('POST /leer-factura:', e.message);
    res.json({ ok: false, error: 'No pude leer la factura: ' + e.message, total: null });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// EXTRAER PRODUCTOS con Groq (texto libre → carrito estructurado)
// ══════════════════════════════════════════════════════════════════════════════
router.post('/extraer-productos', async (req, res) => {
  try {
    const { texto } = req.body;
    if (!texto) return res.status(400).json({ ok: false, error: 'Falta el texto' });

    // Reutilizar la función ya existente en groq.js
    const { extraerProductosIA } = require('../services/groq');
    const productos = await extraerProductosIA(texto);

    res.json({ ok: true, productos });
  } catch (e) {
    console.error('POST /extraer-productos:', e.message);
    // Fallback: devolver texto como un solo item
    res.json({
      ok: true,
      productos: [{ descripcion: req.body.texto, cantidad: 1, precioUnitario: 0, subtotal: 0 }],
    });
  }
});